# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

**Core runtime implemented (v0.1.x).** The runtime, CLI (`audit`, `init`), skill, and test suite are in place. Parts of this file describe intended scope that hasn't landed yet (scaffolder, starters) — the README Roadmap tracks what's real. Update this file as code lands.

**The README is authoritative for the runtime contract.** This file records design rationale — why the contract has the shape it does — and some of it predates the shipped code. Where the two disagree on config keys, defaults, hook signatures, or event payloads, the README (and the source) win.

## What Pusha is

Pusha is the PJAX framework product for Mimetic Themes — the runtime layer that powers PJAX-style navigation, the component registry, and page transitions in Shopify Online Store 2.0 themes. The goal is to extract the system that currently lives inside `src/lib/` of each consumer theme into a single versioned package so themes consume it instead of vendoring copies.

**Theme scope**: Pusha targets **Shopify Online Store 2.0 themes** — both JSON-template / section-based themes (Dawn-family) and theme-block-based themes (Horizon-family). The audit walks `sections/`, `snippets/`, `layout/`, `assets/`, **`blocks/`, and `templates/`**, so block scripts and inline `.liquid`-template scripts are covered in either shape, and it never classifies code inside `{% comment %}` / `{% doc %}` spans. Legacy pre-OS-2.0 themes are best-effort.

**New-Liquid developer preview** — `.liquid` templates with inline `{% block %}`, `{% partial %}` / `content_for`, and native web components (see the reference theme at `../base-theme-next`) — is currently a **compatibility test bed, not a first-class porting target**. The audit runs and its coverage is correct there, but the `sectionInits` transform model is largely moot (components self-mount via custom-element lifecycle), and several runtime seams are still open: the analytics channel (`@shopify/standard-events` vs `Shopify.analytics`), the islands substrate (Section Rendering API vs `@shopify/partial-rendering`), container-attribute conventions (`#main-content` + `data-template` on `<main>`), and interaction between Pusha's container swap and the platform's own `partials.apply()`. The strategic question — whether new-Liquid needs Pusha at all vs. native cross-document View Transitions + speculation rules — is being resolved by a native-vs-Pusha experiment on the reference theme, not assumed. See the 2026-07-22 new-Liquid review before treating new-Liquid as supported.

Planned sibling packages in the `@mimetic` scope (`@mimetic/pusha-experiments`, `@mimetic/pusha-agent-ready`) are described in the README Roadmap → "Future packaging". They are separate packages, not part of this runtime.

## Reference implementations

The PJAX system Pusha extracts was proven in a private production Shopify theme (the "reference port" referred to throughout this file). That port's `src/lib/` — `registry.ts`, `page-transitions.ts`, `theme-init.ts`, `islands.ts` — encodes the contracts Pusha must preserve. **Note**: its `cart-api.ts` does NOT extract into Pusha — cart is theme code, not framework code (see "Cart is theme code" below).

When extracting, the load-bearing pieces are:

- **Component registry** (`registry.ts`) — `setupGlobal()` runs once on `document`, `init(root)` runs on every page load and PJAX swap, `destroy(root)` is optional cleanup
- **Page transitions** (`page-transitions.ts`) — link interception, `#MainContent` swap, history, prefetch cache, `syncHeadScripts` / `syncHeadStyles`, scroll restoration, `pjax:content-swap` dispatch
- **Theme bootstrap** (`theme-init.ts`) — `window.theme.initPage()`, `beforePageLeave()`, `prefetchConfig`, `sectionInits`, `leaveTransition` / `enterTransition` hooks

These are the public contract. The `window.theme.*` surface is what consumer themes wire into, and existing themes will break if it changes shape without a migration path.

## Build order: skill first, framework second

**The Claude skill that ports themes to the PJAX contract is being built before Pusha itself is extracted.** Rationale: the skill is a forcing function on the runtime contract. If a skill can mechanically port Dawn and Horizon to the reference port's `sectionInits` pattern, the contract is sound enough to lift into a package. If it can't, that's the signal to fix the contract *before* freezing it as v1.

Order of operations:

1. **Skill v0** — wraps section/block JS into `window.theme.sectionInits[handle]` with `data-section-type` on the root. Produces diffs against a target theme directory, not rewrites. Classifies each script as easy / medium / hard; hard scripts get a TODO and a safety-net `data-no-transition` on surrounding nav.
2. **Pilot: Dawn** — web-component-heavy, mounts naturally on DOM swap, easiest validation.
3. **Pilot: Horizon** — newer block system, real stress test for the wrapper pattern.
4. **Extract Pusha** — package the runtime (registry, page-transitions, theme bootstrap) the two ports proved out. ESM-only npm package targeting Vite-based themes.
5. **CLI starter** — `create-pusha-theme` wraps the pre-ported Dawn/Horizon forks.

