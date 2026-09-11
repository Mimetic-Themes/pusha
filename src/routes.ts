// Routes Shopify owns that must never go through PJAX or prefetch.
// Shared by runtime.ts (link interception) and prefetch.ts (hover + warmup) so
// both paths agree on what's off-limits. `/cart` is INCLUDED in PJAX — it's a
// regular themed page — but is opted out of nav-link warmup separately, since
// it's stateful and warming it is wasteful.
//
// Anything matching this regex:
//   - has off-domain redirects (cross-origin CORS preflights will fail in
//     prefetch — see /customer_authentication/redirect → shopify.com)
//   - requires full reload to re-evaluate session state (auth transitions,
//     locale switch)
//   - is opaque to themes (app proxy /a/*)
//   - is fully Shopify-managed and not theme-routed (/checkouts)
//   - mutates server state on a GET (/cart/add, /cart/change, /cart/clear,
//     cart permalinks like /cart/40000001:1, and /discount/CODE). Intercepting
//     these performs the mutation via fetch, records the mutating URL in
//     history, and performs it AGAIN on Back/Forward. The bare /cart page is
//     not affected — it stays in PJAX, because it only reads state.
export const SHOPIFY_RESERVED =
  /^\/(checkouts?|cart\/(?:add|change|update|clear|\d)|discount\/|account\/(?:login|register|logout|recover|activate)|customer_authentication\/|password|localization|gift_cards?|a\/)/;
