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
export const SHOPIFY_RESERVED =
  /^\/(checkouts?|account\/(?:login|register|logout|recover|activate)|customer_authentication\/|password|localization|gift_cards?|a\/)/;
