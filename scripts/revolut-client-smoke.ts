/**
 * Pure-logic strength test for the Revolut expenses client helpers.
 * No live API required.
 *
 *   npx tsx scripts/revolut-client-smoke.ts
 */
import {
  normalizeReportDate,
  normalizeReportParams,
  parseContentDispositionFilename,
  RevolutExpensesValidationError,
} from "../src/tools/revolut/client.js";

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failed += 1;
    console.error(`  FAIL  ${msg}`);
  }
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

section("normalizeReportDate");
assert(normalizeReportDate("2026-06-30", "from") === "2026-06-30", "ISO passthrough");
assert(normalizeReportDate("30/06/2026", "from") === "2026-06-30", "EU → ISO");
assert(normalizeReportDate("30.06.2026", "from") === "2026-06-30", "EU dots");
assert(normalizeReportDate("30-06-2026", "from") === "2026-06-30", "EU dashes");
assert(normalizeReportDate("1/2/2026", "from") === "2026-02-01", "unpadded EU");
try {
  normalizeReportDate("32/13/2026", "from");
  assert(false, "invalid calendar day should throw");
} catch (err) {
  assert(err instanceof RevolutExpensesValidationError, "invalid day → ValidationError");
}
try {
  normalizeReportDate("not-a-date", "from");
  assert(false, "garbage should throw");
} catch (err) {
  assert(err instanceof RevolutExpensesValidationError, "garbage → ValidationError");
}
try {
  normalizeReportDate("  ", "from");
  assert(false, "blank should throw");
} catch (err) {
  assert(err instanceof RevolutExpensesValidationError, "blank → ValidationError");
}

section("normalizeReportParams");
const range = normalizeReportParams({
  period: "range",
  from: "30/06/2026",
  to: "29/07/2026",
  format: "html",
  smart: true,
});
assert(range.from === "2026-06-30", "range.from normalised");
assert(range.to === "2026-07-29", "range.to normalised");
assert(range.smart === true && range.format === "html", "html+smart kept");

const on = normalizeReportParams({ period: "on", date: "2026-07-01", format: "json" });
assert(on.date === "2026-07-01", "on.date kept");

try {
  normalizeReportParams({ period: "range", format: "html", smart: true });
  assert(false, "range without from should throw");
} catch (err) {
  assert(err instanceof RevolutExpensesValidationError, "missing from → ValidationError");
}
try {
  normalizeReportParams({ period: "on", format: "json" });
  assert(false, "on without date should throw");
} catch (err) {
  assert(err instanceof RevolutExpensesValidationError, "missing date → ValidationError");
}
try {
  normalizeReportParams({
    period: "range",
    from: "2026-07-29",
    to: "2026-06-30",
  });
  assert(false, "inverted range should throw");
} catch (err) {
  assert(err instanceof RevolutExpensesValidationError, "inverted range → ValidationError");
}
try {
  normalizeReportParams({ period: "yesterday", format: "html", smart: false });
  assert(false, "html without smart should throw");
} catch (err) {
  assert(err instanceof RevolutExpensesValidationError, "html requires smart");
}
try {
  normalizeReportParams({ period: "today", currency: "euro" });
  assert(false, "bad currency should throw");
} catch (err) {
  assert(err instanceof RevolutExpensesValidationError, "bad currency → ValidationError");
}
const ccy = normalizeReportParams({ period: "today", currency: " sek " });
assert(ccy.currency === "SEK", "currency trimmed + uppercased");

section("parseContentDispositionFilename");
assert(
  parseContentDispositionFilename('inline; filename="revolut-2026-06-30.html"') ===
    "revolut-2026-06-30.html",
  "simple filename=",
);
assert(
  parseContentDispositionFilename(
    "attachment; filename=\"rapport_-_depenses.html\"; filename*=UTF-8''rapport%20%E2%80%94%20d%C3%A9penses.html",
  ) === "rapport — dépenses.html",
  "prefers filename*",
);
assert(parseContentDispositionFilename(null) === null, "null → null");
assert(parseContentDispositionFilename("inline") === null, "no filename → null");

section("Headers regression guard (client never sends Unicode in query)");
const q = normalizeReportParams({
  period: "range",
  from: "2026-06-30",
  to: "2026-07-29",
  format: "html",
  smart: true,
});
const query = [q.period, q.from, q.to, q.format, String(q.smart)].join("&");
assert(!/[^\x20-\x7E]/.test(query), "normalised query is ASCII-only");

console.log(`\n=== Summary ===\n${failed === 0 ? "all good." : `${failed} failure(s)`}`);
process.exit(failed === 0 ? 0 : 1);