### Wrapper transformation (what the skill does per section)

The universal wrapper already exists in the reference port — the skill just applies it mechanically:

- Add `data-section-type="<section-handle>"` to the section root
- Move `{% javascript %}` body / inline `<script>` into `window.theme.sectionInits[handle] = function(root) { ... }`
- Rewrite `document.querySelector(...)` → `root.querySelector(...)`
- Guard per-element listeners with `data-initialized` so re-init is idempotent
- Lift `document.addEventListener` (delegated) blocks into a one-time `if (!window.theme.__inits.<handle>)` guard so they don't re-attach on PJAX nav
- Flag for human review: module-level state, `DOMContentLoaded`, third-party app embeds

### Package contents

The npm package ships:

- `dist/pusha.esm.js` — ES module entry for Path B consumers
- `dist/pusha.min.js` — pre-bundled UMD for Path A consumers (also accessible via unpkg CDN)
- `dist/pusha.d.ts` — TypeScript types for both
- **`dist/snippets/pusha.liquid`** — Liquid snippet for Path A consumers to copy into `theme/snippets/`. Contains the deferred script tag plus any boilerplate `window.theme.config` setup. Path A install reduces to "copy `pusha.min.js` to `assets/`, copy `pusha.liquid` to `snippets/`, render `{% render 'pusha' %}` in `theme.liquid`."
- **`bin/pusha.js`** — thin CLI exposed as `pusha` via package.json `bin`. See "Onboarding CLI" below.

### User-facing positioning

The framework is for Shopify theme developers, most of whom won't recognize "PJAX" as a term. Lead with the outcome in all user-facing copy:

- **Tagline candidates**: *"Instant page transitions for Shopify themes."* / *"Single-page navigation for Online Store 2.0."* / *"Native-app feel for storefronts."*
- "PJAX" appears only in the technical reference (for devs who recognize it) and in internal docs (this file, the skill, runtime source comments). Never in README, homepage, marketing copy, or CLI help text.
- Subtitle for technical readers: *"A small, drop-in PJAX runtime"* — used once on the technical-overview page as a bridge for senior devs who know the term.

The renaming work is mechanical when the time comes (sweep README/docs/marketing once). Worth doing once, not iteratively.

### CLI — three commands, modeled after Astro's `create` pattern

The CLI exists for **discovery, one-command install, and scaffolding**, not for the porting workflow (which is the skill + Shopify CLI). Three commands. Two are invoked via `npx @mimetic/pusha <cmd>` (no global install); the third uses the `npm create` convention.

#### `npm create pusha@latest` — interactive scaffolder (Astro-style)

The gold-path entry point for new themes. Walks the user through:

1. **Mode** — Scaffold new theme / Adapt current folder
2. **Build flavor** (if new) — Vite + TypeScript / Standalone (no build)
3. **Starter** (if new) — Dawn / Horizon / Shopify skeleton / Mimetic opinionated (when it exists) / From a GitHub URL / Blank
4. **Features** — Page transitions (yes/no), animation library (anime.js / GSAP / none), Tailwind (v4) (yes/no), dev-mode diagnostics (yes/no), prefetch presets (conservative / moderate / aggressive)
5. **Install dependencies now?** — Y/N

Non-interactive flags for CI / scripted use:
- `--template <dawn|horizon|skeleton|mimetic|<github-url>>`
- `--build <vite|standalone>`
- `--add transitions anime.js tailwind`
- `--adapt` (use current folder as base, runs the port flow)
- `--no-install`
- `--yes` (accept all defaults)

This is the command that converts a curious reader into a user. It's also where opinionated features get bundled — choosing "anime.js + transitions + Tailwind" wires the right imports, snippets, and config in one shot. Cribbed directly from Astro's `--template` + `--add` model.

#### `npx @mimetic/pusha audit`

Runs the audit against the current directory (or path argument). Buckets A–H (per-script) plus the surface buckets: J (analytics), K (portal-to-body custom elements), L (per-request Liquid in the shell), M (persistent-shell stateful UI), P (partials). `--json` emits structured output for tools/agents. The CLI is the canonical audit implementation — there is no longer a parallel bash script.

#### `npx @mimetic/pusha init`

Detects Path A vs Path B (presence of `package.json` + `vite`), then:

- Path A: copies `pusha.min.js` into `assets/`, copies `pusha.liquid` into `snippets/`, optionally inserts `{% render 'pusha' %}` into `layout/theme.liquid` `<head>` if not already present.
- Path B: runs `npm install @mimetic/pusha --save`, prints the import snippet for the entry point.
- Both: confirms before writing; respects an existing install; supports a `--dry-run` flag.

Subset of `create --adapt`'s functionality — kept as a separate command for the case where the user already has a theme and just wants Pusha installed, without any of the scaffolder's other prompts.

