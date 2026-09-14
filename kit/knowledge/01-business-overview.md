# Business Overview

## What Scandi Gum is

A D2C e-commerce brand selling **premium functional chewing gum**, sold almost
entirely through its own Shopify storefront on a **subscription** model. Paid ads
(mostly Meta) drive traffic; there is no meaningful retail or marketplace channel.

The product is positioned on oral-health function rather than confectionery:

| Ingredient | Claimed benefit |
|---|---|
| Nano-hydroxyapatite | Remineralizes enamel |
| Zinc complex | Neutralizes odour compounds / fresh breath |
| Xylitol | Natural sweetener, non-cariogenic, inhibits *S. mutans* |

> ⚠️ This ingredient list came from a verbal brief, not from a source file.
> Full formulation, dosages, claim wording and regulatory-safe phrasing are **not
> in this knowledge base**. Do not put any of these claims into customer-facing copy without
> having someone confirm the approved wording first — we sell across ~33 markets
> and the permitted phrasing differs by market.

Flavours: **Peppermint, Strawberry, Watermelon, Blueberry.**
There is also a **remineralizing toothpaste** sold as a cart upsell, plus low-value
freebies (Shade Guide, Progress Tracker).

## People

| Person | Role | Notes |
|---|---|---|
| **Javid** | Co-owner | "David with a J" — the Meta ad accounts are named `... PIN 1506 JAVID CC ...`, which is where the spelling comes from. Confirm. |
| Elias | Co-owner | |
| **Veli** | Head of Operations | The technical one. Writes the scripts, owns the APIs, usually the person talking to the agent. |

Plus a small number of other employees, and a creative team of **video editors** and
**creative strategists** — see `07-editor-games-and-rewards.md`.

## Legal / financial entity

- **The Kybalion AB** — Swedish entity behind the brand.
- Banking through **Revolut Business** (IBAN `LT793250064144180181`). There is no
  Revolut API integration — bank data enters analysis as **exported CSVs**.
- **Wayflyer** revenue-based financing is (or was) outstanding. Repayments arrive on
  the statement as **GoCardless** direct debits, *not* labelled "Wayflyer".
- **Juni** is a secondary card rail used to fund ad spend. This matters: for a window
  in Aug 2026, Meta charges vanished from Revolut and reappeared as Juni transfers,
  which makes naive ad-spend-from-bank analysis wrong.
- Manufacturing is paid by wire to **Hangzhou**, China.
- Firebase project name is `kybalion-pb`, another echo of the entity name.

## Tax position

**The brand does not charge or remit VAT.** This is stated explicitly and repeatedly
across the analysis scripts, and it is load-bearing: it means **gross revenue is net
revenue**, and no VAT line is subtracted anywhere in the profit model.

## The stack

| Function | Tool | API? |
|---|---|---|
| Storefront, orders, customers | **Shopify** | Yes — Admin GraphQL, primary source of truth for revenue |
| Subscriptions | **Skio** | Yes — Hasura GraphQL, source of truth for MRR/churn |
| Ad spend & attribution (blended) | **Triple Whale** | Yes |
| Ads — primary channel | **Meta / Facebook** | Yes — Marketing API. Two ad accounts. |
| Creative performance & editor bonuses | **Editor Games** (internal) | Yes — its own dashboard/API |
| Creative tracker (launch dates, Drive links) | **Google Sheet** + Drive | Yes |
| Ads — secondary | TikTok, Google | Only via Triple Whale; no direct API yet |
| Profit tracking | **Google Sheet** (`ScandiGum Progress Sheet`) + the Ultimate Scandi App | Yes — Sheets API |
| Customer support | **Chatwoot** | Yes |
| Parcel tracking | **17track** | Yes — quota-metered, be careful |
| Reviews | Loox | No integration |
| Loyalty | Smile | No integration |
| Email | Klaviyo | No integration |
| Cart upsells | AfterSell | No integration |
| Banking | Revolut, Juni | **CSV export only** |
| Financing | Wayflyer | No API — modelled from bank + Shopify |

## Operating conventions

- **Base currency is EUR.** Shopify store currency is EUR, so `shopMoney` usually
  needs no conversion. Skio bills in ~59 currencies and always needs FX.
- **Day boundaries are `Europe/Stockholm`**, not UTC. The Ultimate Scandi App sets
  this explicitly; ad-hoc scripts are less consistent, which is a known source of
  small discrepancies.
- **Subscription billing interval is 28 days** (`WEEK` × 4) for ~89.6% of the base.
  Note this is *not* a calendar month — it is the single biggest reason "MRR" is
  ambiguous here. See `05-subscriptions-and-mrr.md`.
- **Shopify order tags are how subscriptions are identified**, not a product field:
  - `Subscription First Order` — the checkout that created the subscription
  - `Subscription Recurring Order` — a rebill
  - `Subscription Order: N` — the Nth billing (checkout counts as 1)
