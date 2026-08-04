# Standard-events probe — does the PageViewEvent bridge reach Web Pixels?

**Status:** ANSWERED 2026-08-04. Stage A passed, Stage B returned a clean
negative. Arm 2 was not needed — there was nothing to disambiguate.

## Answer

**`@shopify/standard-events` is dispatch-only. It is not bridged into Web
Pixels.** Re-dispatching `PageViewEvent` on a soft navigation does not reach the
pixel sandbox, so no theme-side code can close the analytics gap on new-Liquid.

Evidence, on `new-liquid-rislfwnm.myshopify.com`, arm 1, published theme, custom
pixel subscribed to `all_events`:

| Observation | Result |
|---|---|
| Hard load (control) | `page_viewed` + `product_viewed` both arrive |
| Soft navigations walked | 7 |
| `page_viewed` in sandbox across those 7 | **0** |
| `product_viewed` in sandbox across those 7 | **0** |
| `clicked` in sandbox during the same walk | arriving throughout |
| `shopify:page:view` dispatched per swap (Stage A) | 1, every time |

The `clicked` events are what make this conclusive. The sandbox was live,
connected, and receiving for the entire walk — this is not a detached pixel or a
dead subscription. The receiver worked; the page-view events never came.

### Two further findings

**Shopify's own instrumentation has the same gap — confirmed, not inferred.**
`product_viewed` never arrived either. Pusha deliberately does not re-fire
page-type events, so that one comes from the theme's own
`<s-view-event view-event-trigger="connect">` elements re-mounting in swapped
content.

A capturing listener on `document` (which catches events dispatched on
descendants whether or not they bubble) confirms both events *do* fire on a
swap:

```js
['shopify:page:view','shopify:product:view','shopify:collection:view'].forEach(t =>
  document.addEventListener(t, () => console.log('[evt]', t, location.pathname), true));
```

```
[evt] shopify:page:view      /products/the-collection-snowboard-liquid
[evt] shopify:product:view   /products/the-collection-snowboard-liquid
```

So this is not "the theme's components fail to re-fire." They fire correctly.
Nothing receives them. The platform's own new-Liquid view-event components have
the same gap on any soft navigation — this is not a Pusha-shaped problem, and
not a third-party-runtime problem.

**WPM's document-level listeners survive the swap.** The steady `clicked`
traffic proves Web Pixels Manager is alive and listening on the page after a
soft nav. It has not torn down. What's missing is narrow and specific: no route
from the standard-events channel into the sandbox, and a page-view trigger that
is once-per-document.

That makes the platform ask much smaller than "fix pixels on soft navigation":
*the listener is already there — give it a soft-nav route.*

## Stage A result — the bridge executes (2026-08-04)

Run on `new-liquid-rislfwnm.myshopify.com`, arm 1
(`analytics: { shopify: false, standardEvents: true }`).

- `await import('@shopify/standard-events')` returned a populated `Module`
  (`CartDiscountUpdateEvent`, `CartErrorEvent`, … ) — the theme importmap
  resolves at runtime.
- The dispatch tap logged **exactly one `shopify:page:view` per swap**, across
  five navigations (index→collection, collection→product, product→page,
  page→collection, collection→product, product→index).
- Each one landed *after* `[pusha/nav] ✓` — the signature of the
  `void fireStandardEvents(meta)` fire-and-forget path.

`shopify:page:view` **is** `PageViewEvent`'s type string. Confirmed inside the
CDN module: ``const S = `${d}page:view` `` with `d = "shopify:"`, consumed by
`super(S, e)` in the class constructor. Neither Pusha's source nor
base-theme-next contains that literal, so it can only originate in the module —
and on a swap, only `fireStandardEvents` constructs one (the theme's
`page-view-event-init.js` fires solely on `DOMContentLoaded`).

**Conclusion:** the bridge dispatches correctly. A null result in Stage B can
now be attributed to the platform, which is the whole reason Stage A exists.