#### Explicitly NOT in the CLI:
- `pusha port` — the skill is the porting interface, not the CLI. Don't duplicate.
- `pusha demo` — considered, rejected. A demo needs real Shopify infrastructure to be meaningful; a fake one undersells the product. Documentation + a public reference theme covers this better.
- `pusha build` — Vite handles builds in Path B; nothing to build in Path A.

#### Implementation notes
- CLI binary lives at `bin/pusha.js` in the `@mimetic/pusha` package. `npm create pusha` resolves to a separate `create-pusha` package that delegates into the same scaffolder logic (standard npm-create convention).
- Audit lives only in the CLI now. The previous bash script (`skill/scripts/audit.sh`) was removed in favor of the Node implementation — bash couldn't cleanly express the analysis-heavy buckets (K's class-hierarchy resolution being the breaking point), and maintaining two implementations was a tax with no DX upside. Skill docs and SKILL.md route at `pusha audit`.
- Starter templates live in a separate repo (`mimetic-themes/pusha-starters` or similar), cloned at scaffold time. Keeps the main package small and lets starters evolve independently.

### Path detection (skill behavior)

The skill auto-detects which path a theme is set up for and suggests the matching install method:

- Theme directory has `package.json` with `vite` in deps/devDeps → suggest Path B (`npm install @mimetic/pusha`)
- No `package.json` or no Vite → suggest Path A (download `pusha.min.js` to `assets/`, copy snippet)
- Both paths remain explicitly available; auto-detection is a recommendation, not a forced choice. The dev can override.

### Runtime contract

The runtime exposes four things to consumers: a config object, lifecycle hooks, custom events, and a programmatic API. Design lineage: Barba.js (named transitions, programmatic nav, `once` semantics) + Shopify Slate (component registry, section editor events).

#### Config — `window.theme.config`

