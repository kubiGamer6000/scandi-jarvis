---
name: scandi-knowledge
description: Index of Scandi Gum's business knowledge base — what the company sells, people and entity, products and offers, markets, how each metric is defined, the True Profit model, the 28-day subscription charge model and the four MRR framings, churn and dunning, creative and ad naming structure (concept, hook variant, editor), Editor Games leaderboard and editor rewards, known analysis pitfalls, and other systems such as 17track, FX, Google Sheets and Chatwoot. Use when a question needs business context or a definition rather than a live number, when unsure how a metric or framing is defined, before interpreting or reporting any analysis, or when the user asks how something works at Scandi Gum.
---

# Scandi knowledge base

Business facts ("what is true") live in `/home/app/kit/knowledge/`. The other
skills say how to pull numbers; these files say what the numbers mean. Read the
file that matches the question — don't guess from memory.

**Read `/home/app/kit/knowledge/08-pitfalls.md` before any analysis.** It lists
mistakes that were actually made here and then corrected.

| File | Read it when |
|---|---|
| `/home/app/kit/knowledge/01-business-overview.md` | What Scandi Gum is, who the people are, legal entity, tax/VAT position, the tool stack, operating conventions (EUR, Europe/Stockholm, no VAT) |
| `/home/app/kit/knowledge/02-products-and-offers.md` | Products, tiers, offers, markets. **Not authoritative** — product IDs, tiers and COGS may be stale; verify against Shopify or ask |
| `/home/app/kit/knowledge/03-metrics-dictionary.md` | How a metric is defined: revenue, order counts, AOV, ad spend, ROAS/CPA/CVR, cost rates, subscription metrics, unit economics, retention |
| `/home/app/kit/knowledge/04-profit-model.md` | True Profit formula and inputs, what it excludes (it is contribution margin, not net profit), sheet vs app, profit excluding subs, projected subscription profit |
| `/home/app/kit/knowledge/05-subscriptions-and-mrr.md` | The Skio rebill charge model, the four MRR framings, billing schedules, the FX silent-zero trap, the MRR movement bridge, churn, cancellations, dunning |
| `/home/app/kit/knowledge/06-creative-and-ad-structure.md` | Creative vocabulary (concept, hook variant, iteration, editor), naming conventions and parser, the two Meta ad accounts, joining ads to the creative tracker, dedup |
| `/home/app/kit/knowledge/07-editor-games-and-rewards.md` | The Editor Games dashboard: creative metrics, editor roster, bonus pool, ranking metric, strategists, spotting new winners, contests |
| `/home/app/kit/knowledge/08-pitfalls.md` | Before any analysis — every way these numbers have been gotten wrong (profit/COGS, ad spend, MRR, Shopify, Skio, 17track, creatives, ratios) |
| `/home/app/kit/knowledge/09-other-apis.md` | 17track, FX providers, the Google profit sheet, Chatwoot, Revolut/Juni CSVs, Firebase — reference only; Jarvis has no clients for most of these |

For live numbers, use `scandi-profit-api` first, then `scandi-shopify`,
`scandi-skio` or `scandi-meta-ads` for record-level detail.

Not in this knowledge base: approved ingredient/health-claim wording, brand voice
beyond the visual kit (`scandi-brand`), customer personas. Don't invent them.