**Bonus:** one dispatch per swap, never two — the self-double-fire half of the
open question at `results.md:46`, for the page-view channel.

**Two limits on this result.** The tap patches `document.dispatchEvent`, so it
sees events fired *on* document and not ones bubbling from elements — the
theme's `<s-view-event>` elements dispatch on themselves and were invisible
here, leaving the cross-channel double-count question open. And dispatching is
not receipt; Stage B is still the question.

## The question

Pusha's `standardEvents` bridge re-dispatches a `PageViewEvent` through
`@shopify/standard-events` on every PJAX swap (`src/analytics.ts`,
`fireStandardEvents`). Nobody has ever observed whether that reaches the Web
Pixels sandbox.

It matters because it is the only channel Pusha has left. The other path —
`Shopify.analytics.publish('page_viewed', …)` — is
[rejected by the platform](https://shopify.dev/docs/api/web-pixels-api/emitting-data):
storefront publish is custom-events only, so standard event names never arrive.
See README "Analytics & tracking".

Two outcomes, both worth having:

- **Arrives** → there is a supported, documented-surface route to pixels on
  new-Liquid themes, with no WPM internals involved. That is a real answer to
  the gap and worth publishing.
- **Doesn't arrive** → the precise, measured platform ask: standard-events is
  dispatch-only and is not bridged into Web Pixels on soft navigation.

## Why it runs in two stages

`loadStandardEvents()` swallows its own import failure:

```ts
try { standardEventsModule = await import(STANDARD_EVENTS_SPECIFIER); }
catch { standardEventsModule = null; }
```

Correct as production defense, fatal for a single-stage experiment: a broken
import and a platform that doesn't forward produce **identical** observations
(nothing in the sandbox) and imply opposite next steps. Stage A rules out the
former before Stage B measures the latter.

There is also **no test coverage** for this bridge — `grep -rln
"standardEvents\|PageViewEvent" test/` returns nothing — so "it is wired
correctly" is, until Stage A passes, an inference from reading the code.

## Prerequisites (verified 2026-08-04, no action needed)

| Check | State |
|---|---|
| `assets/pusha.min.js` in base-theme-next matches a fresh build | ✅ byte-identical, `sha256 8a252d25…` |
| That build contains the bridge | ✅ `PageViewEvent` present in the minified UMD |
| Dynamic `import()` survived minification | ✅ `import(Ft)` present — Vite did not rewrite it |
| Theme importmap resolves the specifier | ✅ `layout/theme.liquid:7` → `https://cdn.shopify.com/storefront/standard-events.js` |
| That URL serves | ✅ HTTP 200, 7.7 kB |
| `firePageView()` runs on every swap | ✅ `src/runtime.ts:366` |

## Config

`snippets/pusha-config.liquid` in base-theme-next is already set up. One line
switches arms:

```js
var PROBE_STANDARD_EVENTS = true;   // arm 1: true    arm 2 (control): false
```

which feeds:

```js
analytics: { shopify: false, standardEvents: PROBE_STANDARD_EVENTS },
```

`shopify: false` removes the rejected `publish()` calls so anything reaching a
pixel can only have come through standard-events.

> **Trap:** `standardEvents` is nested inside `analytics`. It is not a top-level
> `PushaConfig` key, and `analytics: false` disables it along with every other
> bridge. Both of these silently disable the thing under test:
> ```js
> analytics: false, standardEvents: true   // top-level key ignored
> analytics: false                         // all four bridges off
> ```

## Procedure

### 0. Publish

```sh
cd ~/Work/base-theme-next
shopify theme push --store <your-dev-store>.myshopify.com
```

Then **publish it as the live theme** in admin (Online Store → Themes →
Actions → Publish). Custom pixels only run on the published theme —
`shopify theme dev` will show nothing and read as a false negative.

### Stage A — does Pusha dispatch at all? (top frame, no pixel needed)

Open the storefront, DevTools console, **top frame** (not the sandbox iframe).

1. Confirm the module resolves:

   ```js
   await import('@shopify/standard-events')
   ```

   Expect a module object. A rejection means the importmap isn't reaching the
   page — stop, that's a Pusha/theme bug, not a platform answer.

2. Tap every dispatch, name-agnostic:

   ```js
   const orig = document.dispatchEvent.bind(document);
   document.dispatchEvent = (e) => {
     if (!/^(pointer|mouse|key|touch|scroll|visibility)/.test(e.type)) {
       console.log('[tap]', e.type);
     }
     return orig(e);
   };
   ```

3. Soft-navigate: collection → product → another product, via in-theme links.

**Pass:** a page-view event type appears in `[tap]` on each swap.
**Fail:** nothing. Stop — the bridge is broken and the finding is ours to fix,
not Shopify's.

### Stage B — does it reach the sandbox?

1. Admin → Settings → Customer events → **Add custom pixel**. Name it `probe`.
   Paste:

   ```js
   analytics.subscribe('all_events', (event) => {
     const path = event.context?.document?.location?.pathname;
     console.log('[probe]', event.name, path);
   });
   ```

   Save and connect it. If consent gating is on for the store, grant consent
   before testing.

2. **Find the sandbox console.** The pixel's `console.log` lands in the
   web-pixels sandbox iframe, *not* the top frame. In DevTools, switch the
   console's JavaScript-context dropdown from `top` to the web-pixels frame.
   Optionally add `navigator.sendBeacon('<request-bin-url>', event.name)` to the
   pixel so you get an external log you can screenshot.

3. **Control — hard load.** Load a product page fresh (full reload). Expect
   `page_viewed` and `product_viewed` in `[probe]`. If they don't appear, the
   receiver isn't wired; fix that before reading anything else.

4. **Measure.** From that page, soft-navigate several times and watch `[probe]`.

5. **Arm 2 (the control that makes a positive publishable).** Set
   `PROBE_STANDARD_EVENTS = false`, re-push, repeat the identical walk.

   This matters because the theme's own
   `<s-view-event view-event-trigger="connect">` elements re-mount inside
   swapped content and fire on their own. Without arm 2 you cannot tell Pusha's
   bridge from the theme's own elements, and that is the first thing a reviewer
   would ask.

## Results

Fill in counts **per navigation**, and note which frame you read them in.

| Arm | Event | Hard load (control) | Per soft nav |
|---|---|---|---|
| A — dispatch tap (top frame) | page-view type | | |
| 1 — `standardEvents: true` | `page_viewed` | | |
| 1 — `standardEvents: true` | `product_viewed` | | |
| 2 — `standardEvents: false` | `page_viewed` | | |
| 2 — `standardEvents: false` | `product_viewed` | | |

## Reading the result

| Stage A | Arm 1 `page_viewed` | Arm 2 `page_viewed` | Conclusion |
|---|---|---|---|
| pass | ≥1 per nav | 0 | **The platform bridges standard-events into Web Pixels.** Supported route exists on new-Liquid. Pusha's docs and the forum thread should say so. |
| pass | 0 | 0 | **Standard-events is dispatch-only, not bridged.** This is the platform ask, measured. Nothing in theme code can close it. |
| pass | ≥1 per nav | ≥1 per nav | Something other than the bridge is publishing — likely `<s-view-event>` re-mounts. Arm 1's result is not attributable to Pusha; investigate before claiming anything. |
| fail | — | — | Pusha bug. Fix the bridge, then re-run. Not a platform finding. |

## After

- Restore `analytics: true` in `snippets/pusha-config.liquid` (see the comment
  block in that file).
- Record the outcome in `results.md` under a new "Move 5" heading.
- If the result is publishable either way, it belongs in the
  [Liquid partials thread](https://community.shopify.dev/t/a-liquid-partials-experiment/36515) —
  a second independent implementation hitting the same wall is a materially
  stronger case than one.