- **`disabledComponents: string[]`** — per-component opt-out, checked inside `initPage()`. Listed handles skip their `sectionInits` call on every PJAX nav. Use case: a misbehaving section in production gets disabled without a redeploy.
- **`pjax: boolean`** (default `true`) — global kill switch. When `false`, the runtime skips link interception entirely; every nav becomes a full browser navigation. Use case: site-wide rollback if PJAX causes problems.
- **`debug: boolean`** (default `false`) — dev-mode diagnostics. When `true`, the runtime emits `console.warn` messages after every PJAX swap for unrecognized patterns: sections without `data-section-type` or a custom-element shape, inline `<script>` tags in injected content (which won't execute), and optionally observer/interval leak detection over N navigations. Always off in production. The diagnostic surface is small enough (~1KB minified) that it ships in the single `pusha.min.js` bundle and is gated only by this runtime flag — no separate dev build.
- **`prefetchConfig: Record<TemplateType, number | { soft: number; hard: number }>`** — per-template-type TTL for hover prefetch. Single number = serve fresh up to TTL, discard after. Object form = serve fresh up to `soft`, between `soft` and `hard` serve cached HTML but revalidate islands (see "Islands" below), discard after `hard`. Template types not in the config are never prefetched. Default is conservative (page/article/blog only).
- **`analytics: boolean | object`** (default `true`) — analytics bridge opt-out. Almost never set to `false` — disabling silently breaks merchant reporting. The shipped form widened past the boolean described in "Analytics bridge" below: four independent bridges (`shopify`, `standardEvents`, `ga4`, `dataLayer`), where `true` means `{ shopify: true, standardEvents: 'auto', ga4: false, dataLayer: false }`. **See the README's "Analytics & tracking" section for the current contract.**
- **`containerSelector: string`** (default `'#MainContent'`) — the PJAX swap target. Themes with non-standard markup can override. The element should also carry `[data-page-container]` and `[data-page-type]` for transition matching.

#### Hooks — lifecycle extension points

Imported from `@mimetic/pusha/hooks`, or available on the global `Pusha` object. Each returns an unregister function.

```js
onBeforeNav((url, event) => { /* link click intercepted, before any work */ });
onBeforeLeave((container) => { /* before DOM is destroyed */ });
onAfterSwap((newContainer) => { /* DOM swapped, before initPage runs */ });
onAfterInit((newContainer) => { /* sectionInits + custom elements all initialized */ });
onFirstLoad((container) => { /* runs once on initial page load only, never on subsequent navs */ });
onNavError((error, url) => { /* fetch failure or non-2xx response, before fallback to full nav */ });
```

Async handlers are awaited (returning a Promise blocks the lifecycle stage until it resolves). Hooks fire in registration order. The existing `pjax:content-swap` custom event still fires after `onAfterInit` for consumers who prefer event listeners over hooks.

Each `onAfterInit` / `onAfterSwap` handler receives the container plus a meta object:
```ts
onAfterInit((container, meta) => {
  meta.url       // string — the URL just navigated to
  meta.template  // string — value of data-page-type on the container
  meta.cached    // boolean — true if the HTML came from prefetch cache
});
```

The `onFirstLoad` hook is Barba-inspired — for code that needs to run exactly once at app boot, not on every PJAX swap. Equivalent to the registry's `setupGlobal()` but available without registering a component.

#### Custom events — dispatched on `document`

- **`pjax:before-nav`** — fired before link interception begins. Cancelable. Detail: `{ url: string; event: MouseEvent | KeyboardEvent | null }`. Calling `event.preventDefault()` on the CustomEvent (not the original MouseEvent) falls through to full browser nav.
- **`pjax:content-swap`** — fired after every PJAX DOM swap and `initPage()` call. Detail: `{ container: HTMLElement; url: string; template: string; cached: boolean }`. Use for app / section self-init that can't use the registry.
- **`cart:mutated`** — themes dispatch this after any cart mutation (add / update / remove / clear). Pusha listens to invalidate prefetched HTML for routes that display cart state. Detail shape:
  ```ts
  {
    source: 'theme' | 'app' | 'pusha' | string,  // who triggered the mutation
    cart?: unknown,                              // optional /cart.js snapshot
    lastOperation?: {
      type: 'add' | 'update' | 'remove' | 'clear',
      line?: unknown,                            // line item, if applicable
    },
  }
  ```
  `source` is required; `cart` and `lastOperation` are optional (publishers may not always know the latest snapshot). **The theme is responsible for dispatching this event** — Pusha does not provide a cart API. See "Cart is theme code" and "Cart invalidation strategy" below.

  **Why `cart:mutated` not `cart:updated`:** "mutated" semantically pins the meaning to "the cart's state just changed," matching Shopify's Customer Events vocabulary (`product_added_to_cart`, `product_removed_from_cart`). "Updated" is ambiguous — could mean "the cart UI was repainted" or "the cart data refreshed." Confirmed with Shopify devrel (2026-05-13) that no documented intra-theme cart-state convention exists; Pusha is defining its own. Theme Store review evaluates user-visible cart behavior, not the JS contract, so the choice is ours.

Pusha's events are **in addition to** Shopify's `shopify:*` theme editor events (`shopify:section:load`, `shopify:section:unload`, `shopify:section:select`, `shopify:block:select`). Themes must still listen for those when running inside the theme editor.

#### Programmatic API — `Pusha.go(url, options?)`

Programmatic PJAX navigation. Cribbed from `barba.go(url)`.

```js
import { go } from '@mimetic/pusha';
// or via the global: window.Pusha.go('/cart');

await go('/cart');                              // simplest case
await go('/products/foo', { transition: 'slide' }); // request a specific named transition
await go('/account', { replace: true });        // history.replace instead of push
```

Returns a Promise that resolves after `onAfterInit`. Useful for form-submit redirects, post-cart-add navigation, "go home after checkout" flows.

#### Named transitions

Register transition behaviors by name with optional `from`/`to` matchers. Replaces the URL-pattern-based `getTransitionType()` from the reference port with a more flexible declarative model (Barba pattern).

```js
import { registerTransition } from '@mimetic/pusha/transitions';

registerTransition({
  name: 'fade',
  // optional matchers — if omitted, this transition is the default fallback
  from: { template: ['*'] },
  to:   { template: ['*'] },
  leave: (container) => { /* return Promise or null to fall through to CSS class */ },
  enter: (container) => { /* same */ },
});

registerTransition({
  name: 'slide',
  from: { template: ['index', 'collection'] },
  to:   { template: ['product'] },
  // ... runs only for these transitions
});
```

`template` matching reads `data-page-type` on `#MainContent`, which themes populate from Shopify's Liquid `template` variable: `<main id="MainContent" data-page-type="{{ template }}">`.

### Cart is theme code

Cart operations (add, update, remove, fetch) belong in the theme, not the framework. Pusha listens for one event — `cart:mutated` on `document` — to invalidate prefetched HTML when cart state changes. The theme is responsible for dispatching it (directly, or via a bridge from the theme's existing internal cart-event system — see `skill/PATTERNS.md` for Dawn-family adapters).

Where cart code lives:
- **Existing themes**: their own cart code, audited and transformed by the skill like any other code.
- **New themes**: the `npm create pusha` starter templates may include a reference cart implementation. Starters are opinionated; the framework is not.
- **If a Mimetic-authored cart helper library ever ships**, it's a separate package (`@mimetic/cart`), not a subpath of Pusha.

### Head sync — required, automatic

On every PJAX nav, the runtime syncs three things from the fetched HTML to the current document:

1. **`<title>`** — set to `doc.title`. Without this, the browser tab title doesn't update.
2. **Meta tags** — `<meta name="description">`, `<meta property="og:title">`, `<meta property="og:description">`, `<link rel="canonical">`. Without these, SEO and social sharing break (the original page's tags persist).
3. **`<body data-template>` attribute** — copied from `doc.body[data-template]`. Without this, CSS rules that target `body[data-template="product"]` go stale.

Scripts and stylesheets also sync via `syncHeadScripts` / `syncHeadStyles` (already described in the runtime architecture). All four sync operations are automatic and not configurable.

Themes must populate `<body data-template="{{ template }}">` in `layout/theme.liquid` for the template-attribute sync to work. The starter templates do this; the skill's `init` command can add it to existing themes that lack it.

### Islands — Section Rendering API revalidation

The Shopify Section Rendering API lets you fetch any section's HTML in isolation: `GET /products/foo?sections=section-id-1,section-id-2` returns JSON `{ "section-id-1": "<div>...</div>", ... }`. Pusha uses this to keep stale-prone regions live even when the outer page HTML came from a long-lived prefetch cache.

**Opt-in contract** — a section marks itself as an island by adding two data attributes to its root:
```liquid
<div data-section-id="{{ section.id }}" data-island>
  <!-- price, availability, badges, variant JSON — anything stale-prone -->
</div>
```

**When islands revalidate**:
- Always on cached PJAX navigations (the page HTML came from the prefetch cache, but inventory may have moved since)
- On navigations where prefetchConfig's `soft` TTL has elapsed but `hard` has not — page HTML is reused, islands fetched fresh
- Never on uncached navigations — the page was just fetched, everything is current

**Visual contract**: while an island is revalidating, it gets a `.is-revalidating` class that themes can style for a subtle dim/skeleton. The class is removed when the new HTML is in place.

**Exported as `@mimetic/pusha/islands` subpath** for explicit imports. Auto-imported by main entry when prefetch is enabled.

### Theme editor integration

Pusha is designed to coexist with Shopify's theme editor, not fight it. Behavior in editor context:

- **PJAX is disabled** when `window.Shopify?.designMode === true`. Link interception turns off; navigation goes through full browser nav. Themes still preview as the merchant clicks around the editor.
- **`shopify:section:load`** — Pusha listens. Reads the loaded section's `data-section-type`, calls `sectionInits[handle](sectionEl)` for that single section. Same behavior as a PJAX init pass scoped to one section.
- **`shopify:section:unload`** — Pusha listens. If a `sectionDestroy[handle]` function exists for that section, it's called. Otherwise no-op (cleanup is custom-element / `disconnectedCallback` territory; see "Lifecycle" below).
- **`shopify:section:select`** / **`shopify:block:select`** — Pusha does not handle these by default. Themes wire their own behavior (smooth-scroll to selected block, show focus ring, etc.) — typically via event listeners registered in `setupGlobal`.

The skill's transformations should pass the theme editor as a re-init test case: any `sectionInits[handle](root)` body must be idempotent enough to re-fire on `section:load` without breaking.

### Container & layout rules

**Pusha only swaps the element matching `containerSelector`** (default `#MainContent`, configurable). Everything else in the DOM — header, footer, cart drawer, any global modals or overlays — persists across navigations. This is a hard contract; the consequences are baked into the rest of the architecture.

**Sections rendered outside `#MainContent` are "global":**

- Header, footer, cart drawer, anything in `layout/theme.liquid` outside the container element
- Sections rendered via `{% sections 'group-name' %}` *when that group sits outside the container* (most don't, but check per-theme)

Global section JS:
- Initializes once on `onFirstLoad`, not on every PJAX nav
- Uses `setupGlobal()` in the component registry for delegated listeners that survive navigation
- Does NOT receive a fresh `root` element on each nav — the same DOM persists

The skill's audit treats `layout/*.liquid` and snippets rendered from layout as "global scope" and flags inline scripts there as bucket E with a `[global]` annotation. Wrappers for global sections use `onFirstLoad` instead of `sectionInits`.

**Section groups** (newer Shopify pattern, `{% sections 'header-group' %}`): files in `sections/*.json` declare which sections render where. Pusha handles section-group sections like any other section — the *location* (in-container or out-of-container) determines whether they're global or per-page, not the group itself.

### Lifecycle — destroy is opt-in via custom elements, not the registry

**Pusha does not provide a per-section `destroy(root)` callback** in `window.theme.sectionInits`. The reason: most sections don't need explicit cleanup, and adding a destroy hook to the contract pressures every section author to write one. We choose the smaller surface.

**For cleanup, use custom elements.** A section that holds an `IntersectionObserver`, animation, interval, or non-delegated listener should be wrapped as a custom element with both `connectedCallback` and `disconnectedCallback`. The browser handles lifecycle natively; cleanup runs when the element leaves the DOM (PJAX swap or `shopify:section:unload`).

**Optional escape hatch**: `window.theme.sectionDestroy[handle] = function(root) {...}` is supported if registered. Pusha calls it before `#MainContent` is replaced and on `shopify:section:unload` for that section. Use this only when wrapping as a custom element isn't feasible.

The skill flags components that need cleanup (bucket D, observers/intervals/animations) and recommends Option 2 (custom-element promotion). `sectionDestroy` is documented but not encouraged.

### Navigation behavior — back/forward, scroll, errors, forms, hashes

#### History and scroll restoration

- Pusha sets `history.scrollRestoration = 'manual'` and manages scroll per history entry itself.
- On forward nav: scroll resets to top (or to URL hash target).
- On back/forward (`popstate`): scrollY recorded at leave time is restored on return.
- Prefetch TTL does not affect back/forward — once a page has been in the user's session, returning to it via Back uses the live in-memory snapshot, not the prefetch cache.

#### Error handling

- **Fetch failure (network error or non-2xx response)**: `onNavError` hooks fire, then Pusha falls back to `window.location.href = url` for full browser navigation. Shopify's own 404 / 500 templates render normally. Analytics and merchant reporting stay consistent.
- **Aborted fetch** (user clicked another link mid-fetch): silent, no error hook, the second nav supersedes.
- **Timeout**: configurable in `prefetchConfig` and main fetch options (defaults TBD during extraction).

#### Forms

- **POST forms are never intercepted.** They submit normally to the server. Required for login, customer account flows, contact forms, and any Shopify form that depends on redirect-after-POST.
- **GET forms** are also not intercepted by default. Themes that want PJAX search / filter behavior can wire it manually via `Pusha.go(url)` from a submit handler. This may become opt-in via `data-pjax` attribute on the form in v2; not a v1 requirement.

#### Hash links

- **Same-page hash navigation** (`href="#section-id"` where the path matches current location): not intercepted. Browser handles smooth-scroll natively.
- **Cross-page hash navigation** (`href="/other-page#section-id"`): Pusha fetches, swaps, then scrolls to the hash target after `onAfterInit`.

#### Other navigation rules

- Link interception applies only to `<a>` elements with same-origin `href` and no opt-out attributes (`data-no-transition`, `target="_blank"`, `download`, modifier-key clicks).
- Shopify-managed routes are never intercepted: `/checkout`, `/account/login`, `/account/register`, anywhere matching `/checkouts/*`. **`/cart` is NOT on that list** — it is a regular themed page and does go through PJAX. It is opted out of nav-link *warmup* separately, since it is stateful and warming it is wasteful. `src/routes.ts` is the authority for both link interception and prefetch.
- `<html lang>` and `<html dir>` are **not synced** on PJAX nav. Pusha assumes language and direction are stable within one session. Themes serving multiple languages should route language-switch navigations through full browser nav (or trigger `Pusha.go(url, { hard: true })` — TBD during extraction).

### Merchant-facing settings — starter-template territory, not framework

The framework itself only knows about `window.theme.config.*` (a plain JS object). **Merchant-facing settings UI is starter-template responsibility** — not framework responsibility — because Shopify settings live in `{% schema %}` blocks and translate to Liquid at render time, both of which are theme code.

**Recommended pattern for starter templates and themes ported through the v2 skill workflow:**

Add a settings group via a settings schema entry, then map the settings to `window.theme.config` in `layout/theme.liquid` before rendering the Pusha snippet:

```liquid
{# layout/theme.liquid — in <head>, before {% render 'pusha' %} #}
<script>
  window.theme = window.theme || {};
  window.theme.config = {
    pjax: {{ settings.pusha_enabled | default: true | json }},
    disabledComponents: {{ settings.pusha_disabled_components | default: '[]' }},
    prefetchConfig: {{ settings.pusha_prefetch_preset | default: 'conservative' | json }},
    debug: {% if request.design_mode %}false{% else %}{{ settings.pusha_debug | default: false | json }}{% endif %}
  };
</script>
{% render 'pusha' %}
```

The merchant sees a "Pusha" group in theme settings with toggles like:
- "Enable instant page transitions" (boolean)
- "Disable transitions on" (multi-select by template — product/collection/cart/etc.)
- "Prefetch behavior" (conservative / moderate / aggressive — maps to predefined `prefetchConfig` presets)
- "Show debug warnings" (boolean — for dev / preview themes)

**Why this is starter-template-only in v1:**

- Framework stays clean — it's just runtime + config object
- Different themes want different toggle sets; baking a fixed UI into the framework would over-constrain
- The skill's automatic transforms don't touch `{% schema %}` blocks today (Liquid schemas are invasive to edit)

**v2 skill addition (deferred):** a `pusha --add-settings` command that adds this settings group + Liquid mapping to a ported theme. Separate from the core port because schema editing is risky and merchant-visible. Document the pattern now so starter authors and future skill versions both target the same shape.

### Cart invalidation strategy

When `cart:mutated` fires on `document`, Pusha invalidates prefetched HTML for:

1. Any route matching `/cart` (always)
2. Any cached entry whose URL is in `window.theme.config.cartStatefulRoutes: string[]` if defined
3. Otherwise, **all** prefetched entries (conservative default — invalidating only some is risky when cart counts appear in headers/badges across pages)

Themes that want fine-grained control populate `cartStatefulRoutes` with the routes that actually display cart state. Default behavior (flush all) is safe but defeats prefetch when the cart updates frequently.

### Accessibility — focus management on PJAX nav

PJAX nav has real a11y implications. The runtime handles:

- **Focus restoration**: after DOM swap, focus is moved to either the URL hash target (if any) or to `#MainContent` (or whatever element matches `[data-page-container]`). Without this, keyboard users get lost after every nav.
- **Screen reader announcement**: an offscreen `aria-live="polite"` region is updated with the new page title after PJAX swap, so screen readers announce the navigation. Without this, the URL silently changes and assistive tech doesn't know.
- **Reduced motion**: when `prefers-reduced-motion: reduce` matches, transitions are skipped (instant swap, no `is-transitioning-*` classes). Themes can override per-transition.

These are not configurable — they're correctness requirements. Themes can register custom focus behavior via the `onAfterInit` hook if needed (e.g., focus a search input after navigating to /search).

### Analytics bridge — required, automatic, in the runtime

**Unlike cart, analytics IS framework concern.** Without a PJAX-aware analytics bridge, every Shopify storefront using Pusha silently corrupts merchant data: admin dashboards under-report pageviews, every pixel wired through Customer Events stops firing on PJAX-navigated pages. This is a non-negotiable piece of infrastructure.

The bridge ships in the core runtime and runs automatically. It re-fires Shopify's native analytics on every PJAX swap:

```ts
function firePageView() {
  const analytics = window.Shopify?.analytics;
  analytics?.page?.();                              // Shopify admin reporting
  analytics?.publish?.('page_viewed', { url: window.location.href });  // Customer Events fan-out
}
// Fires on every PJAX swap, after initPage runs.
```

Two channels covered automatically:
1. **`Shopify.analytics.page()`** — Shopify admin dashboard (sessions, conversion funnel).
2. **`Shopify.analytics.publish('page_viewed', payload)`** — Customer Events sandbox. **All pixels wired through Shopify admin** (Meta, GA4, TikTok, Klaviyo, etc.) listen on this channel and re-fire automatically. No theme-side code needed.

**Config opt-out** (rare): `window.theme.config.analytics = false` disables the bridge. Only use this if the merchant explicitly doesn't want Shopify analytics — almost never the right choice.

**Robustness**: if `window.Shopify?.analytics` is absent (unusual setups, older themes, headless contexts), the bridge becomes a silent no-op. It never throws and never blocks navigation.

**What's NOT in the framework** — third-party pixels NOT wired through Customer Events (raw `<head>`-injected `gtag`, `fbq`, `dataLayer.push`, etc.). These are theme-level. The theme either:
- Migrates those pixels into Customer Events via Shopify admin (preferred — they'll then refire automatically through the bridge)
- OR registers a `pjax:content-swap` listener / `onAfterInit` hook to refire them manually:
  ```js
  import { onAfterInit } from '@mimetic/pusha/hooks';
  onAfterInit(() => {
    window.gtag?.('event', 'page_view', { page_location: location.href });
    window.dataLayer?.push({ event: 'virtualPageView' });
    window.fbq?.('track', 'PageView');
  });
  ```

The skill's audit calls out raw-injected pixel scripts (gtag/fbq/dataLayer/ttq call sites) and recommends either Customer Events migration or manual refire. This shipped as **bucket J (analytics surface)** on 2026-08-01, alongside coverage, conformance, and placement checks for the `data-pusha-analytics-event` markers — see `docs/proposals/analytics-surface-audit.md`.

### Package exports

```
@mimetic/pusha              → main entry. initRuntime, go, registry, default re-exports
@mimetic/pusha/registry     → component registry (register, setupGlobal/init/destroy primitives)
@mimetic/pusha/hooks        → onBeforeNav, onBeforeLeave, onAfterSwap, onAfterInit, onFirstLoad
@mimetic/pusha/transitions  → registerTransition, transition primitives
@mimetic/pusha/prefetch     → opt-in prefetch plugin (Barba-style — core is small, prefetch is optional). Includes nav-link warmup and critical image warming.
@mimetic/pusha/islands      → Section Rendering API revalidation for stale-prone regions
@mimetic/pusha/diagnostics  → dev-mode warnings (stripped in production builds)
```

Seven subpaths. Each maps to its own source file. `package.json` `exports` field declares all of them. TypeScript types per entry. Path A's UMD build (`dist/pusha.min.js`) bundles all of them and registers on `window.Pusha`.

### Versioning

- **`0.1.0`** ships first. Breaking changes allowed in 0.x minors. Themes pinning a major version are explicitly opting into churn until 1.0.
- **`1.0.0`** when at least one external consumer (Dawn-ported site) has run live for ~2 weeks with no contract issues. Don't ship 1.0 just to ship 1.0 — wait for production validation.
- **Post-1.0**: major bumps for breaking changes to `window.theme.*`, hook names, event names, or `sectionInits` shape. Minor for additions. Patch for bug fixes.
- **Migration guide** required for any 1.x → 2.x change. A `npx @mimetic/pusha migrate <from> <to>` tool is *not* a v1 requirement — manual migration docs are enough until breaking changes become frequent.

### Maintenance tradeoff

Pre-ported Dawn/Horizon forks need a "re-apply skill against upstream main" workflow to stay current with Shopify's reference themes. Plan this as part of the skill's design — the skill should be runnable against an already-ported theme idempotently and against a fresh upstream merge.

## Distribution paths — A + B, with C as a separate future project

The Pusha runtime ships as a single npm package with two consumer entry points:

- **A — Drop-in vendor file**: pre-bundled UMD (`dist/pusha.min.js`) consumers drop into `theme/assets/`. Aimed at theme devs working without a build pipeline. Registers `window.theme.*` globally.
- **B — NPM + build-integrated**: ESM entry (`import { registry } from '@mimetic/pusha'`) for themes with Vite/TS pipelines. Same source, different output.

The `pusha` skill ships *as part of Pusha's distribution* — it's not a separate product or a marketplace listing. The skill files (`SKILL.md`, `PATTERNS.md`) land at `node_modules/@mimetic/pusha/skill/` after `npm install`, and the `pusha audit` output points at them at every invocation. To wire them into a specific agent's discovery path:

```fish
pusha skill --print                # dump to stdout for manual paste
pusha skill --claude               # → .claude/skills/pusha/
pusha skill --cursor               # → .cursor/rules/pusha.md
pusha skill --aider                # → .aider-conventions.md (appended)
pusha skill --claude --cursor      # multiple agents in one shot
pusha skill --claude --global      # ~/ instead of project-local
```

Layered design: the `pusha audit` CLI is self-contained and prints transformation rules inline, so any agent that can read its output can do the mechanical buckets (E, F2, G, K) without ever loading the skill. The skill is enrichment — fuller decision trees, edge cases, cart-integration patterns, the orchestration procedure for delegating per-file work to worker agents.

### Shopify API context — opportunistic, not required

If the dev has independently installed Shopify's AI toolkit and connected Claude to their store (dev store or production), the skill detects the available Shopify API tools in the running session and uses them — for installed-apps visibility, theme app extension inspection, runtime script-tag detection. This is **an enhancement, not a prerequisite**. The skill works fine with only local file access; API context is just additional signal when it happens to be in the room.

Architecturally: the skill is BYO-agent (see `skill/SKILL.md`). The Shopify AI toolkit is a tool-supplier the agent may or may not have. The skill checks; doesn't depend.

### Path C — Shopify app — separate project, deferred

A merchant-facing Shopify app (Rails backend, theme app extension, App Store distribution) is on the long-term roadmap but **is a separate project, not v1 of Pusha**. It would reuse the same `pusha audit` CLI and PATTERNS.md the skill uses, but the build, billing, and review process are large enough investments that they shouldn't be conflated with the framework + skill work. Build A + B + skill. Validate the runtime on real themes. Revisit the merchant app question once the dev-facing pieces are proven.

**Design implication that survives**: worker prompts and `PATTERNS.md` should be writeable such that the same shape of worker could be invoked from a Rails backend someday. Don't bake Claude-Code-specific assumptions into the transformation prompts.

## Open questions still on deck

- **Bucket H in path C** — merchants can't triage H findings. The app needs deterministic completion (auto-resolve H to "skip + `data-no-transition`" + report). The skill is fine with "defer to human"; the app needs auto-resolution rules. Design these before building C. *Deferred with path C itself.*

(Cart API, versioning, hooks, and subpath exports — all resolved above. See "Runtime contract", "Cart is theme code", "Package exports", "Versioning".)

## Until there's code

- Don't fabricate commands (build, test, lint) in this file — add them when the tooling exists.
- Don't invent file paths under `src/` here either. Document the structure once it's chosen, not before.
- When docs solidify, keep the lifecycle/contract documentation consolidated here so consumers see the runtime contract in one place.
