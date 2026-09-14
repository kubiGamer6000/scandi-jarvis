import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Kind, parse, type OperationDefinitionNode } from "graphql";

import { env, hasCredential } from "../core/env.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("integrations/kit-gateway");

/**
 * Credential gateway for the Scandi data APIs.
 *
 * Sandboxed code (the kit scripts under /home/app/kit and anything the agent
 * writes) never holds an API key. It calls this localhost server with a
 * per-process token, and the gateway attaches the real credentials:
 *
 *   GET  /profit/<path>                → PROFIT_API_BASE/api/<path>
 *   POST /shopify/graphql              → Shopify Admin GraphQL (token exchange cached here)
 *   POST /skio/graphql                 → Skio Hasura GraphQL
 *   GET  /meta/<version>/<path>        → graph.facebook.com
 *   POST /triplewhale/summary-page/get-data → Triple Whale summary
 *
 * Writes are refused unless JARVIS_KIT_ALLOW_WRITES=true: GraphQL documents
 * may only contain queries (plus Shopify's read-only bulk export mutation),
 * and REST calls must be GETs. Upstream status, body and rate-limit headers
 * pass through unchanged so the kit clients' retry and pacing logic keeps
 * working.
 *
 * The sandbox shares the host network namespace, so it reaches 127.0.0.1.
 */

const UPSTREAM_TIMEOUT_MS = 150_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Upstream response headers the kit clients read (throttle state, paging). */
const PASS_HEADERS = [
  "content-type",
  "retry-after",
  "x-fb-ads-insights-throttle",
  "x-business-use-case-usage",
  "x-app-usage",
  "x-shopify-shop-api-call-limit",
];

type Service = "profit" | "shopify" | "skio" | "meta" | "triplewhale";

function configuredServices(): Service[] {
  const out: Service[] = [];
  if (hasCredential("PROFIT_API_BASE") && hasCredential("PROFIT_API_KEY")) out.push("profit");
  if (
    hasCredential("SHOPIFY_STORE_DOMAIN") &&
    hasCredential("SHOPIFY_CLIENT_ID") &&
    hasCredential("SHOPIFY_CLIENT_SECRET")
  ) {
    out.push("shopify");
  }
  if (hasCredential("SKIO_API_KEY")) out.push("skio");
  if (hasCredential("META_APP_TOKEN")) out.push("meta");
  if (hasCredential("TRIPLEWHALE_API_KEY") && hasCredential("SHOPIFY_STORE_DOMAIN")) {
    out.push("triplewhale");
  }
  return out;
}

export interface KitGateway {
  url: string;
  /** Environment for sandboxed processes: gateway address + non-secret config. */
  sandboxEnv: Record<string, string>;
  close(): Promise<void>;
}

let gatewayPromise: Promise<KitGateway | null> | null = null;

/**
 * Start the gateway once per process. Resolves to `null` when no Scandi API
 * is configured (or the port can't be bound) — the sandbox then simply has no
 * kit access.
 */
