/**
 * Smoke test for the Scandi kit gateway + the sandbox kit clients (kit/lib).
 *
 * Starts the gateway in-process, points the kit clients at it the same way the
 * sandbox does, and runs one cheap read against every configured service. Then
 * checks the gateway refuses writes and bad tokens.
 *
 * Needs the Scandi API credentials in .env (SHOPIFY_*, SKIO_API_KEY,
 * META_APP_TOKEN, PROFIT_API_*, TRIPLEWHALE_API_KEY). Read-only; no LLM calls.
 *
 *   npm run smoke:kit
 */
import path from "node:path";

import { startKitGateway, stopKitGateway } from "../src/integrations/kit-gateway.js";

let failures = 0;
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`✅ ${name} (${Date.now() - t0}ms) ${detail}`);
  } catch (err) {
    failures++;
    console.log(`❌ ${name}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
  }
}

async function main(): Promise<void> {
  const gateway = await startKitGateway();
  if (!gateway) {
    console.error("Gateway did not start – no Scandi API credentials configured?");
    process.exit(1);
  }
  Object.assign(process.env, gateway.sandboxEnv, {
    KIT_HOME: path.resolve(".sandbox-kit-smoke"),
  });
  const services = gateway.sandboxEnv.KIT_SERVICES!.split(",");
  console.log(`gateway ${gateway.url} · services: ${services.join(", ")}\n`);

  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const post = (service: string, body: unknown, token = gateway.sandboxEnv.KIT_GATEWAY_TOKEN!) =>
    fetch(`${gateway.url}/${service}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kit-token": token },
      body: JSON.stringify(body),
    });

  if (services.includes("profit")) {
    const profit = await import("../kit/lib/profitApi.ts");
    await check("profit: sync status", async () => `${JSON.stringify(await profit.syncStatus()).slice(0, 120)}…`);
    await check("profit: 7-day summary", async () => {
      const s = await profit.summary({ days: 7 });
      return `revenue €${Math.round(s.revenue.totalEur)} · ${profit.cogsQualityNote(s.profit).slice(0, 80)}`;
    });
  }

  if (services.includes("shopify")) {
    const shopify = await import("../kit/lib/shopify.ts");
    await check("shopify: GraphQL shop", async () => {
      const d = await shopify.graphql<{ shop: { name: string; currencyCode: string } }>("{ shop { name currencyCode } }");
      return `${d.shop.name} (${d.shop.currencyCode})`;
    });
    await check("shopify: ShopifyQL yesterday", async () => {
      const t = await shopify.shopifyQl(`FROM sales SHOW total_sales, orders SINCE ${yesterday} UNTIL ${yesterday}`);
      return JSON.stringify(shopify.rowsToObjects(t));
    });
    await check("shopify: mutation refused", async () => {
      const res = await post("shopify", { query: 'mutation { tagsAdd(id: "gid://shopify/Order/1", tags: ["x"]) { userErrors { message } } }' });
      if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`);
      return (await res.text()).slice(0, 90);
    });
    await check("shopify: aliased/obfuscated mutation refused", async () => {
      const res = await post("shopify", { query: "query A { shop { name } }\nmutation B { productDelete(input: {id: \"x\"}) { deletedProductId } }", operationName: "B" });
      if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`);
      return "403";
    });
  }

  if (services.includes("skio")) {
    const skio = await import("../kit/lib/skio.ts");
    await check("skio: introspect", async () => {
      const d = await skio.skioGql<{ __schema: { queryType: { fields: unknown[] } } }>("{ __schema { queryType { fields { name } } } }");
      return `${d.__schema.queryType.fields.length} root fields`;
    });
    await check("skio: one subscription", async () => {
      const d = await skio.skioGql<{ Subscriptions: Array<{ status: string }> }>("{ Subscriptions(limit: 1, order_by: {updatedAt: desc}) { status updatedAt } }");
      return JSON.stringify(d.Subscriptions);
    });
    await check("skio: mutation refused", async () => {
      const res = await post("skio", { query: 'mutation { cancelSubscription(input: {subscriptionId: "x"}) { ok } }' });
      if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`);
      return "403";
    });
  }

  if (services.includes("meta")) {
    const meta = await import("../kit/lib/meta.ts");
    const { metaAdAccountIds } = await import("../kit/lib/env.ts");
    await check("meta: account insights yesterday", async () => {
      const rows = await meta.accountInsights(yesterday, yesterday, metaAdAccountIds());
      return `${rows.length} rows · spend ${rows.map((r) => r.spend).join(", ")}`;
    });
    await check("meta: POST refused", async () => {
      const res = await fetch(`${gateway.url}/meta/v25.0/me`, {
        method: "POST",
        headers: { "x-kit-token": gateway.sandboxEnv.KIT_GATEWAY_TOKEN! },
      });
      if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`);
      return "403";
    });
  }

  if (services.includes("triplewhale")) {
    const tw = await import("../kit/lib/triplewhale.ts");
    await check("triple whale: yesterday's spend", async () => {
      return JSON.stringify(tw.spendByPlatform(await tw.summaryPage(yesterday, yesterday)));
    });
  }

  await check("bad token rejected", async () => {
    const res = await post("skio", { query: "{ __typename }" }, "nope");
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
    return "401";
  });

  await stopKitGateway();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await stopKitGateway().catch(() => undefined);
  process.exit(1);
});
