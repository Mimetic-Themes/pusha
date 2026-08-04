# Results — native vs Pusha on base-theme-next (2026-07-22)

Run against the live `shopify theme dev` server (`127.0.0.1:9292`) with Playwright
(Chromium). Localhost + proxy + automation makes absolute ms noisy — the
**structural** results (script re-parse count, shell-state, prerender activation,
analytics count) are the reliable signals; treat raw ms as indicative only.

## Control — unmodified theme (full-reload MPA)

| page | TTFB | FCP | DCL | scripts loaded |
|---|---|---|---|---|
| home | — | — | 623 ms | — |
| /collections/all | 405 ms | 620 ms | 532 ms | **97** |
| /products/gift-card | 360 ms | 748 ms | 562 ms | **100** (~430 KB) |

Every navigation is a fresh document: ~100 scripts re-parsed each time; all shell
state destroyed.

## Arm A — native View Transitions + Speculation Rules

- `@view-transition { navigation: auto }` **active**; Chromium supports VT + speculation rules. Smoothness: ✅.
- **Prerender did NOT activate.** `navigation.activationStart` stayed `0` after link
  clicks at both `moderate` and `immediate` eagerness. The fast repeat TTFB (9 ms)
  was HTTP disk cache, not prerender. The Shopify dev storefront's response headers
  (or the automation context) appear to make pages **prerender-ineligible**.
  ⚠ **Needs manual confirmation in a real Chrome against a real storefront** — if it
  reproduces there, native's "instant nav" story is weak *on Shopify specifically*.
- Non-prerendered nav = full document load, **100 scripts re-parsed**, + VT animation.
- Shell state destroyed (new document). Safari: no speculation rules at all (not tested here, known-absent).

**Net:** native delivered the *smoothness* but not the *instant* (prerender never fired) and by architecture cannot deliver warm-runtime or shell persistence.

## Arm B — Pusha SPA

- Init clean: `window.Pusha`, container `#main-content`, prefetch, a11y, head-sync all working.
- **Scripts re-parsed per nav: +5** (only the destination template's new modules) **vs 100** on a full reload. Head-sync loads e.g. collection→{quick-add, product-form, quantity, richtext, filter}; product→{wallets, slideshow, zoom, variant-picker, recommendations}. Runtime stays warm. ← **headline**
- Internal nav timing (cache HIT): **collection 200 ms, product 490 ms** to content-ready; title/meta/stylesheets synced each nav.
- Prefetch works (hover warmup + cache HIT). Cross-browser (no Speculation-Rules dependency).
- **Shell state PRESERVED**: opened the cart `<dialog>`, navigated — it stayed **open**, was the **same DOM node** (shell not rebuilt), and `window` state survived. Native/MPA cannot do this.

## Move 4 — analytics integrity

- On new-Liquid: `Shopify.analytics.publish` **present**; `Shopify.analytics.page` and `.subscribe` **absent**.
- Pusha's bridge fires `publish('page_viewed')` **exactly 1× per nav** — no self-double-fire.
- Pusha's `analytics.page()` call is a **no-op** here (method absent) — the classic admin-pageview channel doesn't exist on new-Liquid; Pusha's optional-chaining safely skips it.
- ⚠ **Open**: the theme's `<s-view-event view-event-trigger="connect">` re-fires a typed `PageViewEvent` through `@shopify/standard-events` (a *separate* channel) when it re-mounts on a product swap. Whether that + Pusha's `publish('page_viewed')` **double-count downstream** needs the Web Pixels sandbox / Shopify admin real-time to confirm. Recommended fix if so: on new-Liquid, Pusha's bridge defers to the theme's standard-events (PJAX-safe by construction) instead of also publishing.

## Verdict (updates the pre-experiment lean)

The pre-experiment worry was "native may make Pusha redundant on new-Liquid." The
data tilts back the other way:

- The native feature that would *replace* Pusha — instant prerendered nav — **did not
  fire against the Shopify storefront** (prerender-ineligible; needs manual re-check).
- The core SPA properties — **warm runtime (5 vs 100 scripts) and preserved shell
  state** — are **Pusha-only by architecture**; native cannot provide them at all.

So on this new-Liquid theme Pusha is **additive, not redundant**. Caveats before any
claim: (1) confirm the prerender-ineligibility in real Chrome — if prerender *does*
work on real storefronts, native's instant-nav case strengthens (though warm-runtime
+ shell-state still favor Pusha); (2) fix the analytics channel for new-Liquid
(standard-events), and verify no downstream double-count; (3) the dual-swap
coordination (Pusha swap vs `s-cart` `partials.apply()`) was not stress-tested.

## Not covered (needs manual / real-device)

- Safari (no automation here): native has no prefetch there; Pusha's prefetch works — expected to widen the gap.
- Subjective "feel" of the VT animation vs Pusha's fade.
- Web Pixels sandbox counts for the analytics double-count question.
