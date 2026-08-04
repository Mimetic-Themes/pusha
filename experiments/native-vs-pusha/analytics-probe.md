# Move 4 — analytics integrity probe (new-Liquid + Pusha)

Verify Pusha's analytics bridge does not under-count or double-count on a
new-Liquid theme *before* making any Pusha-on-new-Liquid claim. This is separate
from the perf experiment — run it on Arm B (Pusha), and once on a plain
unmodified theme as the control.

## The mismatch being tested

- Pusha's bridge (`src/analytics.ts`) fires **`Shopify.analytics.page()`** +
  **`Shopify.analytics.publish('page_viewed', …)`** on every swap.
- base-theme-next reports page views via **`@shopify/standard-events`**
  (`PageViewEvent`), and `page-view-event.js` notes SPA nav was removed (#702),
  so its per-nav view-firing assumes full reloads.
- `<s-view-event view-event-trigger="connect">` re-fires `product_viewed` /
  `page_viewed` on `connectedCallback` — which **already** fires on PJAX swap
  when the element re-mounts.

The risk: the `connect`-triggered element **and** Pusha's bridge both fire on the
same swap → **double count**; or standard-events doesn't forward to the channel
Pusha uses → **under count**.

## Procedure

1. Open the storefront with **Web Pixels debugging**: DevTools console +
   Shopify admin → Analytics → Live view (or the Customer Events sandbox).
2. Add a `PerformanceObserver`/console tap:
   ```js
   const seen = [];
   window.Shopify?.analytics?.subscribe?.('page_viewed', e => { seen.push(e); console.log('[probe] page_viewed', seen.length, location.pathname); });
   // also watch standard-events if exposed:
   document.addEventListener('shopify:analytics:page_viewed', e => console.log('[probe] std page_viewed', location.pathname));
   ```
3. Walk `index → collection → product → cart → back`. Record **exactly how many
   `page_viewed` events fire per navigation** in each channel.

## Pass / fail

| Result | Meaning | Action |
|---|---|---|
| Exactly 1 `page_viewed` per nav, in the channel admin reads | Bridge is correct on this theme | ship as-is |
| 2 per nav | Pusha bridge + `connect` element both fire | bridge must detect standard-events elements and defer to them |
| 0 in admin's channel | Pusha fires a channel admin doesn't read | bridge needs a `@shopify/standard-events` path (payload shape is in `page-view-event.js`) |

Log counts per nav per channel into `results.md`.
