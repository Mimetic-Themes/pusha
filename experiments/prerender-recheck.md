# Prerender recheck — does Speculation Rules prerender work on Shopify?

**Status: RESOLVED 2026-08-05.** Yes. Measured on a production Shopify storefront
in hand-driven Chrome: `activationStart` **3341.2 ms**.

This closes the ⚠ open since 2026-07-22 at `native-vs-pusha/results.md:26`, which
recorded "prerender did NOT activate" and flagged it as needing manual
confirmation. That finding was an artifact of the test rig, not the platform.

---

## What the July run concluded, and why it was wrong

Arm A of `native-vs-pusha` ran Playwright/Chromium against `shopify theme dev`
on `127.0.0.1:9292`. `navigation.activationStart` stayed `0` at both `moderate`
and `immediate` eagerness. Two hypotheses were recorded and neither could be
separated by that rig:

1. Shopify's response headers make storefront pages prerender-ineligible.
2. The automation context suppresses prerendering.

**Hypothesis 1 is falsified.** A Shopify-served storefront document carries no
`Cache-Control` header at all — checked on allbirds.com, identified as
Shopify-hosted by its `_shopify_y` / `_shopify_essential` / `cart_currency`
cookies. `Cache-Control: no-store` is the usual disqualifier and Shopify's edge
does not send it.

Hypothesis 2 stands unrefuted by elimination. The dev server is the other
candidate; neither was isolated, and it no longer matters for the decision.

---

## The measurement

Venue: **allbirds.com**, production Shopify, real Chrome, driven by hand.
Deliberately not a Mimetic store — see the Pusha trap below.

```js
// 1. Pick a real same-origin link that exists on this page.
const href = [...document.links]
  .map(a => a.href)
  .find(h => new URL(h).origin === location.origin
             && !/\/(cart|checkout|account)/.test(h)
             && h !== location.href);

// 2. Inject the rule. Chrome honours speculation rules added at runtime.
const s = document.createElement('script');
s.type = 'speculationrules';
s.textContent = JSON.stringify({ prerender: [{ urls: [href], eagerness: 'immediate' }] });
document.head.append(s);

// 3. Click that exact link. Then, ON THE DESTINATION PAGE:
performance.getEntriesByType('navigation')[0].activationStart;
// → 3341.1999999284744
```

`activationStart` is the time the prerender began, relative to the activated
document's timeline. 3341 ms means the document had a 3.3-second head start: it
was fully fetched, parsed, and executing before the click. The click cost
approximately nothing.

⚠ **3341 ms is not a speed measurement.** It is how long the operator waited
before clicking. It proves activation happened; it does not quantify the win.
For that, compare `responseEnd` and `domContentLoadedEventEnd` against
`activationStart` on the same entry — on an activated prerender both land
*before* activation, i.e. the work was already done. The control numbers to beat
are in `native-vs-pusha/results.md`: DCL 532–562 ms on full reloads.

---

## Three traps that produce a false negative

Each of these was hit during this run. All three yield `activationStart: 0` for
reasons that have nothing to do with the platform.

### 1. Reading `activationStart` on the wrong document

It is a property of the **activated destination**, not the referrer. Injecting
rules and reading the value in the same console session, without navigating,
always returns `0` — the current document was never prerendered. Navigate
first, then read on the new page.

### 2. ★ Pusha and prerender are mutually exclusive

On a Pusha theme, activation **cannot happen** on any intercepted link. Pusha
calls `preventDefault()` and swaps the container; no document navigation occurs,
so the prerendered document is never activated and eventually expires.
`performance.getEntriesByType('navigation')[0]` still describes the original
page load, so the value stays `0` however many times you click.

This is why the first attempt on `mimetic-speed.myshopify.com` could not work:
that store runs pusha-dawn. Arm A must be tested on a theme with no Pusha —
which is what `arm-native/README.md` step 3 already required.

**Product consequence, independent of the speed question: do not ship
Speculation Rules on a Pusha theme.** Every prerender for an intercepted link is
a full document fetch, parse, and script execution — on the visitor's bandwidth
and the origin's capacity — for a document that can never be used. Pusha's own
prefetch already covers this at a fraction of the cost, since it caches markup
rather than instantiating a document. A rule set that excluded every
Pusha-intercepted link would match almost nothing.

### 3. Prefetch is not prerender

Chrome falls back to **prefetch** when it cannot prerender. The Speculative
loads panel then reports the page as "successfully prefetched", which reads like
success. It is a different action: prefetch caches the response, the navigation
still builds a fresh document, and `activationStart` is `0` — **correctly**, not
erroneously.

This happened here because the injected URL (`/collections/all`) was not a real
route on the target site. A redirect cancels a prerender while still letting a
prefetch succeed. Always derive the URL from `document.links` on the page you
are on, and click that exact link.

Check the **Action** column in DevTools → Application → Speculative loads to tell
the two apart. Do not infer from the word "success" alone.

---

## What this means for Pusha's positioning

Native View Transitions plus Speculation Rules delivers smooth **and** genuinely
instant navigation on Chromium, against real Shopify infrastructure, at zero
runtime cost. **Pusha cannot win on perceived latency there.** The `results.md`
Arm A verdict — "native delivered the smoothness but not the instant" — is
withdrawn.

What survives is what Arm B measured and native cannot do by architecture:

- **Warm runtime** — 5 scripts re-parsed per navigation vs ~100. A prerendered
  document is still a fresh document paying full script cost; it pays it early,
  not never. Prerender moves the cost off the critical path for *one* predicted
  navigation, at the price of doing it speculatively for navigations that never
  happen.
- **Shell state** — the cart `<dialog>` stayed open across navigation as the
  *same DOM node*. A prerendered document is a new document and cannot inherit
  live state.
- **Cross-browser** — Speculation Rules is Chromium-only. Safari and Firefox get
  the View Transition and none of the instant.

So the lead becomes app/agent interop and state persistence, with speed as
parity rather than advantage on Chromium.

---

## Still open

1. **The Arm A rule set specifically.** This run used `eagerness: 'immediate'`
   on a runtime-injected rule for one URL. `arm-native/speculation-rules.liquid`
   uses `moderate` (hover intent) with `not href_matches` exclusions and a
   `not selector_matches: "form a"` clause. Platform eligibility is proven; that
   *rule set* firing correctly on `base-theme-next` is not.
2. **⚠ Prerender and analytics — a hypothesis, not a finding.** A prerendered
   Shopify document boots Web Pixels Manager and Trekkie. The prerender spec
   expects pages to defer analytics until activation, via `document.prerendering`
   and the `prerenderingchange` event. Whether Shopify's stack honours that is
   unverified. If it does not, a prerender that is never activated could emit a
   phantom pageview — which would land directly on top of the admin-analytics
   work in `src/analytics.ts`. Worth probing with the same custom-pixel rig used
   in `standard-events-probe.md`: prerender a page, never click it, watch for a
   `page_viewed`.
3. **Which of dev-server vs automation** broke the July run. Academic now.
