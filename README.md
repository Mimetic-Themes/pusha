# Pusha

**Instant page transitions for Shopify Online Store 2.0 themes.**

Pusha loads the next page in the background and swaps only the main content. The header, footer, and cart drawer stay in place. Pages change with no reload.

**See it running:** [yatseen.com](https://yatseen.com) — hover a product on [/collections/merch](https://yatseen.com/collections/merch) with the network tab open to watch it prefetch, then click. That's an early build in production, not a pinned release of this package.

> **Status: alpha (`0.1.0`).** Early, unstable software — expect rough edges, incomplete coverage, and breaking changes in any 0.x release. It has not been proven across a range of production stores. Pin a minor, and test on a real store before you ship.

## Quickstart

You need Node 22.13 or later and a theme folder with `layout/theme.liquid`.

```sh
cd path/to/your/theme
npx github:mimetic-themes/pusha init            # add --dry-run to preview
npx github:mimetic-themes/pusha skill --claude  # or --cursor, --aider
npx github:mimetic-themes/pusha audit
```

`init` makes three changes:

- adds `assets/pusha.min.js` — the runtime, 11 kB gzipped
- adds `snippets/pusha.liquid` — config, the default fade, the script tag
- edits `layout/theme.liquid` — `{% render 'pusha' %}` in `<head>`, plus data attributes on `<body>` and on your main container

`skill` installs the porting instructions your coding agent reads. **Do this before you start porting.** It writes two files:

- `SKILL.md` — the procedure: audit, transform, verify, re-audit
- `PATTERNS.md` — the transformation rules, one per finding type, with worked examples

`audit` finds the scripts that run once per page load. After a swap they do not run again. For each one it prints the fix.

**Using a bundler?** `npm install github:mimetic-themes/pusha`, then `import { initRuntime } from '@mimeticthemes/pusha'; initRuntime();`. See [Path B](#path-b--bundler) for the markup you add by hand.

**Before you put this on a merchant store, read [Before you ship this](#before-you-ship-this).** A swap is not a page load. Three things do not survive one on their own, and none of them throws an error when it breaks.

## Porting a theme

Most themes need more than `init`. Any script that runs once per document has to be told to run again after a swap, and on a Dawn-shaped theme that is dozens of small, mechanical edits.

That work is meant for an agent, not for you. Install the skill, then tell your agent:

> Port this theme to Pusha. Run `pusha audit`, work the findings, and show me each change.

The audit is deterministic and emits `--json`, so the agent gets a work queue rather than prose to interpret. `PATTERNS.md` carries the rule for each finding type, so the edits come out consistent instead of improvised. Your job is to watch, steer the judgment calls the agent surfaces, and read the diff — which is why every change lands as a reviewable commit and nothing is rewritten in place without you seeing it.

Re-run `pusha audit` when the agent is done. Findings should have moved into the safe buckets.

### What the agent actually reads

`pusha audit --json` is the interface. Every finding carries:

| Field | |
|---|---|
| `id` | Stable across the edits the agent itself makes. Line numbers are excluded from it on purpose, so a half-finished port can be resumed. |
| `action` | `transform` — apply the documented fix. `decide` — don't guess, surface it to the human. `verify` — check on a real storefront. `none` — safe, or not yours to change. |
| `bucket` | The classification. `bucketRules` explains each one; `remediationByLocation` carries the fix. |

Top level adds `queue` (finding ids in work order, mechanical first, `none` omitted) and `doNotTransform` (the buckets an agent must leave alone, and why — app code you don't own is the main one).

Filters cut the payload to one slice, so an orchestrator can hand each worker its own queue instead of every worker reading the whole theme:

```sh
pusha audit --json --action transform        # the mechanical queue
pusha audit --json --bucket E,G --file sections/
pusha audit --json --action decide           # what needs your call
```

On a Dawn-shaped theme that's the difference between 123 kB and 16 kB per turn. `pusha audit --help` has the full contract.

## Checking it works

Push the theme and click around. To watch what Pusha does, set `debug: true` in `snippets/pusha.liquid` and open the console.

## What you get

- 11 kB gzipped (UMD), zero runtime dependencies
- Built for OS 2.0 — JSON templates, sections, **theme blocks** (`blocks/`), and the theme editor
- Links prefetch on hover or touch, with a cache that serves stale and refreshes behind you
- Named transitions, a component registry, and lifecycle hooks for your own code
- Marked regions re-fetch through the Section Rendering API, so prices and stock stay current ([islands](#islands-section-rendering-api))
- Page-view signals re-fire on every swap — see [Analytics & tracking](#analytics--tracking) for what they do and do not reach
- Focus moves and screen readers announce the new page, automatically
- Sections re-initialize in the theme editor on `shopify:section:load` / `:select`

---

## Before you ship this

We would not put this on a merchant store without measuring the trade-offs first, and neither should you.

A soft navigation is not a document load. Shopify's platform does a set of things exactly once per document — boots Web Pixels Manager, initializes app scripts, renders every Liquid value on the page against the current request — and a swap silently skips all of it. Pusha takes over some of that work and cannot take over the rest. What it cannot do is where merchant data breaks:

- **Installed app pixels stop firing mid-funnel.** Anything wired through Customer Events by an app — Meta, TikTok, Klaviyo, the Google & YouTube app, session replay — stops receiving events after the first page. Measured, not assumed: across 7 soft navigations on a published store with a custom pixel subscribed to `all_events`, zero `page_viewed` and zero `product_viewed` arrived, while `clicked` events kept flowing the whole time. Both routes out of theme code are closed — `Shopify.analytics.publish` rejects standard event names by design, and re-dispatching `PageViewEvent` through `@shopify/standard-events` reaches nothing. Evidence in `experiments/native-vs-pusha/standard-events-probe.md`.

  **The line is authored vs. installed, not vendor by vendor.** Pusha publishes prefixed custom events (`pusha:product_viewed`) and those *do* reach the pixel sandbox. A pixel you wrote subscribes to that name and works. An app pixel subscribes to `product_viewed`, receives your event, and ignores it. Every installed app is affected identically — no vendor is a special case, and none is exempt.

  **Checkout is unaffected.** It's its own document load, so `checkout_started` through `checkout_completed` fire normally. With the landing pageview, that means conversion tracking and purchase attribution survive. What's lost is the middle — `product_viewed`, `collection_viewed`, the browse funnel.

  **Admin reporting is separately recoverable.** With `analytics: { trekkie: true }` a soft navigation is counted as a pageview in admin — **8.5 pageviews per session** against a **~1** control with the bridge off, same click path, published OS 2.0 store. Leave it off and admin undercounts by roughly 8×.
- **Apps inside the swapped region go inert unless they re-init.** An app block's JavaScript ran on the first document and nothing re-runs it, so the markup comes back looking correct with dead JS behind it. Measured against a purpose-built extension: two shapes recover on every navigation with zero double-init — a block that listens for `shopify:page:view`, and one authored as a custom element. Every other loading shape stays inert, `type="module"` included. App embeds in the persistent shell survive but hold listeners pointing at replaced nodes. You cannot wrap code you don't own, so until an app adopts one of the two working shapes, opt those pages out (`data-no-transition` on links into them, or `pjax: false` globally). `pusha audit` bucket X reports which installed apps sit inside the container; the full table is in [App compatibility](#app-compatibility--what-survives-a-swap-measured).
- **The persistent shell freezes at first render.** Header, footer, and anything outside the container keep the Liquid output of whichever page the buyer landed on. Currency, customer state, localization, and cart context in those regions can drift from the current URL. Pusha syncs the head and the container; it does not re-render the shell. [Islands](#islands-section-rendering-api) exist for exactly this and will revalidate a marked region through the Section Rendering API — but you have to identify the stale-prone regions yourself, and anything you miss stays wrong silently.

None of this depends on undocumented platform internals — Pusha reads standard markup and calls documented APIs, so a Shopify deploy is unlikely to break it overnight. The risk is the inverse: the gaps are quiet. Nothing throws. A store can look perfect while its pixels report nothing and its header shows the wrong currency.

### Who this is safe for

The useful question isn't "does this store use Meta." It's **does anything it depends on need mid-funnel browse events it didn't wire itself?**

| Situation | Cost of the gap |
|---|---|
| No paid social | **None.** Those pixels weren't doing anything for you. |
| Prospecting ads optimizing to purchase | **Near none.** Purchase fires at checkout, which is intact. |
| **Retargeting or dynamic product ads** | **Real.** Audiences are built from browse events inside the ad account. Forwarding can't put them there. |
| **Klaviyo/Mailchimp browse abandonment** | **Real, and easy to miss** — see below. |

⚠ **Browse-abandonment flows are the trap.** Klaviyo's flow triggers on `Viewed Product`, delivered by its app pixel — the exact channel that stops. So the owned-email retargeting you'd reach for *instead of* paid ads silently stops firing past the landing page. It's recoverable (a companion pixel forwarding `pusha:product_viewed` to Klaviyo's track API, or its onsite JS wired to the same event) but it is not automatic and it fails without an error. If a store leans on browse abandonment, wire it deliberately and verify it. Same shape for Mailchimp.

Whatever depends on mid-funnel events has to be something you own end to end. That's workable when you operate and instrument the store yourself. It is not something to hand a merchant running a dozen marketing apps.

So measure before you trust it. On a **published** theme, walk several navigations and confirm what actually arrives in GA4 Realtime, Meta Events Manager, and your app surfaces. A preview or dev environment will not tell you the truth about any of them.

For admin reporting, **Live View is the wrong instrument** — it shows visitors and locations, not a countable pageview stream. Query it instead:

```shopifyql
FROM sessions
  SHOW sessions, pageviews, pageviews_per_session
  WHERE human_or_bot_session = 'human'
  TIMESERIES hour DURING today
```

`pageviews_per_session` near 1 means soft navigations aren't being counted. Meaningfully above 1 means they are.

Stores that already carry a dozen apps have enough fragile integration points. Adding a navigation layer that quietly changes when their code runs is a real cost — weigh it honestly against the speed.

---

## Install

> **Not published yet.** Pusha is installed from this repository, not from a
> registry. The commands below fetch and build it from git. Its package name is
> `@mimeticthemes/pusha` either way, so nothing in your theme changes when it does get
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

> Not published to npm yet. `@mimeticthemes/pusha` does not resolve on the public registry — install from the git URL above, or clone and `npm link`. The `npx @mimeticthemes/pusha init` command in Path A has the same caveat.

Then in your entry file:

```ts
import { initRuntime } from '@mimeticthemes/pusha';

initRuntime();
```

Both paths clone the repo and run the build on install, so they need Node
`^22.13.0 || >=24.0.0` and take
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

**Links Pusha leaves alone:** cross-origin links, `target="_blank"`, `download`, modified clicks (⌘/Ctrl/Shift/Alt or non-primary button), Shopify-reserved routes (`/checkout`, `/account`, …), anything marked `data-no-transition`, and same-page `#hash` links, which keep native smooth-scroll.

A click on the URL you are **already on** is also not a swap. It scrolls to top instead — what the browser's own reload looks like, minus the reload. Refetching byte-identical HTML would otherwise report a second view of a page the buyer never left, inflating every navigation-derived metric. A differing query string (`?sort_by=price`) is a real navigation and still swaps.

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
    standardCartEvents: true,            // bridge Shopify's standard cart events into cart:mutated
    timeout: 10000,                      // ms to wait for a page before handing the URL to the browser (0 = wait forever)

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

**`timeout`** caps how long a navigation waits for its HTML. When it expires, `onNavError` fires and the browser performs a normal navigation to the same URL, so the buyer still gets the page. Without a cap a request that never settles leaves the container faded with no way out. The snippet also grows a thin progress bar after 400 ms of waiting, so a slow navigation looks slow rather than broken.

**Merchant-facing settings** (toggles, presets) are starter-template territory, not framework. Map them in `theme.liquid` from `settings.*` into `window.theme.config`.

---

## Analytics & tracking

A swap is **not** a browser navigation, so nothing re-fires analytics on its own. Left unhandled, every store on Pusha silently under-reports — pageviews stop counting after the first page, and any tracking that keys off a document load goes quiet.

> ### ⚠ Known gap: Pusha does not currently reach Web Pixels
>
> The channel that app pixels read (Meta, GA4, TikTok, Klaviyo, session replay — anything configured in Shopify admin under Customer Events) is the **web pixel sandbox**, and Pusha does not reach it.
>
> Shopify's Web Pixels Manager initializes once per document load and is not re-initialized on a soft navigation. The storefront API Pusha calls, `Shopify.analytics.publish`, [publishes custom events only](https://shopify.dev/docs/api/web-pixels-api/emitting-data):
>
> > To ensure the quality of standard events, partners and merchants cannot publish standard events. `Shopify.analytics.publish` only exposes the method to publish custom events.
>
> So publishing under a standard name is **rejected** — the call returns `false` and no pixel receives the event. Pusha used to make those calls anyway (`publish('page_viewed', …)` plus the `data-pusha-analytics-event` payloads under their own names); they have been removed, since a call that provably cannot land reads like a working pixel path to anyone skimming the code.
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

> **Validate on a real, published store before trusting any of it.** GA4 DebugView and pixel configs only behave correctly against a published theme — a preview/dev environment won't tell you the truth. Check Shopify admin live view, GA4 Realtime/DebugView, and Meta Events Manager across a few navigations.

Six independent bridges, switchable via the object form:

```js
analytics: {
  shopify: true,            // Shopify.analytics.page() — classic themes (default true)
  customEvents: true,       // prefixed custom events → companion pixel (default true)
  trekkie: false,           // ShopifyAnalytics.lib.page() → admin reporting (default FALSE)
  standardEvents: 'auto',   // shopify:page:view — app compatibility, NOT analytics (default 'auto')
  ga4: false,               // direct gtag.js page_view               (default false)
  dataLayer: false,         // GTM dataLayer push                     (default false)
}
```

`analytics: true` is shorthand for `{ shopify: true, customEvents: true, trekkie: false, standardEvents: 'auto', ga4: false, dataLayer: false }`; `analytics: false` disables everything.

### 1. Shopify (`Shopify.analytics.page()`) — on by default

Every swap calls `Shopify.analytics.page()`, the pageview that feeds Shopify admin reporting on classic themes. On new-Liquid themes this method is **absent** and the call safely no-ops (verified in `experiments/native-vs-pusha/results.md`).

In practice this bridge is thinner than it looks: on the classic OS 2.0 store used for the Monorail probe, `Shopify.analytics.page` was **`undefined`** too — the live entry point there is `ShopifyAnalytics.lib.page`, which is what the [`trekkie`](#1b-trekkie-trekkie--admin-reporting-off-by-default) bridge calls. Treat this one as a fallback for themes where the method does exist, not as the admin-reporting story.

It is **skipped automatically when `trekkie` is on**. Both bridges re-fire the same storefront pageview, so on a theme where both are live, running both would send two pageviews per navigation — inflating admin counts and reading as a success in the very A/B measurement the trekkie bridge exists to pass.

This bridge no longer publishes Customer Events. It used to call `Shopify.analytics.publish('page_viewed', …)` and re-publish the theme's serialized page-type payloads under their standard names; those calls are **rejected by the platform** (see the gap above), so they were removed rather than left in as no-ops that read like a working pixel path. The serialized payloads now go out prefixed via `customEvents` below.

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

**Admin counts them — measured against a control.** The paragraph above proves the event is *sent* with the right fields; this is the separate question of whether Shopify's reporting records it. Both arms hand-browsed the same click path on a published OS 2.0 store, queried through the ShopifyQL `sessions` schema:

| Config | Swaps per session | `pageviews_per_session` |
|---|---|---|
| `trekkie: true` | 7–8 | **8.5** |
| `trekkie: false` (control) | 7–8 | **~1** |

The control is what makes this conclusive. With `trekkie: false` Pusha emits nothing on a swap but **prefetches identically** — so if prefetch requests were being counted as pageviews, or if hard loads were the real source, the control would have been inflated too. It wasn't. Only the landing hard-load registered.

The entire difference between the two arms is the bridge. Put the other way: **without it, a Pusha storefront undercounts admin pageviews by roughly 8×, silently.**

Known payload gaps on a soft nav, all still unverified: `canonical_url` comes from the document's `<link rel="canonical">` (head-sync should correct it, untested), `navigation_type` stays `"reload"` from the original load's Navigation Timing entry, and `microSessionId` doesn't rotate the way a hard load rotates it.

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

**The one documented way to reach pixels on a swap** is a custom event plus a merchant-authored custom pixel. Custom events are publishable from the storefront and are delivered to custom pixels, so a merchant can add a custom pixel in Shopify admin that subscribes to a namespaced event and calls `fbq` / `gtag` itself. Pusha publishes that event — see [Custom events](#1a-custom-events-customevents--on-by-default) below, and [docs/analytics-companion-pixel.md](docs/analytics-companion-pixel.md) for the pixel that consumes it. It does not reach *app* pixels: those subscribe to standard events, and a custom event only carries into them as unparsed `customData`.

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

### 4. Standard storefront events — **not an analytics channel**

This bridge used to be documented here as analytics bridge #4. It has moved to
[Standard storefront events](#standard-storefront-events--app-compatibility-not-analytics),
because Shopify documents the channel as explicitly **not** for analytics:

> **Use web pixels for analytics, not events:** Standard storefront events fire
> regardless if buyer has consented to tracking. Use them to react on the page, not
> to collect behavioral data.
> — [Listen for events](https://shopify.dev/docs/api/storefront-events-and-actions/events/listen)

It stays on by default and it still fires on every swap. It just isn't a pageview
channel, and counting it as one is what produced the "unverified — might reach the
pixel sandbox" claim that a measurement later disproved.

---

## Standard storefront events — app compatibility, not analytics

Shopify publishes a fixed vocabulary of `shopify:*` DOM events that a storefront
dispatches and apps listen for —
[Standard storefront events and actions](https://shopify.dev/docs/api/storefront-events-and-actions).
Twelve events covering page and product views, collection filtering, cart changes
and search. The stated purpose:

> Apps used to do this by parsing a storefront's DOM or intercepting `window.fetch`,
> which meant a separate integration for every storefront. Now one integration
> covers them all.

**The theme is the authority on what fires.** This is the part that matters for a
soft-navigating theme:

> Most of these events come from the storefront's own dispatch calls, so **the theme
> decides which ones exist**. Don't assume an event you depend on fires on a given
> store. — [Listen for events](https://shopify.dev/docs/api/storefront-events-and-actions/events/listen)

`shopify:page:view` is documented as firing once per page load, because "storefronts
on the Online Store are multi-page, so every navigation is a fresh document." Under
Pusha they are not. So Pusha re-dispatches it on every swap, which is the theme doing
exactly what the dispatch docs describe — constructing the event and dispatching it
when the interaction happens.

```js
analytics: { standardEvents: 'auto' }   // default — fires when the library resolves
analytics: { standardEvents: false }    // disable
```

Payload is `{ page: { template, title, url } }`, with `template` read from the
container's `data-page-type`.

### Why this is filed here and not under analytics

Because Shopify says so, in the same doc:

> **Use web pixels for analytics, not events:** Standard storefront events fire
> regardless if buyer has consented to tracking. Use them to react on the page, not
> to collect behavioral data.

That resolves a question this README previously left open. An earlier version of this
section said it was "unverified whether this reaches the web pixel sandbox" and
treated a positive result as a possible fix for the pixel gap. It was then measured
not to reach the sandbox — 7 soft navigations, 0 `page_viewed`
(`experiments/native-vs-pusha/standard-events-probe.md`). **That separation is by
design, not a defect**, and the bridge was never a candidate pixel fix. The gap above
stands on its own.

What the bridge is actually for: keeping app code alive across a swap. An app that
listens for `shopify:page:view` the way the docs tell apps to listen gets a signal on
every Pusha navigation, where it would otherwise get one signal per session.

### What is not yet established

- **Whether installed apps listen for it in practice.** The vocabulary is recent and
  adoption is unmeasured. Being sanctioned is not the same as being consumed. This is
  the primary hypothesis of the `pusha-probe` rig (variant J) — a purpose-built
  theme app extension kept in a separate private repo.
- **Non-module themes are covered, but unmeasured in the wild.** Pusha resolves the
  library with a dynamic `import('@shopify/standard-events')`, which needs the theme's
  importmap. The
  [dispatch guide](https://shopify.dev/docs/api/storefront-events-and-actions/events/dispatch#loading-the-library)
  documents a second path for themes without modules — assigning the module to
  `window.StandardEvents` — and Pusha falls back to that global when the import fails.
  Only a successful resolution is cached: the global is assigned from an async module
  script, so it can be absent on an early swap and present on a later one. No
  Dawn-derived theme following that path has been measured end to end.
- **Page-type events are deliberately not re-fired.** `product_viewed` /
  `collection_viewed` come from the theme's own `<s-view-event>` elements, which
  re-fire when they re-mount in swapped content. Pusha touching them would
  double-count.

### Actions

The same API defines **actions** — `openCart`, `updateCart`, `getCart` — that apps
call without knowing how a storefront renders its cart, with themes able to override
the default behavior so a call "updates your UI without reloading the page." Pusha
does not implement or override actions today. It is the natural seam for the
[cart](#cart) contract and is unexplored.

---

## Runtime API

*For readers who know the term: this is a small, drop-in PJAX runtime. The event
names keep the `pjax:` prefix for that reason. Everywhere else the docs say
"swap" for the DOM operation and "navigation" for the click that causes it.*


```ts
import {
  initRuntime,
  go,
  registry,
  onBeforeNav, onBeforeLeave, onAfterSwap, onAfterInit, onFirstLoad, onNavError,
  registerTransition,
} from '@mimeticthemes/pusha';
```

### Component registry

Components are init'd on the initial page load AND after every swap.

```ts
import { registry } from '@mimeticthemes/pusha/registry';

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

For cleanup, optionally register `window.theme.sectionDestroy[handle]`. It runs with the outgoing section still connected, immediately before the container is replaced, and again on `shopify:section:unload`. Use it for observers, intervals and listeners on `window` — anything holding a reference that outlives the DOM it points at. A custom element's `disconnectedCallback` is still the better answer where the markup allows one; `sectionDestroy` exists for sections that can't become custom elements.

A handler that throws is caught and logged; it never aborts the navigation.

### Lifecycle hooks

```ts
import { onAfterInit, onBeforeNav, onNavError } from '@mimeticthemes/pusha/hooks';

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
import { go } from '@mimeticthemes/pusha';

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
import { registerTransition } from '@mimeticthemes/pusha/transitions';

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
| `cart:mutated` | `{ source, cart?, lastOperation? }` | **The theme dispatches this** after any cart change. Pusha listens and invalidates prefetch — and also dispatches it itself, with `source: 'shopify-standard-events'`, when a standard cart event settles. See [Cart](#cart). |

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

#### Cart changes the theme didn't make (`standardCartEvents`)

The contract above covers cart changes *your theme* makes. It cannot cover the ones it doesn't: an app that adds a line through [`Shopify.actions.updateCart`](https://shopify.dev/docs/api/storefront-events-and-actions/actions/update-cart) mutates the cart without ever telling the theme, and every prefetched page keeps rendering the old cart badge.

Pusha closes that on its own by subscribing to Shopify's [standard storefront events](https://shopify.dev/docs/api/storefront-events-and-actions/events), the platform vocabulary every theme and app shares:

| Event | Meaning |
|---|---|
| `shopify:cart:lines-update` | lines added, updated, or removed |
| `shopify:cart:discount-update` | discount codes applied or removed |
| `shopify:cart:note-update` | cart note changed |

Each one is re-dispatched as `cart:mutated` with `detail.source === 'shopify-standard-events'`. `updateCart` "emits the matching cart events as it starts", so app-driven mutations arrive with no per-app wiring. On by default; `standardCartEvents: false` turns it off.

**The events fire *before* the cart is updated** — that's what lets a theme show an optimistic state — so Pusha waits on each event's `promise` and dispatches only once it settles. Reacting on arrival would be worse than not listening at all: a prefetch landing in that window would re-cache the *old* cart and stamp it fresh. A rejected promise dispatches nothing, because a failed or superseded update leaves the cart, and the cache, as it was.

⚠ If your theme already dispatches its own `cart:mutated` for a buyer's own cart interaction, it will now see two events for that one interaction — its own and the bridge's. Pusha's own handler is idempotent, but a theme handler that re-fetches a cart section will run twice. Filter on the source:

```js
document.addEventListener('cart:mutated', (event) => {
  if (event.detail?.source === 'shopify-standard-events') return; // already handled
  // …
});
```

---

## App compatibility — what survives a swap, measured

Theme app extension code goes inert across a swap: the app's bundle executed on the
first document and nothing re-runs it, so app block markup comes back looking correct
with dead JavaScript behind it. Bucket X of `pusha audit` reports which installed apps
sit inside the swap container.

**Measured 2026-09-11** against a purpose-built extension, four soft navigations on a
real storefront, one variant per loading shape:

| App block shape | Result |
| --- | --- |
| **Listens for `shopify:page:view`** | **recovers every nav, zero double-init** |
| **Authored as a custom element** | **recovers every nav, zero double-init** |
| Schema-attribute JS, no re-init hook | inert |
| Inline `<script>` in block markup | inert |
| In-markup `<script src>` | inert |
| `<script type="module">` in markup | inert |

Two shapes recover, with **no configuration on the theme side** — Pusha's shipped
default already dispatches `shopify:page:view`. Both are documented and supported.

**The loading shape does not determine failure.** Four mechanisms went inert
identically. Notably this rules out "re-execute the scripts in the swapped markup" as
a general remedy: for the canonical case the JS is never in the markup — the
`javascript` schema attribute makes Shopify's renderer inject a `<script async>` into
the rendered page's `<head>`.

### If you own the app

Do one of these. Both are supported and neither needs anything from the theme:

```js
// 1. Listen for the standard storefront event Pusha re-dispatches on every swap.
document.addEventListener('shopify:page:view', () => {
  document.querySelectorAll('[data-my-app-block]').forEach(mount);
});
```

```js
// 2. Or author the block as a custom element — the browser handles it.
customElements.define('my-app-block', class extends HTMLElement {
  connectedCallback() { this.mount(); }
  disconnectedCallback() { this.teardown(); }
});
```

### If you don't own the app

You cannot wrap code you did not write. Opt the surrounding navigation out with
`data-no-transition`, or treat those routes as ineligible for instant navigation.

Two experimental theme-side fallbacks exist and **both ship off**:

```js
window.theme.config = {
  appCompat: {
    sectionEvents: false,              // default
    reexecuteExtensionScripts: false,  // default
  },
};
```

- **`sectionEvents`** — dispatches `shopify:section:unload` before the swap and
  `shopify:section:load` after, on every `#shopify-section-*`. One flag governs both
  halves deliberately: load without unload leaks a listener set per navigation, worse
  than doing nothing. ⚠ `shopify:section:*` are theme *editor* events; nothing
  documents a theme dispatching them on the storefront. Best-effort compatibility, no
  ordering guarantee beyond unload → remove → insert → load.
- **`reexecuteExtensionScripts`** — ⚠ **MEASURED HARMFUL. Last resort only.**
  Re-executes scripts from `cdn.shopify.com/extensions/` only, bypassing head-sync's
  dedupe for that one origin. The dedupe stays for theme scripts because re-running one
  throws `Identifier 'X' has already been declared`.

  It does work: it is the only mechanism measured that revives an app block with **no
  re-init hook at all**. But re-executing a script does not replace the previous
  execution — it **adds another one, listeners and all**.

  **The cost is unbounded accumulation, not a single extra bind.** Measured over 4
  navigations (`pusha-probe`, run 2): a variant holding one `shopify:page:view`
  listener finished with **five** listeners and 14 double-inits, and a single click
  fired every one of them. For a real app that is five analytics events per click, five
  API calls, five modals — compounding across the session, never resetting until a hard
  load. Nothing throws, and the widget looks *more* alive, not less.

  Apps that only scan on execute (no listeners) come through looking clean. They are
  not recovering; they are being reinstalled wholesale once per navigation.

  It also **cannot repair a `type="module"` bundle**, which executes once per URL per
  document no matter how many times the tag is added.

  Enable it only when you have verified that nothing on the page registers listeners on
  `document` or `window` — which in practice means one app, audited by hand.

Measure on your own store before enabling either. `debug: true` prints what the runtime
sees on every swap.

### Not implemented: Section Rendering API re-fetch

Re-fetching a section refreshes *Liquid output* without re-running an app's bundle,
which already loaded into `<head>` and stays there. It fixes staleness, not binding —
that's what [islands](#islands-section-rendering-api) are for.

### The theme editor cannot answer any of this

It performs a full page reload on every theme app extension change, so every app reads
as recoverable there. Verify on the storefront, across a real swap.

---

## Theme editor

Pusha disables instant nav inside the theme editor (`window.Shopify.designMode === true`) and instead wires Shopify's section editor events:

| Event | Behavior |
|---|---|
| `shopify:section:load` | Re-runs `registry.initAll(target)` + `sectionInits` for the loaded section. |
| `shopify:section:unload` | Calls `registry.destroyAll(target)` and `sectionDestroy[handle]` if present. |
| `shopify:section:select` | Not handled. Selecting a section in the sidebar re-renders nothing, so re-initializing would only risk a second bind. Register your own listener in `setupGlobal` if you want scroll-into-view or a focus ring. |

Sections written to be re-init-safe under page swaps work for the theme editor automatically.

⚠ The editor is not a test for cleanup. It calls the same teardown as a swap, so a section whose cleanup is broken can still look correct here — verify on the storefront across a real navigation, with `debug: true` on.

---

## Accessibility

Built in, not configurable:

- **Focus restoration** — focus moves to the URL hash target (if any) or to the swap container after every nav. Without this, keyboard users get stuck on the now-removed link.
- **Screen-reader announcement** — an offscreen `aria-live="polite"` region is updated with the new page title.
- **Reduced motion** — when `prefers-reduced-motion: reduce` matches, transitions are skipped (instant swap, no `is-transitioning-*` classes).

---

## Bundle sizes

Measured from a clean `npm run build` on 2026-09-11:

| File | Raw | Gzipped |
|---|---|---|
| `dist/pusha.min.js` (UMD, prod) | 34.7 kB | **11.5 kB** |
| `dist/pusha.esm.js` (ESM, main entry) | 26.9 kB | 8.1 kB |

Grown from 9.1 kB gzipped in the first build — the analytics bridges, the standard
cart event bridge, and the app-compatibility flags landed since. The UMD bundle is everything — navigation, prefetch cache,
islands, transitions, the component registry, the analytics bridge, and the
accessibility handling. Diagnostics ship inside it too, gated at runtime by
`debug: true`, so there's no separate development build to swap in.

For comparison: `@barba/core` alone is 9.9 kB gzipped, and reaching a comparable
feature set with `@barba/prefetch` + `@barba/css` + `@barba/router` runs ~12.5 kB
— without an analytics bridge or Section Rendering API revalidation.

---

## Package exports

```
@mimeticthemes/pusha              → main entry. initRuntime, go, registry, hooks, transitions
@mimeticthemes/pusha/registry     → ComponentRegistry + the singleton instance
@mimeticthemes/pusha/hooks        → onBeforeNav, onBeforeLeave, onAfterSwap, onAfterInit, onFirstLoad, onNavError
@mimeticthemes/pusha/transitions  → registerTransition, transition primitives
@mimeticthemes/pusha/prefetch     → prefetchPage, warmupNavLinks, invalidateCache, installPrefetch
@mimeticthemes/pusha/islands      → revalidateIslands (Section Rendering API)
@mimeticthemes/pusha/active-links → initActiveLinks (current/ancestor nav link classes)
@mimeticthemes/pusha/diagnostics  → dev-mode warnings (gated at runtime by `debug: true`)
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

The audit classifies every script in the theme by transformation difficulty (buckets A–H), plus the buckets that cover a whole surface rather than a single script: J (analytics — coverage, payload conformance, placement, and raw pixels that bypass Customer Events), K (portal-to-body custom elements needing `data-pusha-cleanup`), L (per-request Liquid frozen in the shell), M (persistent-shell stateful UI), P (`{% partial %}` regions), and X (theme app extensions — which installed app blocks and embeds sit inside the swap container, and which survive it). The `pusha` skill consumes this output to apply the wrappers; agents without the skill can act on the audit's prescriptive "Next steps" block directly.

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
| `app-compat.ts` | Experimental theme-app-extension repairs (all flags off) |
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

### Future packaging — the `@mimeticthemes/pusha-*` bundle

This package (the core runtime) is planned to gain two siblings in the same `@mimeticthemes` scope:

- **`@mimeticthemes/pusha`** — this runtime (registry, hooks, transitions, prefetch, islands). The core.
- **`@mimeticthemes/pusha-experiments`** — section-level A/B testing as a theme block.
- **`@mimeticthemes/pusha-agent-ready`** — **agent-readability of the rendered page.** An audit mode of the existing `pusha audit` engine (a new bucket: "can an agent parse this page" — semantic HTML, structured markup, stable `data-section-type` roots) plus the markup patterns that fix it. Pairs with the component registry's existing markup contract.

  **Scope note:** this is *not* `llms.txt` / UCP / JSON-LD discovery-file injection — Shopify ships those natively on every store now, so that lane is commoditized. The non-commoditized value is the *rendered page itself* being agent-parseable, which the native discovery files don't address.

---

## Design notes & research

Working documents — design rationale and measured results, not user
documentation. Not shipped in the npm package (`files` excludes both).

- [`experiments/native-vs-pusha/`](experiments/native-vs-pusha/) — measured
  comparison of native cross-document View Transitions + Speculation Rules
  against Pusha on a new-Liquid theme. Pusha's measured advantages are a warm
  runtime (5 scripts re-parsed per nav vs ~100) and preserved shell state;
  it does **not** win on perceived latency on Chromium.
- [`experiments/prerender-recheck.md`](experiments/prerender-recheck.md) —
  native prerender **does** activate on real Shopify storefronts
  (`activationStart` 3341 ms, measured by hand). Corrects an earlier negative
  result that was a test-rig artifact. Also documents why Speculation Rules and
  Pusha must not ship on the same theme: Pusha intercepts the click, so the
  prerendered document can never activate.
- [`docs/platform-asks-shopify.md`](docs/platform-asks-shopify.md) — five asks
  to Shopify for the new-Liquid / Standard Events preview. The first: a
  soft-navigation lifecycle event.
- [`docs/proposals/`](docs/proposals/) — audit design RFCs. Buckets P (partials)
  and X (theme app extension surface) are both implemented. X's runtime half —
  re-dispatching the section lifecycle on swap — ships as the experimental
  `appCompat.sectionEvents` flag: off by default, and measured harmful when paired
  with `reexecuteExtensionScripts`. See
  [App compatibility](#app-compatibility--what-survives-a-swap-measured).

---

## License

MIT — Mimetic Themes, LLC
