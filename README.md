# Pusha

**Instant page transitions for Shopify Online Store 2.0 themes.**

A small drop-in runtime that intercepts internal links, swaps the main container without a full page reload, and gives storefronts a native-app feel.

- 9.1 kB gzipped (UMD), zero runtime dependencies
- Built for OS 2.0 themes — JSON templates, sections, **theme blocks** (`blocks/`), and the theme editor
- Hover/touch prefetch with stale-while-revalidate cache
- Named transitions, component registry, lifecycle hooks
- Section Rendering API revalidation for stale-prone regions ("islands")
- Analytics bridges — re-fire page-view signals on every swap (see [Analytics & tracking](#analytics--tracking) for what they do and do not reach)
- Automatic focus restoration + screen-reader announcement on every swap
- Theme editor co-exists — sections re-init on `shopify:section:load` / `:select`

**Live prototype:** [yatseen.com](https://yatseen.com) is a production Shopify storefront running the Pusha runtime. Hover a product on [/collections/merch](https://yatseen.com/collections/merch) (with the network tab open) to watch it prefetch, then click for an instant, no-reload transition. It's an early build — a proof of the approach in the wild, not a pinned release of this package.

> **Status: alpha (`0.1.0`).** This is early, unstable software — expect rough edges, incomplete coverage, and breaking changes in any 0.x release. It has not been proven across a range of production stores. Pin a minor, and test thoroughly on a real store before shipping.

## Before you ship this

We would not put this on a merchant store without measuring the trade-offs first, and neither should you.

A soft navigation is not a document load. Shopify's platform does a set of things exactly once per document — boots Web Pixels Manager, initializes app scripts, renders every Liquid value on the page against the current request — and a swap silently skips all of it. Pusha takes over some of that work and cannot take over the rest. What it cannot do is where merchant data breaks:

- **Web pixels stop firing.** Anything wired through Customer Events — Meta, GA4, TikTok, Klaviyo, session replay — goes dark after the first page. This is measured, not assumed: across 7 soft navigations on a published new-Liquid store with a custom pixel subscribed to `all_events`, zero `page_viewed` and zero `product_viewed` arrived, while `clicked` events kept flowing the whole time. Both routes out of theme code are closed — `Shopify.analytics.publish` rejects standard event names by design, and re-dispatching `PageViewEvent` through `@shopify/standard-events` reaches nothing. Details in [Analytics & tracking](#analytics--tracking); full evidence in `experiments/native-vs-pusha/standard-events-probe.md`. If attribution matters on a route, don't PJAX that route.

  Two partial mitigations exist. Prefixed **custom** events do reach pixels and can be forwarded to whichever vendors you wire up yourself ([companion pixel](docs/analytics-companion-pixel.md)) — but third-party app pixels won't understand them. And Shopify **admin** reporting is a separate pipe that's independently recoverable (`analytics: { trekkie: true }`). Neither restores installed marketing apps.
- **Apps go stale or silent.** Pusha has not been built or tested against theme app extensions. App blocks inside the swapped region come back as inert HTML with dead JS; app embeds in the persistent shell survive but hold listeners pointing at replaced nodes; app-injected `<script>` tags initialize once and stay quiet after page one. There is no way to wrap code you don't own, so opt those pages out (`data-no-transition` on links into them, or `pjax: false` globally) until app support lands.
- **The persistent shell freezes at first render.** Header, footer, and anything outside the container keep the Liquid output of whichever page the buyer landed on. Currency, customer state, localization, and cart context in those regions can drift from the current URL. Pusha syncs the head and the container; it does not re-render the shell. [Islands](#islands-section-rendering-api) exist for exactly this and will revalidate a marked region through the Section Rendering API — but you have to identify the stale-prone regions yourself, and anything you miss stays wrong silently.

None of this depends on undocumented platform internals — Pusha reads standard markup and calls documented APIs, so a Shopify deploy is unlikely to break it overnight. The risk is the inverse: the gaps are quiet. Nothing throws. A store can look perfect while its pixels report nothing and its header shows the wrong currency.

So measure before you trust it. On a **published** theme, walk several navigations and confirm what actually arrives: Shopify admin live view, GA4 Realtime, Meta Events Manager, and your app surfaces. A preview or dev environment will not tell you the truth about any of them.

Stores that already carry a dozen apps have enough fragile integration points. Adding a navigation layer that quietly changes when their code runs is a real cost — weigh it honestly against the speed.

---

## Install

> **Not published yet.** Pusha is installed from this repository, not from a
> registry. The commands below fetch and build it from git. Its package name is
> `@mimetic/pusha` either way, so nothing in your theme changes when it does get
> published.

Two paths. Pick the one that matches how your theme is built.

### Path A — drop-in (no build step)

For themes without a Vite/TS pipeline. One command:

```sh
cd path/to/your/theme
npx github:mimetic-themes/pusha init
```

This copies `pusha.min.js` into `assets/`, `pusha.liquid` into `snippets/`, and (with confirmation) inserts `{% render 'pusha' %}` into `layout/theme.liquid` before `</head>`.

Flags: `--dry-run`, `--force`, `--yes` / `-y`.

### Path B — bundler

For themes with Vite or another bundler:

```sh
npm install github:mimetic-themes/pusha
```

> Not published to npm yet. `@mimetic/pusha` does not resolve on the public registry — install from the git URL above, or clone and `npm link`. The `npx @mimetic/pusha init` command in Path A has the same caveat.

Then in your entry file:

```ts
import { initRuntime } from '@mimetic/pusha';

initRuntime();
```

Both paths clone the repo and run the build on install, so they need Node
`^20.19.0 || ^22.13.0 || >=24.0.0` (the floor set by Vite and jsdom) and take
longer than a registry install. Nothing else differs — the package
name, the import specifiers, and the CLI all behave the same.

---

## Theme conventions

Pusha expects a few markers on the markup it operates on. The `init` command + the `pusha.liquid` snippet take care of most of this; this is what to know if you're wiring it manually.

```liquid
{# layout/theme.liquid #}
<body data-template="{{ template }}">
  {% sections 'header-group' %}

  <main id="MainContent" data-page-container data-page-type="{{ template }}">
    {{ content_for_layout }}
  </main>

  {% sections 'footer-group' %}
</body>
```

| Attribute | Where | Why |
|---|---|---|
| `id="MainContent"` (or override via `containerSelector`) | The element that gets swapped | Pusha replaces this on every nav |
| `data-page-container` | Same element | Used by transition CSS hooks |
| `data-page-type="{{ template }}"` | Same element | Drives transition matching, prefetch TTLs |
| `data-template="{{ template }}"` | `<body>` | Synced from the response, lets CSS target page types |
| `data-section-type="<handle>"` | Section root | Maps to `window.theme.sectionInits[handle]` |
| `data-island data-section-id="{{ section.id }}"` | Stale-prone section root | Marks for Section Rendering API revalidation |
| `data-no-transition` | Any link or its container | Opts that link out of instant nav (full browser navigation) |

Sections rendered **outside** the swap container (header, footer, cart drawer) persist across navigations — initialize them once via `setupGlobal` or `onFirstLoad`.

---

## Configuration

Set `window.theme.config` before the runtime boots. The `pusha.liquid` snippet does this for you with sensible defaults; override per theme as needed:

```liquid
<script>
  window.theme = window.theme || {};
  window.theme.config = {
    pjax: true,                          // global kill switch
    debug: false,                        // dev-mode warnings (set true while iterating)
    analytics: true,                     // analytics bridge — see "Analytics & tracking" (object form for GA4/GTM)
    transitions: true,                   // run leave/enter CSS — set false for instant swaps
    containerSelector: '#MainContent',
    prefetchInViewport: '',              // selector whose links warm as they scroll into view (off unless set)
    disabledComponents: [],              // skip these by name on every nav
    cartStatefulRoutes: [],              // routes whose cache to flush on cart:mutated

    prefetchConfig: {
      page:       { soft:  60000, hard: 300000 },
      article:    { soft:  60000, hard: 300000 },
      blog:       { soft:  60000, hard: 300000 },
      collection: { soft:  30000, hard: 300000 },
      product:    { soft:  30000, hard: 300000 },
      index:      { soft:  30000, hard: 120000 },
    },
  };
</script>
{% render 'pusha' %}
```

**Prefetch TTLs** are per template type, in ms:
- `age < soft` → serve from cache
- `soft ≤ age < hard` → serve from cache and refresh in the background (stale-while-revalidate)
- `age ≥ hard` → miss, fetch fresh

A bare number is shorthand for `{ hard: n, soft: n / 4 }`. Omit a template to disable prefetch for it.

**Merchant-facing settings** (toggles, presets) are starter-template territory, not framework. Map them in `theme.liquid` from `settings.*` into `window.theme.config`.

---

## Analytics & tracking

A PJAX swap is **not** a browser navigation, so nothing re-fires analytics on its own. Left unhandled, every store on Pusha silently under-reports — pageviews stop counting after the first page, and any tracking that keys off a document load goes quiet.

> ### ⚠ Known gap: Pusha does not currently reach Web Pixels
>
> The channel that app pixels read (Meta, GA4, TikTok, Klaviyo, session replay — anything configured in Shopify admin under Customer Events) is the **web pixel sandbox**, and Pusha does not reach it.
>
> Shopify's Web Pixels Manager initializes once per document load and is not re-initialized on a soft navigation. The storefront API Pusha calls, `Shopify.analytics.publish`, [publishes custom events only](https://shopify.dev/docs/api/web-pixels-api/emitting-data):
>
> > To ensure the quality of standard events, partners and merchants cannot publish standard events. `Shopify.analytics.publish` only exposes the method to publish custom events.
>
> So `publish('page_viewed', …)` and the `data-pusha-analytics-event` payloads below are **rejected** — the call returns `false` and no pixel receives the event.
>
> The other candidate route is closed too, and this one was measured rather than reasoned about. Re-dispatching `PageViewEvent` through `@shopify/standard-events` — a documented surface, no internals involved — reaches the sandbox on a hard load and **not at all** on a swap: 7 soft navigations, 0 `page_viewed`, 0 `product_viewed`, with `clicked` events arriving throughout to prove the pixel was live the whole time. Standard-events is dispatch-only. Procedure and evidence: `experiments/native-vs-pusha/standard-events-probe.md`.
>
> Worth knowing that this is not specific to Pusha, or to third-party runtimes at all. `product_viewed` is fired by the theme's own `<s-view-event view-event-trigger="connect">` elements when they re-mount, and it doesn't arrive either — Shopify's own new-Liquid instrumentation has the same gap on any soft navigation. Related discussion: [Shopify Developer Community](https://community.shopify.dev/t/a-liquid-partials-experiment/36515).
>
> **If your store depends on Customer Events pixels for attribution, do not run Pusha on those routes yet.** Opt them out (`data-no-transition`, or `pjax: false` globally) until this is resolved.
>
> **Two routes out of it exist, and neither is a full fix.** Prefixed *custom* events do reach pixels — that's the `customEvents` bridge below — but a companion pixel has to translate them, and third-party app pixels won't understand them. Separately, Shopify **admin** reporting turns out to be recoverable on its own: see the `trekkie` bridge. Admin and pixels are different pipes.

### Admin analytics and web pixels are one emission, two destinations

Measured on a published OS 2.0 store, a single hard-load pageview carries **the same `event_id`** across `trekkie_storefront_page_view`, both `storefront_customer_tracking` schemas, and `web_pixels_manager_event_publish`. They are not independent systems that happen to break together — they are one emission fanned out.

That has a practical consequence, also measured: calling `ShopifyAnalytics.lib.page()` on a soft navigation produces the Monorail events **and** causes Web Pixels Manager to mirror them into `storefront_customer_tracking_parity` — while still not publishing the corresponding standard event to the pixel sandboxes. WPM observes the soft navigation and routes it to admin, but not onward to pixels.

Full procedure and payloads: `experiments/monorail-admin-probe.md`.

What the bridge does still cover is below. Every channel is best-effort: absent globals are silent no-ops, and nothing here throws or blocks navigation.

> **Validate on a real, published store before trusting any of it.** GA4 DebugView and pixel configs only behave correctly against a published theme — a preview/dev environment won't tell you the truth. Check Shopify admin live view, GA4 Realtime/DebugView, and Meta Events Manager across a few PJAX navigations.

Six independent bridges, switchable via the object form:

```js
analytics: {
  shopify: true,            // Shopify.analytics.page() — classic themes (default true)
  customEvents: true,       // prefixed custom events → companion pixel (default true)
  trekkie: false,           // ShopifyAnalytics.lib.page() → admin reporting (default FALSE)
  standardEvents: 'auto',   // @shopify/standard-events PageViewEvent (new-Liquid; default 'auto')
  ga4: false,               // direct gtag.js page_view               (default false)
  dataLayer: false,         // GTM dataLayer push                     (default false)
}
```

`analytics: true` is shorthand for `{ shopify: true, customEvents: true, trekkie: false, standardEvents: 'auto', ga4: false, dataLayer: false }`; `analytics: false` disables everything.

### 1. Shopify (`Shopify.analytics.page()`) — on by default

Every swap calls `Shopify.analytics.page()`, the Trekkie/Monorail pageview that feeds Shopify admin reporting on classic themes. On new-Liquid themes this method is **absent** and the call safely no-ops (verified in `experiments/native-vs-pusha/results.md`), so the admin pageview channel is classic-only.

The same bridge also calls `Shopify.analytics.publish('page_viewed', …)` and re-publishes any page-type payloads the theme serialized. **Both of those calls are rejected by the platform** — see the gap above. They remain in the code because the surrounding lifecycle is correct and the calls are harmless no-ops, but they are not a working pixel path and should not be counted on. Reaching pixels needs either a platform change or a merchant-authored custom pixel (see below).

### 1a. Custom events (`customEvents`) — on by default

The one publish path that does reach pixels. Standard event *names* are fenced, but [custom events are explicitly supported from theme Liquid](https://shopify.dev/docs/api/web-pixels-api/emitting-data) and are delivered to "all custom pixels and app pixels". So Pusha publishes `pusha:page_viewed` on every swap, plus a prefixed copy of each serialized page-type payload.

```js
analytics: { customEvents: true }        // default — `pusha:` prefix
analytics: { customEvents: 'softnav' }   // your own namespace
analytics: { customEvents: false }       // off
```

Nothing consumes these until you add a companion pixel that subscribes and forwards them — see **[docs/analytics-companion-pixel.md](docs/analytics-companion-pixel.md)** for the pixel, the Liquid, and the honest limits. It reaches the vendors you wire up yourself; it does **not** revive third-party app pixels, because Meta and Klaviyo have no mapping for a prefixed name.

Only swaps emit these — `firePageView()` runs from the swap path alone — so they're disjoint from the native hard-load events and a companion pixel can subscribe to both without double-counting.

### 1b. Trekkie (`trekkie`) — admin reporting, **off by default**

Shopify admin's Analytics reports are fed by Trekkie/Monorail, a different pipe from web pixels. On a soft navigation it can be re-fired directly:

```js
analytics: { trekkie: true }
```

Measured on a published OS 2.0 store: `ShopifyAnalytics.lib.page(null, { path, url, pageType, resourceId })` lands `pageType` and `resourceId` in `trekkie_storefront_page_view` and both `storefront_customer_tracking` schemas, and WPM mirrors it into `storefront_customer_tracking_parity`. Called *without* those fields the event still sends but carries no `page_type` at all — identity rides the argument, so the serialized block is the whole mechanism.

`ShopifyAnalytics.meta` is never read for identity and **never written**. It's a global other scripts read; mutating it would be a side effect on code you don't own.

Identity comes from the theme, per template, rendered **inside** the swapped container:

```liquid
{% render 'pusha-trekkie-page' %}
```

Or by hand:

```liquid
<script type="application/json" data-pusha-trekkie-page>
  { "pageType": {{ request.page_type | json }}, "resourceId": {{ product.id | json }} }
</script>
```

No block → no call. Pusha never invents analytics identity.

**Why it's off by default.** `window.ShopifyAnalytics` is undocumented and sits outside Shopify's Liquid compatibility guarantee — Liquid can stay stable while the JavaScript underneath is replaced. Every access is optional-chained, so if it disappears admin reporting silently *undercounts* rather than reporting wrong data. That's a deliberate trade: an honest gap beats confident garbage. Enable it knowingly.

**Unverified, and it matters:** this proves the event is *sent* with correct fields. It does not prove Shopify admin *counts* it — that needs a controlled session comparison over a couple of days. Known payload gaps on a soft nav: `canonical_url` comes from the document's `<link rel="canonical">` (head-sync should correct it, untested), `navigation_type` stays `"reload"` from the original load's Navigation Timing entry, and `microSessionId` doesn't rotate the way a hard load rotates it.

This bridge does **not** reach web pixels. Marketing tags still need the companion pixel above.

The theme supplies page-type payloads as a JSON script inside the swapped container (`#MainContent`). No script → no event, so Pusha never fabricates data:

```liquid
{%- comment -%} sections/main-product.liquid (or a snippet rendered inside #MainContent) {%- endcomment -%}
<script type="application/json" data-pusha-analytics-event>
  {
    "name": "product_viewed",
    "data": {
      "productVariant": {
        "id": "{{ product.selected_or_first_available_variant.id }}",
        "price": { "amount": {{ product.selected_or_first_available_variant.price | divided_by: 100.0 }}, "currencyCode": "{{ cart.currency.iso_code }}" },
        "product": { "id": "{{ product.id }}", "title": {{ product.title | json }}, "vendor": {{ product.vendor | json }} }
      }
    }
  }
</script>
```

A single object or an array of `{ name, data }` events is accepted. Match Shopify's [standard event payloads](https://shopify.dev/docs/api/web-pixels-api/standard-events) so the shape is right if and when a supported publish path exists.

**The one documented way to reach pixels on a swap** is a custom event plus a merchant-authored custom pixel. Custom events are publishable from the storefront and are delivered to custom pixels, so a merchant can add a custom pixel in Shopify admin that subscribes to a namespaced event and calls `fbq` / `gtag` itself. This is not wired up in Pusha yet — it is the intended direction, tracked against the gap above. It does not reach *app* pixels: those subscribe to standard events, and a custom event only carries into them as unparsed `customData`.

### 2. GA4 (direct gtag.js) — opt-in

For a **direct** GA4 install in the theme (gtag.js in `<head>`), not GA4 routed through Customer Events. Fires `gtag('event', 'page_view', …)` on swap when `window.gtag` exists.

```js
analytics: { ga4: true }            // generic page_view
analytics: { ga4: 'G-XXXXXXX' }     // target a stream via send_to (string or array)
```

If GA4 runs through Shopify Customer Events rather than a direct gtag.js install, this bridge does not apply — and per the gap above, nothing in Pusha currently re-fires that channel either. A direct gtag.js install in the theme is presently the only GA4 path Pusha can keep alive across swaps. Turning this on alongside a working Customer Events path would double-count, so check which install you actually have before enabling it.

### 3. GTM (dataLayer) — opt-in

Pushes to `window.dataLayer` on swap for Google Tag Manager.

```js
analytics: { dataLayer: true }              // pushes { event: 'pusha.page_view', page_location, page_title, page_path }
analytics: { dataLayer: 'spa.pageview' }    // custom event name
analytics: { dataLayer: { event: 'pageview', site_section: 'storefront' } }  // merged into the push
```

Add a History-Change or Custom-Event trigger in GTM for the event name you push.

### 4. Standard Events (new-Liquid themes) — `'auto'` by default

New-Liquid themes report their generic pageview as a `PageViewEvent` dispatched through [`@shopify/standard-events`](https://shopify.dev/docs/api/web-pixels-api/standard-events), fired once on `DOMContentLoaded`. That never re-fires on a PJAX swap, so the pageview drops off the standard-events channel. When enabled, Pusha dynamically imports `@shopify/standard-events` (resolved via the theme's importmap) and re-dispatches `PageViewEvent` on every swap.

```js
analytics: { standardEvents: 'auto' }   // fires only when the theme ships @shopify/standard-events
analytics: { standardEvents: false }    // disable
```

- **`'auto'` (default)** no-ops on classic themes: if the import doesn't resolve, nothing fires — no effect on JSON-template / section themes.
- **Page-type events** (`product_viewed`, `collection_viewed`) are **not** re-fired here. The theme's `<s-view-event view-event-trigger="connect">` elements re-fire those when they re-mount in the swapped content, so Pusha touching them would double-count.
- Independent of bridge 1 — the standard-events channel and `Shopify.analytics.publish` don't cross-forward, so both can run without double-counting the generic pageview.
- **Unverified: whether this reaches the web pixel sandbox.** `@shopify/standard-events` is resolved from the theme's importmap (it is not on the public npm registry), and re-dispatching `PageViewEvent` is a documented-surface call rather than an internals hack. Whether the platform bridges that channel into Web Pixels has not been tested here — it needs the pixel sandbox on a published store. If it does bridge, this is a supported route to the gap above; if it doesn't, that's the precise thing for Shopify to fix. Do not read this bridge as a pixel fix until someone confirms it.

---

## Runtime API

```ts
import {
  initRuntime,
  go,
  registry,
  onBeforeNav, onBeforeLeave, onAfterSwap, onAfterInit, onFirstLoad, onNavError,
  registerTransition,
} from '@mimetic/pusha';
```

### Component registry

Components are init'd on the initial page load AND after every swap.

```ts
import { registry } from '@mimetic/pusha/registry';

registry.register('product-form', {
  setupGlobal() {
    // Once, on document. Delegate listeners here so they survive navigation.
  },
  init(root) {
    // Every page load + every swap. Always query within `root`, not document.
    const form = root.querySelector?.('form[action="/cart/add"]');
    // ...
  },
  destroy(root) {
    // Optional. Implement only when you hold persistent refs to container DOM
    // (observers, intervals, anime.js handles, non-delegated listeners).
    // Prefer wrapping the section as a custom element with disconnectedCallback.
  },
});
```

### Section inits (Liquid {% javascript %} pattern)

Sections that prefer the `{% javascript %}` block can register without importing:

```liquid
{# sections/featured-collection.liquid #}
<div data-section-type="featured-collection">…</div>

{% javascript %}
  window.theme = window.theme || {};
  window.theme.sectionInits = window.theme.sectionInits || {};
  window.theme.sectionInits['featured-collection'] = function (root) {
    // root is the <div data-section-type="featured-collection">
  };
{% endjavascript %}
```

For cleanup, optionally register `window.theme.sectionDestroy[handle]`.

### Lifecycle hooks

```ts
import { onAfterInit, onBeforeNav, onNavError } from '@mimetic/pusha/hooks';

onBeforeNav((url, event) => {
  // Return false to cancel the navigation.
  if (url.includes('/restricted')) return false;
});

onAfterInit((container, meta) => {
  // meta = { url, template, cached }
  console.log(`navigated to ${meta.url} (${meta.template}, cached=${meta.cached})`);
});

onNavError((error, url) => {
  // Fired before Pusha falls back to a full browser nav.
});
```

All hooks return an unregister function and may be async — returning a Promise blocks the lifecycle stage until it resolves.

| Hook | When |
|---|---|
| `onFirstLoad(container)` | Once, at boot. Equivalent to a registry's `setupGlobal()` without registering a component. |
| `onBeforeNav(url, event)` | Link intercepted, before any work. Return `false` to cancel. |
| `onBeforeLeave(container, meta)` | Before the container is destroyed. |
| `onAfterSwap(container, meta)` | After DOM swap, before `init` runs. |
| `onAfterInit(container, meta)` | After `init` (registry + sectionInits). The `pjax:content-swap` event also fires at this point. |
| `onNavError(error, url)` | Fetch failure or non-2xx response, before fallback to full nav. |

### Programmatic navigation

```ts
import { go } from '@mimetic/pusha';

await go('/products/foo');                            // simplest case
await go('/products/foo', { transition: 'slide' });   // request a named transition
await go('/account', { replace: true });              // history.replaceState
await go('/locale-switch', { hard: true });           // bypass and full-load
```

### Transitions

Around every swap, Pusha adds these to `<html>`:

- `data-transition="<name>"` — the active transition's name, for selector-based CSS
- `is-transitioning-out` — added before the leave phase, removed before the swap
- `is-transitioning-in` — added after the swap, removed when the enter phase ends

The runtime waits for either `transitionend` or `animationend` on the swap container during each phase (capped at 350 ms), so themes can use either CSS `transition` or `@keyframes`.

#### Default — baked-in fade

The `pusha.liquid` snippet ships a 180 ms opacity fade out of the box. No theme CSS needed for it to feel like a real transition. Reduced motion is respected via `@media (prefers-reduced-motion: reduce)`.

#### Customizing in CSS

Override the snippet's `<style>` rules in your own stylesheet (loaded after the snippet) — same selectors, your animations.

During a navigation the runtime sets `data-transition` (the active transition name), `is-navigating`, and `is-transitioning-out` / `is-transitioning-in` on `<html>`, plus `data-cached-nav` when the page came from the prefetch cache. The page type is on the swap container itself as `data-page-type` — so "leaving a collection page" means matching the container that is on its way out:

```css
[data-page-container] { /* base styles */ }

/* Slide instead of fade, only when leaving a collection page */
@keyframes my-slide-out { from { transform: translateX(0) } to { transform: translateX(-100%) } }
@keyframes my-slide-in  { from { transform: translateX(100%) } to { transform: translateX(0) } }

html[data-transition="fade"].is-transitioning-out [data-page-container][data-page-type="collection"] {
  animation: my-slide-out 240ms ease-in-out forwards;
}
```

#### Disabling transitions

```js
window.theme.config.transitions = false;
```

The runtime skips both class-add phases and the wait — page swaps instantly, no fade.

#### Named transitions (JS — anime.js, GSAP, View Transitions, etc.)

Register a transition with `leave` / `enter` functions returning Promises. They run instead of the CSS class path when their `from` / `to` matchers fit the navigation:

```ts
import { registerTransition } from '@mimetic/pusha/transitions';

registerTransition({
  name: 'slide',
  from: { template: ['index', 'collection'] },
  to:   { template: ['product'] },
  leave: (container) => container.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-100%)' }],
    { duration: 240, easing: 'ease-in-out', fill: 'forwards' },
  ).finished,
  enter: (container) => container.animate(
    [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }],
    { duration: 240, easing: 'ease-in-out', fill: 'forwards' },
  ).finished,
});
```

Returning `null` from a `leave` / `enter` falls back to the CSS class path. The first matcher-less registered transition acts as the default.

Force a specific transition for one navigation:

```ts
await go('/products/foo', { transition: 'slide' });
```

### Custom events

Dispatched on `document`:

| Event | Detail | Notes |
|---|---|---|
| `pjax:before-nav` | `{ url, event }` | Cancelable. `preventDefault()` on the CustomEvent falls through to a full nav. |
| `pjax:content-swap` | `{ url, template, cached }` | Fires after `onAfterInit`. |
| `pjax:islands-revalidated` | `{ sectionIds }` | Fires after Section Rendering API revalidation. |
| `cart:mutated` | `{ source, cart?, lastOperation? }` | **The theme dispatches this** after any cart change. Pusha listens and invalidates prefetch. |

### Islands (Section Rendering API)

For inventory- and price-sensitive regions inside templates that use long prefetch TTLs:

```liquid
{# sections/product-price.liquid #}
<div data-section-id="{{ section.id }}" data-island>
  Price: {{ product.price | money }}
</div>
```

After a cached navigation, Pusha fetches `?sections=section-id-1,section-id-2`, parses the JSON response, and hot-swaps the section markup. While revalidating, the island gets `.is-revalidating` for a subtle dim/skeleton.

### Cart

**Cart is theme code.** Pusha does not provide a cart API. The runtime only listens for `cart:mutated` on `document` and invalidates prefetch entries that may show stale cart state. The theme is responsible for dispatching the event after any cart mutation (add / update / remove / clear).

```ts
// In your cart code, after a successful add/update/remove:
document.dispatchEvent(new CustomEvent('cart:mutated', {
  detail: {
    source: 'theme',                    // 'theme' | 'app' | 'pusha' | custom string
    cart: cartJsonOrNull,               // optional /cart.js snapshot
    lastOperation: {                    // optional
      type: 'add',                      // 'add' | 'update' | 'remove' | 'clear'
      line: { /* line item, if applicable */ },
    },
  },
}));
```

The payload shape is **the contract**: any code that subscribes to `cart:mutated` (Pusha itself, third-party sections, app embeds) can read `event.detail.cart` and `event.detail.lastOperation` and rely on them being present *if* the publisher provided them. `source` is always required; `cart` and `lastOperation` are optional (some publishers may not know the latest snapshot).

By default, *all* prefetched entries are flushed on `cart:mutated`. Themes that know which routes display cart state can scope this with `window.theme.config.cartStatefulRoutes`.

**Bridging from theme-internal cart events:** Dawn-derived themes (Dawn and its forks) ship their own internal pubsub (`assets/pubsub.js` + `PUB_SUB_EVENTS.cartUpdate` in `assets/constants.js`). For those themes the porter agent adds a one-line bridge that subscribes to the internal event and re-dispatches `cart:mutated` on `document`. See `skill/PATTERNS.md`.

---

## Theme editor

Pusha disables instant nav inside the theme editor (`window.Shopify.designMode === true`) and instead wires Shopify's section editor events:

| Event | Behavior |
|---|---|
| `shopify:section:load` | Re-runs `registry.initAll(target)` + `sectionInits` for the loaded section. |
| `shopify:section:unload` | Calls `registry.destroyAll(target)` and `sectionDestroy[handle]` if present. |
| `shopify:section:select` | Re-runs `registry.initAll(target)`. |

Sections written to be re-init-safe under page swaps work for the theme editor automatically.

---

## Accessibility

Built in, not configurable:

- **Focus restoration** — focus moves to the URL hash target (if any) or to the swap container after every nav. Without this, keyboard users get stuck on the now-removed link.
- **Screen-reader announcement** — an offscreen `aria-live="polite"` region is updated with the new page title.
- **Reduced motion** — when `prefers-reduced-motion: reduce` matches, transitions are skipped (instant swap, no `is-transitioning-*` classes).

---

## Bundle sizes

Measured from a clean `npm run build` on 2026-08-04:

| File | Raw | Gzipped |
|---|---|---|
| `dist/pusha.min.js` (UMD, prod) | 27.0 kB | **9.1 kB** |
| `dist/pusha.esm.js` (ESM, main entry) | 19.6 kB | 6.2 kB |

Measured at `0.1.0`. The UMD bundle is everything — navigation, prefetch cache,
islands, transitions, the component registry, the analytics bridge, and the
accessibility handling. Diagnostics ship inside it too, gated at runtime by
`debug: true`, so there's no separate development build to swap in.

For comparison: `@barba/core` alone is 9.9 kB gzipped, and reaching a comparable
feature set with `@barba/prefetch` + `@barba/css` + `@barba/router` runs ~12.5 kB
— without an analytics bridge or Section Rendering API revalidation.

---

## Package exports

```
@mimetic/pusha              → main entry. initRuntime, go, registry, hooks, transitions
@mimetic/pusha/registry     → ComponentRegistry + the singleton instance
@mimetic/pusha/hooks        → onBeforeNav, onBeforeLeave, onAfterSwap, onAfterInit, onFirstLoad, onNavError
@mimetic/pusha/transitions  → registerTransition, transition primitives
@mimetic/pusha/prefetch     → prefetchPage, warmupNavLinks, invalidateCache, installPrefetch
@mimetic/pusha/islands      → revalidateIslands (Section Rendering API)
@mimetic/pusha/active-links → initActiveLinks (current/ancestor nav link classes)
@mimetic/pusha/diagnostics  → dev-mode warnings (gated at runtime by `debug: true`)
```

`active-links` is run automatically by the UMD build, so Path A themes get it
without importing anything. Path B themes call `initActiveLinks()` themselves.

TypeScript types ship for every entry.

---

## CLI

```
pusha init  [options]            Install Pusha into the current Shopify theme
pusha audit [path] [options]     Audit a theme's scripts for Pusha-readiness
pusha skill [options]            Print or install the pusha agent skill
pusha --help                     Show usage
pusha --version                  Print the version
```

Until Pusha is published, run the CLI straight from this repository with
`npx github:mimetic-themes/pusha <command>`. After a Path B install it is on
your project's `$PATH` as `pusha`.

`init` flags: `--dry-run`, `--force`, `--yes` / `-y`.

`audit` flags: `--json` for structured output, `--full` to append the whole of
`PATTERNS.md` to the report (one self-contained doc an agent can read in a
single pass), `--no-whitelist` to disable the false-positive filters and see
every raw finding. Pass a path to audit a different directory.

`skill` flags: `--print` to dump `SKILL.md` + `PATTERNS.md` to stdout, or
`--claude` / `--cursor` / `--aider` to install the skill for that agent. Add
`--global` to install into `~/` instead of the project.

The audit classifies every script in the theme by transformation difficulty (buckets A–H), plus the buckets that cover a whole surface rather than a single script: J (analytics — coverage, payload conformance, placement, and raw pixels that bypass Customer Events), K (portal-to-body custom elements needing `data-pusha-cleanup`), L (per-request Liquid frozen in the shell), M (persistent-shell stateful UI), and P (`{% partial %}` regions). The `pusha` skill consumes this output to apply the wrappers; agents without the skill can act on the audit's prescriptive "Next steps" block directly.

A `create-pusha` scaffolder for new themes is on the roadmap, once Pusha is
published.

---

## Development

```sh
git clone https://github.com/mimetic-themes/pusha.git
cd pusha
npm install         # also builds — `prepare` runs the build
npm run build       # builds ESM subpaths + the UMD bundle + .d.ts files
npm test            # jsdom smoke tests for the navigation lifecycle
npm run typecheck   # tsc --noEmit
```

The build runs `vite` twice (ESM subpaths, then the UMD bundle) followed by `tsc -p tsconfig.build.json` for declarations. `dist/` is not committed — the `prepare` script builds it on install, which is what makes the git-install paths above work.

Source layout under `src/`:

| File | Role |
|---|---|
| `runtime.ts` | Navigation engine, link interception, theme editor wiring |
| `registry.ts` | Component registry singleton |
| `hooks.ts` | Lifecycle hooks |
| `transitions.ts` | Named-transition system |
| `prefetch.ts` | Hover/pointer/focus/viewport prefetch + nav-link warmup + cache |
| `islands.ts` | Section Rendering API revalidation |
| `head-sync.ts` | Title, meta tags, body data-template, scripts, stylesheets, eager image waiting |
| `analytics.ts` | Analytics bridges — custom events, Trekkie, standard-events, GA4, GTM |
| `focus.ts` | A11y focus + aria-live |
| `scroll.ts` | Manual scroll restoration |
| `config.ts` | Resolved-config singleton |
| `diagnostics.ts` | Dev-mode warnings (gated by `config.debug`) |
| `index.ts` | Main ESM entry |
| `umd.ts` | UMD entry — auto-boots on DOMContentLoaded |
| `types.ts` | Public types + ambient `window.theme` / `Shopify` |

---

## Roadmap

- Publish to a registry, so install stops going through git
- `create-pusha` scaffolder for new themes (Astro-style)
- Pre-ported Dawn and Horizon starter forks
- v1.0 once at least one production theme has run on Pusha for ~2 weeks without contract issues

### Future packaging — the `@mimetic/pusha-*` bundle

This package (the core runtime) is planned to gain two siblings in the same `@mimetic` scope:

- **`@mimetic/pusha`** — this runtime (registry, hooks, transitions, prefetch, islands). The core.
- **`@mimetic/pusha-experiments`** — section-level A/B testing as a theme block.
- **`@mimetic/pusha-agent-ready`** — **agent-readability of the rendered page.** An audit mode of the existing `pusha audit` engine (a new bucket: "can an agent parse this page" — semantic HTML, structured markup, stable `data-section-type` roots) plus the markup patterns that fix it. Pairs with the component registry's existing markup contract.

  **Scope note:** this is *not* `llms.txt` / UCP / JSON-LD discovery-file injection — Shopify ships those natively on every store now, so that lane is commoditized. The non-commoditized value is the *rendered page itself* being agent-parseable, which the native discovery files don't address.

---

## Design notes & research

Working documents — design rationale and measured results, not user
documentation. Not shipped in the npm package (`files` excludes both).

- [`experiments/native-vs-pusha/`](experiments/native-vs-pusha/) — measured
  comparison of native cross-document View Transitions + Speculation Rules
  against Pusha on a new-Liquid theme. Includes a negative result: prerender
  did not activate against the Shopify dev storefront.
- [`docs/platform-asks-shopify.md`](docs/platform-asks-shopify.md) — five asks
  to Shopify for the new-Liquid / Standard Events preview. The first: a
  soft-navigation lifecycle event.
- [`docs/proposals/`](docs/proposals/) — audit design RFCs. Bucket P (partials)
  is implemented; bucket X (theme app extension surface) is a draft.

---

## License

MIT — Mimetic Themes, LLC