export function startKitGateway(): Promise<KitGateway | null> {
  if (!gatewayPromise) {
    gatewayPromise = launch().catch((err) => {
      log.error("Kit gateway failed to start", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
  }
  return gatewayPromise;
}

export async function stopKitGateway(): Promise<void> {
  const pending = gatewayPromise;
  gatewayPromise = null;
  const gateway = await pending?.catch(() => null);
  await gateway?.close();
}

async function launch(): Promise<KitGateway | null> {
  const services = configuredServices();
  if (services.length === 0) {
    log.info("No Scandi API credentials configured – kit gateway not started");
    return null;
  }

  const token = randomBytes(32).toString("hex");
  const tokenBuf = Buffer.from(token);

  const server = createServer((req, res) => {
    void handle(req, res, tokenBuf, services).catch((err) => {
      log.error("gateway handler crashed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) sendJson(res, 500, { error: "gateway error" });
      else res.end();
    });
  });
  server.requestTimeout = UPSTREAM_TIMEOUT_MS + 10_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  log.info("Kit gateway listening", {
    url,
    services,
    writes: env.JARVIS_KIT_ALLOW_WRITES === "true" ? "allowed" : "refused",
  });

  return {
    url,
    sandboxEnv: {
      KIT_GATEWAY_URL: url,
      KIT_GATEWAY_TOKEN: token,
      KIT_SERVICES: services.join(","),
      SHOPIFY_STORE_DOMAIN: env.SHOPIFY_STORE_DOMAIN ?? "",
      SHOPIFY_API_VERSION: env.SHOPIFY_API_VERSION,
      META_API_VERSION: env.META_API_VERSION,
      META_AD_ACCOUNT_IDS: env.META_AD_ACCOUNT_IDS,
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: Buffer,
  services: Service[],
): Promise<void> {
  const provided = Buffer.from(String(req.headers["x-kit-token"] ?? ""));
  if (provided.length !== token.length || !timingSafeEqual(provided, token)) {
    sendJson(res, 401, { error: "missing or invalid x-kit-token" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://gateway");
  const [, service, ...restParts] = url.pathname.split("/");
  const rest = restParts.join("/");
  const method = (req.method ?? "GET").toUpperCase();
  const allowWrites = env.JARVIS_KIT_ALLOW_WRITES === "true";

  if (!services.includes(service as Service)) {
    sendJson(res, 503, {
      error: `service "${service}" is not configured on this Jarvis (available: ${services.join(", ") || "none"})`,
    });
    return;
  }

  const t0 = Date.now();
  const body = method === "GET" || method === "HEAD" ? "" : await readBody(req);
  let upstream: Response;

  switch (service as Service) {
    case "profit": {
      if (method !== "GET" && !allowWrites) return refuse(res, "the Profit API is read-only here (GET only)");
      upstream = await fetchUpstream(
        `${env.PROFIT_API_BASE!.replace(/\/$/, "")}/api/${rest}${url.search}`,
        { method, headers: { Authorization: `Bearer ${env.PROFIT_API_KEY}` }, ...(body ? { body } : {}) },
      );
      break;
    }

    case "shopify": {
      if (rest !== "graphql" || method !== "POST") {
        return sendJson(res, 404, { error: "use POST /shopify/graphql" });
      }
      const denied = allowWrites ? null : checkReadOnlyGraphql(body, SHOPIFY_READONLY_MUTATIONS);
      if (denied) return refuse(res, denied);
      let accessToken: string;
      try {
        accessToken = await shopifyToken();
      } catch (err) {
        // A 401 (not 5xx) so the kit client reports it instead of retrying.
        return sendJson(res, 401, { error: err instanceof Error ? err.message : String(err) });
      }
      upstream = await fetchUpstream(
        `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body,
        },
      );
      if (upstream.status === 401) shopifyAccess = null; // token revoked/expired early
      break;
    }

    case "skio": {
      if (rest !== "graphql" || method !== "POST") {
        return sendJson(res, 404, { error: "use POST /skio/graphql" });
      }
      const denied = allowWrites ? null : checkReadOnlyGraphql(body, new Set());
      if (denied) return refuse(res, denied);
      upstream = await fetchUpstream("https://graphql.skio.com/v1/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `API ${env.SKIO_API_KEY}` },
        body,
      });
      break;
    }

    case "meta": {
      if (method !== "GET" && !allowWrites) return refuse(res, "Meta is read-only here (GET only)");
      const target = new URL(`https://graph.facebook.com/${rest}${url.search}`);
      target.searchParams.delete("access_token");
      upstream = await fetchUpstream(target.toString(), {
        method,
        headers: { Authorization: `Bearer ${env.META_APP_TOKEN}` },
        ...(body ? { body } : {}),
      });
      break;
    }

    case "triplewhale": {
      if (rest !== "summary-page/get-data" || method !== "POST") {
        return sendJson(res, 404, { error: "only POST /triplewhale/summary-page/get-data is exposed" });
      }
      upstream = await fetchUpstream("https://api.triplewhale.com/api/v2/summary-page/get-data", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.TRIPLEWHALE_API_KEY! },
        body,
      });
      break;
    }
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  res.end(buf);

  log.info("kit call", {
    service,
    path: service === "profit" || service === "meta" ? `/${rest}` : undefined,
    op: service === "shopify" || service === "skio" ? operationSummary(body) : undefined,
    status: upstream.status,
    bytes: buf.byteLength,
    ms: Date.now() - t0,
  });
}

function refuse(res: ServerResponse, reason: string): void {
  log.warn("kit write refused", { reason });
  sendJson(res, 403, {
    error: `${reason}. Jarvis's data access is read-only; ask a human to make changes.`,
  });
}

async function fetchUpstream(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (err) {
    // Surface network failures as a 502 the kit's retry predicates understand.
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `upstream request failed: ${message}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// read-only GraphQL enforcement
// ---------------------------------------------------------------------------

/** Shopify mutations that only read (bulk export of a query). */
const SHOPIFY_READONLY_MUTATIONS = new Set(["bulkOperationRunQuery"]);

/**
 * Returns a refusal reason, or null when the document only reads. Parses the
 * document properly — string matching on "mutation" is trivially bypassed.
 */
export function checkReadOnlyGraphql(
  rawBody: string,
  allowedMutationFields: ReadonlySet<string>,
): string | null {
  let query: unknown;
  try {
    query = (JSON.parse(rawBody) as { query?: unknown }).query;
  } catch {
    return "request body must be JSON with a `query` field";
  }
  if (typeof query !== "string") return "request body must include a `query` string";

  let doc;
  try {
    doc = parse(query);
  } catch (err) {
    // Refuse what we can't parse: forwarding it would let a document our
    // parser misreads slip a mutation past this check.
    return `GraphQL did not parse: ${err instanceof Error ? err.message : String(err)}`;
  }

  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    const op = def as OperationDefinitionNode;
    if (op.operation === "query") continue;
    if (op.operation === "subscription") return "GraphQL subscriptions are not allowed";
    const fields = op.selectionSet.selections.map((s) =>
      s.kind === Kind.FIELD ? s.name.value : "<fragment>",
    );
    const disallowed = fields.filter((f) => !allowedMutationFields.has(f));
    if (disallowed.length > 0) {
      return `GraphQL mutations are not allowed (${disallowed.join(", ")})`;
    }
  }
  return null;
}

function operationSummary(rawBody: string): string | undefined {
  try {
    const query = (JSON.parse(rawBody) as { query?: string }).query ?? "";
    const doc = parse(query);
    const op = doc.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION) as
      | OperationDefinitionNode
      | undefined;
    if (!op) return undefined;
    const fields = op.selectionSet.selections
      .map((s) => (s.kind === Kind.FIELD ? s.name.value : "…"))
      .join(",");
    return `${op.operation} ${op.name?.value ?? ""}{${fields}}`.slice(0, 120);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shopify OAuth client_credentials token
// ---------------------------------------------------------------------------

let shopifyAccess: { token: string; expiresAt: number } | null = null;
let shopifyTokenInflight: Promise<string> | null = null;

async function shopifyToken(): Promise<string> {
  if (shopifyAccess && Date.now() < shopifyAccess.expiresAt) return shopifyAccess.token;
  if (!shopifyTokenInflight) {
    shopifyTokenInflight = (async () => {
      let lastError: unknown;
      // Retried: it runs first in every pull, so one dropped connection here
      // used to kill whole syncs (see the kit's shopify.ts).
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const res = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: env.SHOPIFY_CLIENT_ID!,
              client_secret: env.SHOPIFY_CLIENT_SECRET!,
            }).toString(),
            signal: AbortSignal.timeout(30_000),
          });
          const text = await res.text();
          if (!res.ok) {
            const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1];
            const error = new Error(`HTTP ${res.status}: ${title ?? text.slice(0, 200)}`);
            // Bad credentials won't fix themselves; only retry server errors.
            if (res.status < 500) throw Object.assign(error, { permanent: true });
            throw error;
          }
          const json = JSON.parse(text) as { access_token: string; expires_in: number };
          // An hour of headroom, as in the kit.
          shopifyAccess = {
            token: json.access_token,
            expiresAt: Date.now() + json.expires_in * 1000 - 3_600_000,
          };
          return json.access_token;
        } catch (err) {
          lastError = err;
          if ((err as { permanent?: boolean }).permanent) break;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        }
      }
      throw new Error(
        `Shopify token exchange failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    })().finally(() => {
      shopifyTokenInflight = null;
    });
  }
  return shopifyTokenInflight;
}
