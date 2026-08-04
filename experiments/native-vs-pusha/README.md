# Experiment: native fast-MPA vs. Pusha SPA on a new-Liquid theme

**Question (Move 3 from the 2026-07-22 review):** On a new-Liquid theme
(`../base-theme-next`), how much of the "SPA feel" does the *native* platform
stack deliver at zero runtime cost, and how much extra does Pusha buy? The
answer decides Pusha's positioning on new-Liquid before any 1.0 copy is written.

Do not assume the outcome. Measure it.

## Hypothesis

- **Native (Arm A)** gives smooth + often-instant *navigations* on Chromium, but
  every nav is a full document load: cold JS runtime, lost shell state
  (open drawer, scroll-in-carousel, media), and **no instant nav on Safari/FF**
  (Speculation Rules is Chromium-only).
- **Pusha (Arm B)** keeps the shell + runtime warm and preserves state across
  navs (true SPA), at the cost of ~9 kB gzip runtime + interposing on platform
  machinery (`@shopify/partial-rendering`, `@shopify/standard-events`).

If Arm A reaches ~90% of Arm B's perceived quality on Chromium *and* is
acceptable on Safari, Pusha's new-Liquid story narrows to "Safari fallback +
choreography." If the gap is large (state loss, runtime jank, Safari feels
broken), Pusha stays the vehicle for a real SPA.

## Setup

Prereq: `base-theme-next` served by a dev store (`shopify theme dev`) so both
arms run against real Shopify infrastructure (analytics, partials, checkout).
Run each arm on a separate branch/copy so they don't interfere.

- Arm A files live in `arm-native/`.
- Arm B files live in `arm-pusha/` and need `dist/pusha.min.js` (run
  `npm run build` in the pusha repo root — already verified building).

See `arm-native/README.md` and `arm-pusha/README.md` for exact apply steps.

## What to measure

Run the **same click path** on both arms, both browsers (Chrome + Safari Technology
Preview), with a warm cache and again on a cold load:

Path: `index → collection → product → add-to-cart → cart → back → back`.

| Signal | How | Why it matters |
|---|---|---|
| Nav latency (click→content painted) | DevTools Performance trace, or `PerformanceObserver` on `navigation`/soft-nav | The headline "instant" feel |
| LCP per page | Lighthouse / Web Vitals ext. | Native prerender should win cold; SPA should win warm |
| JS re-execution per nav | Performance trace "Scripting" time per nav | Native pays this every nav; SPA pays once |
| **Shell-state preservation** | Open the cart drawer, scroll a product carousel, then navigate. Does it survive? | The defining SPA property native cannot give |
| Safari instant-nav | Repeat path in Safari | Native has no Speculation Rules here — is it acceptable? |
| Analytics integrity | Shopify admin real-time + Web Pixels sandbox: count `page_viewed` per nav | Neither arm may double-count or drop (see Move 4) |

Capture numbers into `results.md` (create it), one table per browser.

## Decision rule

- Arm A within ~10% on Chromium **and** Safari feels fine, **and** no shell-state
  need in the target storefronts → new-Liquid does **not** need Pusha; position
  Pusha as OS-2.0/section-and-block only, or as an opt-in choreography layer.
- Arm A loses meaningfully (state loss visible, Safari janky, runtime cost high)
  → Pusha is the SPA vehicle on new-Liquid; fix the runtime seams (analytics
  channel, islands→partial-rendering, `#main-content`/`data-template`) and ship.

## Automation note

Once the theme is served at a URL, the Chromium-side latency/LCP/scripting
numbers can be captured automatically (Claude-in-Chrome / Playwright driving the
click path and reading `performance` entries). Hand over the preview URL to do
that pass; Safari + qualitative state checks stay manual.
