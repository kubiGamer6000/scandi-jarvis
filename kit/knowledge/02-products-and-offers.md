# Products & Offers

> ## ⚠️ Read this before using anything on this page
>
> **None of this is authoritative.** It was reverse-engineered from analysis scripts
> written at various points in 2026, not from a product source of truth. Product IDs,
> pack tiers, prices, flavours and offer structure all change, and some of what's
> below is certainly already stale.
>
> **If the answer depends on the current catalogue, pull it live from the Shopify
> API, or ask Veli.** Do not quote an ID, price or tier from this file as fact.
>
> Treat it as orientation — "roughly how the catalogue is shaped" — and nothing more.

## Shape of the catalogue

- **Functional chewing gum** is the core product, sold in **boxes/packs**, in several
  flavours (peppermint, strawberry, watermelon, blueberry have all appeared).
- Sold mainly as a **subscription** with a multi-pack tier structure. Higher tiers
  have bundled free packs, which arrive on the order as a **separate product line** —
  so a COGS calculation that only counts the main line will understate cost.
- A **remineralizing toothpaste** is sold as a cart upsell.
- **€0 freebies** exist (a shade guide and a progress tracker). These are digital /
  non-shipping but Shopify still creates fulfilment orders for them, so an unfulfilled
  freebie makes the whole order look unfulfilled. Always separate freebie-blocked
  orders from genuinely unshipped ones when counting backlog.

## Subscription mechanics that are more durable

These come from the billing model rather than the catalogue, so they're safer:

- Billing interval is **28 days** (`WEEK` × 4) for the large majority of subs.
- A **shipping fee** applies to subscriptions holding fewer than 6 packs, introduced
  around July 2026. A `FREE_SHIPPING` discount does **not** cancel it.
- First orders are priced as an acquisition offer and **rebills step up** in price.
- Subscriptions are identified by **Shopify order tags**, not a product field:
  `Subscription First Order`, `Subscription Recurring Order`, `Subscription Order: N`.

Full detail in `05-subscriptions-and-mrr.md`, which is grounded in the charge model
source and is much more trustworthy than this file.

## Markets

Roughly 33 "MAIN" markets — Western/Central Europe, UK, Ireland, the Nordics, US,
Canada, Mexico, Australia, New Zealand — plus a long tail of secondary markets
including the Gulf states. Base currency is **EUR**; Skio bills in ~59 currencies.

## How to get the real answer

| Question | Do this |
|---|---|
| What products/variants exist right now | Shopify Admin GraphQL `products` query |
| Current prices | Shopify — variant `price` |
| What a specific order contained | Shopify order line items (bulk export for volume) |
| How many gum boxes an order held | Reuse the existing pack-counting helper rather than re-deriving it — it already handles flavours, N-packs, and excluding toothpaste/freebies |
| Current offer/tier structure | **Ask Veli.** This is not reliably derivable from the API. |
