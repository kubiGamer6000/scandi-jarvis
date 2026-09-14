# Triple Whale API

Used for **blended ad spend across channels** — specifically Google and TikTok, which
have no direct integration. Also pixel session data.

| | |
|---|---|
| Base | `https://api.triplewhale.com/api/v2` |
| Auth | handled by the credential gateway (`/home/app/kit/lib/triplewhale.ts`) — no key in the sandbox |
| Timeout | 120s per request, 4 attempts |

## Summary Page endpoint

```typescript
POST /summary-page/get-data
{
  shopDomain: store.shopifyDomain,        // NOT "shop"
  period: { start, end },                 // NOT startDate/endDate
  todayHour: new Date().getHours() + 1,   // base-1, not base-0
}
```

> ⚠️ Three parameter-naming traps in one request. `shopDomain` not `shop`, `period`
> not `startDate`/`endDate`, and `todayHour` is **1-indexed**. These were found by
> trial and error and are not obvious from the docs.

## Metric IDs

The response is keyed by metric ID:

```typescript
googleSpend:        'googleAds'
tiktokSpend:        'tiktokAds'
facebookSpend:      'facebookAds'
pixelVisitSessions: 'pixelVisitSessions'
tiktokImpressions:  'tiktokImpressions'
```

The full metric blob is stored in `triplewhale_daily.raw` so new metrics can be
mapped later without re-pulling.

## Where it sits in precedence

For **Facebook**, Triple Whale is the *last* resort:

```
sheet (on/before 2026-07-28)  >  Meta API  >  Triple Whale
```

For **Google and TikTok**, Triple Whale is currently the only source.

Early Triple Whale data is known to be unreliable, which is part of why the sheet
wins for dates on or before the handover date of `2026-07-28`.

## Caveats

- Triple Whale is an **attribution** tool. Its revenue and ROAS figures use its own
  pixel-based attribution model and will not match Shopify. **Use Shopify for
  revenue, Triple Whale for spend.**
- `triplewhaleUnresolved` on `GET /api/ads` flags spend Triple Whale reports that
  couldn't be matched to a known account.
- An hourly variant is synced for intraday shape
  (`triplewhale_hourly`, includes `facebook_spend`).
