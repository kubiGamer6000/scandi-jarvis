import { tool } from "langchain";
import { z } from "zod";

/**
 * Returns the current date/time. Models otherwise have no notion of "now".
 *
 * Defaults to `Europe/Stockholm` because that's Scandi Gum's operational
 * timezone — but always returns BOTH the local time and UTC so the agent has
 * no math to do (and no chance to mis-handle CET vs CEST / DST). It also
 * pulls offset + DST status out as their own fields so the model can quote
 * them directly instead of trying to derive them from a string.
 */
function buildLocal(now: Date, timezone: string) {
  // Numeric parts (24h clock, en-CA gives ISO-friendly YYYY-MM-DD).
  const numeric = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "long",
  }).formatToParts(now);
  const get = (t: string) => numeric.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  // en-CA emits "24" for midnight; normalise to "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  const time = `${hour}:${get("minute")}:${get("second")}`;
  const weekday = get("weekday");
  // Pretty (human-readable) form, e.g. "Tuesday, 12 May 2026 at 00:09:42".
  const pretty = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "medium",
  }).format(now);
  // Offset + DST detection via timeZoneName: "shortOffset" gives e.g. "GMT+2".
  const offsetPart = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value ?? "";
  const tzAbbrev =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      timeZoneName: "short",
    })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return { date, time, weekday, pretty, utcOffset: offsetPart, tzAbbrev };
}

export const getCurrentDatetime = tool(
  ({ timezone = "Europe/Stockholm" }: { timezone?: string }) => {
    const now = new Date();
    let local: ReturnType<typeof buildLocal>;
    try {
      local = buildLocal(now, timezone);
    } catch {
      return `Unknown timezone: "${timezone}". Use an IANA name like "UTC" or "Europe/Stockholm".`;
    }
    return JSON.stringify({
      timezone,
      local_date: local.date,
      local_time: local.time,
      local_weekday: local.weekday,
      local_pretty: local.pretty,
      utc_offset: local.utcOffset,
      tz_abbrev: local.tzAbbrev,
      iso_utc: now.toISOString(),
      unix_ms: now.getTime(),
    });
  },
  {
    name: "get_current_datetime",
    description:
      "Get the current date and time. Defaults to Europe/Stockholm (Scandi Gum's operational timezone). " +
      "Returns: local_date (YYYY-MM-DD), local_time (HH:MM:SS, 24h), local_weekday, local_pretty, " +
      "utc_offset (e.g. 'GMT+2'), tz_abbrev (e.g. 'CEST'), iso_utc, unix_ms. " +
      "ALWAYS call this fresh at the start of any turn that talks about time — never reuse a previous value, " +
      "and never compute the local time from the UTC string yourself.",
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone (e.g. 'Europe/Stockholm', 'UTC', 'America/New_York'). Defaults to Europe/Stockholm.",
        ),
    }),
  },
);
