# Script patterns the skill recognizes

Each pattern has: a detection rule, a classification bucket (safe / wrap / cleanup / hard), and an example transformation (or "no transformation needed").

The buckets:
- **safe** — works under PJAX as-is, no edit needed
- **wrap** — mechanical transformation, low risk
- **cleanup** — needs lifecycle additions (e.g. `disconnectedCallback`) before PJAX nav is reliable
- **hard** — module-level state, closures, or non-obvious globals; flag for human

---

## Runtime lifecycle (so wrappers make sense)

What `data-section-type` and `sectionInits[handle](root)` plug into. On every PJAX navigation Pusha runs this sequence:

1. Same-origin link click intercepted (or `Pusha.go(url)` invoked programmatically). `data-no-transition` and modifier-key clicks fall through to native nav.
2. Dispatches `pjax:before-nav` (cancelable); fires `onBeforeNav` hooks.
3. Fetches destination HTML — or serves from the hover-prefetch cache if warm. If a prefetch is still in flight, awaits it instead of firing a duplicate fetch.
4. Fires `onBeforeLeave`, removes any `[data-pusha-cleanup]` portal-to-body elements, starts the leave transition.
5. Parses the new document. Runs `syncHeadScripts` + `syncHeadStyles` (preserving `type="module"`, `crossorigin`, `nonce`, etc.). Updates `<title>`, meta tags, `<body data-template>`.
6. Replaces `#MainContent` (or whatever `containerSelector` resolves to). Browser upgrades any custom elements in the swapped subtree automatically.
7. Calls `window.theme.initPage(newContainer)`, which:
   - Runs `registry.setupGlobal()` once for any newly-registered components.
   - Walks `newContainer.querySelectorAll('[data-section-type]')` and calls `window.theme.sectionInits[handle](root)` for each match.
   - Fires `onAfterSwap` → `onAfterInit` hooks and the legacy `pjax:content-swap` event.
8. Fires the analytics bridges — a prefixed `pusha:page_viewed` custom event (the only publish path that reaches Web Pixels), plus `Shopify.analytics.page()` or `ShopifyAnalytics.lib.page()` for admin reporting, never both. Publishing under standard event names is rejected by the platform, so Pusha does not attempt it; see README "Analytics & tracking". Then a11y focus + screen-reader announcement of the new title.
9. For cached navs, revalidates `[data-island]` sections via Shopify's Section Rendering API in the background.

What this implies for wrappers:

- `sectionInits[handle]` re-fires for **every matching root** on the page (a section may appear multiple times) and for **every PJAX swap** — plus the theme editor's `shopify:section:load`. Bodies must be idempotent via `data-initialized` guards.
- The function takes one `root` argument. Never `document.querySelector` — always `root.querySelector` so the same handle handles multiple instances on a single page.
- The JS file itself loads only once across the session. Module-level state survives across navs; if you need per-handle one-shot initialization (e.g. attaching a delegated document listener), guard it with `window.theme.__inits[handle]`.
- Theme editor lifecycle: idempotency requirements dovetail with Shopify's `shopify:section:load` / `shopify:section:unload`. Any `sectionInits[handle](root)` body must be safe to call on replace, not just on PJAX nav.

### Hook registration is order-independent (Path A adapters)

Path A adapters typically load via `<script src="pusha-adapter.js" defer></script>` placed **after** `pusha.min.js` in `layout/theme.liquid`. Pusha's runtime self-bootstraps synchronously on its own defer-script execution, which means **the adapter's script runs after Pusha has already booted**.

The hook contract is designed for this:

- `onAfterSwap` / `onAfterInit` / `onBeforeNav` / `onBeforeLeave` / `onNavError`: late registration is fine — these fire repeatedly on every nav, so handlers added after boot pick up from the next swap.
- **`onFirstLoad`** fires exactly once, at boot. Late registration is also fine: if the boot-time fire has already happened, the handler is invoked immediately at registration time with the current container. Adapters never need to call their update function manually for the initial-load case.

Recommended adapter shape:

```js
(function () {
  function update() { /* re-derive state from the live DOM */ }
  if (window.Pusha) {
    window.Pusha.onAfterSwap(function () { update(); });
    window.Pusha.onFirstLoad(function () { update(); });
  } else {
    // Pusha absent (PJAX disabled or load order broken) — run once.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', update, { once: true });
    } else {
      update();
    }
  }
})();
```

The `else` branch is a defensive fallback for the rare case where the adapter loads but the runtime didn't (debug builds, partial installs). On any normal Pusha install, the `if (window.Pusha)` branch is the only one that runs.

---

## A. External `<script src="...">` — **safe**

### Detect
```regex
<script[^>]+src=["'][^"']+["'][^>]*>\s*</script>
```

### Why safe
Pusha's `syncHeadScripts` compares `<script src>` tags in fetched HTML against the live document on every PJAX swap and loads new ones before `initPage()` runs. External scripts are loaded once, cached by the browser, and remain available for the lifetime of the SPA session.

### Transform
None.

### Example
```liquid
<script src="{{ 'theme-editor.js' | asset_url }}" defer="defer"></script>
```
Leave as-is.

---

## B. JSON data `<script type="application/json">` — **safe**

### Detect
```regex
<script[^>]+type=["']application/json["'][^>]*>
```

### Why safe
Non-executable. Consumed by `querySelector` + `JSON.parse` from a sibling component. As long as the consumer runs inside `init(root)` and queries within `root`, this needs no change.

### Transform
None.

### Example
```liquid
<script type="application/json" data-selected-variant>
  {{ product.selected_or_first_available_variant | json }}
</script>
```
Leave as-is.

---

## C. Custom element with `disconnectedCallback` — **safe (verify)**

### Detect
A `class … extends HTMLElement` with both `connectedCallback` and `disconnectedCallback` methods, registered via `customElements.define`.

### Why mostly safe
The browser fires `connectedCallback` when the element enters the DOM and `disconnectedCallback` when it leaves — including when PJAX swaps `#MainContent`. If `disconnectedCallback` properly removes listeners attached to `window`, `document`, and `IntersectionObserver` / `ResizeObserver` instances, the element is PJAX-safe natively.

### Manual audit checklist
- Every `window.addEventListener` in `connectedCallback` has a matching `removeEventListener` in `disconnectedCallback`
- Every `document.addEventListener` likewise
- Every observer (`new IntersectionObserver(...)`, `new MutationObserver(...)`, `new ResizeObserver(...)`) has a `.disconnect()` call
- Every `setInterval` / `setTimeout` has a matching `clear*` call
- No references to the element are stored on `window`, `document`, or module-scope variables that outlive disconnection

### Transform
None — but flag the file for manual cleanup-completeness review.

---

## D. Custom element WITHOUT `disconnectedCallback` — **cleanup**

### Detect
A `class … extends HTMLElement` with `connectedCallback` but no `disconnectedCallback`, that also attaches listeners to `window`, `document`, or creates observers.

### Why broken
Listeners survive after the element leaves the DOM. On PJAX nav, the next page re-instantiates the element, and now you have two listeners. Memory leak + duplicate handlers.

### Transform
Add a `disconnectedCallback` that mirrors every external attachment from `connectedCallback`. Store handler references as instance properties so they can be removed.

### Example
**Before:**
```js
class StickyHeader extends HTMLElement {
  connectedCallback() {
    window.addEventListener('scroll', () => this.onScroll());
    this.observer = new IntersectionObserver(/* ... */);
  }
}
```

**After:**
```js
class StickyHeader extends HTMLElement {
  connectedCallback() {
    this.onScrollHandler = () => this.onScroll();
    window.addEventListener('scroll', this.onScrollHandler);
    this.observer = new IntersectionObserver(/* ... */);
  }
  disconnectedCallback() {
    window.removeEventListener('scroll', this.onScrollHandler);
    this.observer?.disconnect();
  }
}
```

---

## E. Procedural inline `<script>` in section/snippet — **wrap**

### Detect
`<script>` tag without `src` attribute, not `type="application/json"`, inside a `.liquid` file under `sections/` or `snippets/`. Contains executable code that runs at parse time.

### Why broken
Inline scripts run once on initial page parse. After a PJAX swap, the new section's inline script is parsed but the browser will not execute injected `<script>` tags inserted via `innerHTML`. Even if `syncHeadScripts` covered them (it doesn't — it only handles `<head>`), they'd re-run with stale closures.

### Transform
1. Add `data-section-type="<handle>"` to the section's root element. Use the section file's basename (without `.liquid`) as the handle.
2. Move the script body into `window.theme.sectionInits[handle] = function(root) { ... }`.
3. Replace `document.querySelector` / `document.getElementById` with `root.querySelector` / `root.getElementById`.
4. Replace `document.querySelectorAll` likewise.
5. Add `data-initialized` idempotency guards on per-element listener attachments.

### Example
**Before** (`sections/announcement-bar.liquid`):
```liquid
<div class="announcement-bar">
  <p>{{ section.settings.text }}</p>
</div>
<script>
  document.querySelector('.announcement-bar p').addEventListener('click', () => {
    console.log('clicked');
  });
</script>
```

**After:**
```liquid
<div class="announcement-bar" data-section-type="announcement-bar" data-section-id="{{ section.id }}">
  <p>{{ section.settings.text }}</p>
</div>
{% javascript %}
  window.theme = window.theme || {};
  window.theme.sectionInits = window.theme.sectionInits || {};
  window.theme.sectionInits['announcement-bar'] = function(root) {
    var p = root.querySelector('p');
    if (!p || p.dataset.initialized) return;
    p.dataset.initialized = 'true';
    p.addEventListener('click', function() {
      console.log('clicked');
    });
  };
{% endjavascript %}
```

### Why `{% javascript %}` and not inline `<script>`

The transformation uses `{% javascript %}` rather than keeping the `<script>` tag. Reason: Shopify concatenates all `{% javascript %}` blocks from sections rendered on the current page into a single deferred `scripts.js` file loaded via `<head>`. PJAX's `syncHeadScripts` picks up new `scripts.js` versions on every nav, ensuring the assignment to `window.theme.sectionInits[...]` is available *before* `initPage()` runs.

Inline `<script>` tags injected via PJAX swap (innerHTML / replaceWith) **do not execute** — the browser only runs scripts inserted via proper DOM APIs like `document.createElement('script')`. So an inline `<script>` in a swapped section would run on first load only and never again. `{% javascript %}` sidesteps this entirely.

### Hard Shopify constraints on `{% javascript %}` the skill must respect

These come from Shopify's documented section-tag rules. Workers MUST NOT violate them:

1. **One `{% javascript %}` tag per section/snippet file.** Multiple tags in one file are invalid. If a section already has a `{% javascript %}` block, the worker must either:
   - Append the wrapped logic to the existing block (preserving its scope and order), OR
   - Return SKIP and let a human merge them. *Appending is safe only when the existing block's code doesn't conflict with the wrapper structure. When in doubt, SKIP.*

2. **Liquid is NOT evaluated inside `{% javascript %}`.** Variables like `{{ section.settings.foo }}` will render as literal text and break the JS. If the wrapped script reads Liquid-backed values, the worker must:
   - Move those values into HTML `data-*` attributes on the section root (where Liquid IS evaluated)
   - Have the JS read them from `root.dataset.*` instead

   Example:
   ```liquid
   {# Liquid-backed value as data attribute #}
   <div data-section-type="my-section" data-bg-color="{{ section.settings.bg_color }}">

   {% javascript %}
   window.theme.sectionInits['my-section'] = function(root) {
     var bgColor = root.dataset.bgColor;  // read from DOM, not Liquid
     // ...
   };
   {% endjavascript %}
   ```

   The worker MUST scan the source script for `{{` or `{%` tokens before wrapping. If found, the worker either rewrites them to data attributes or returns SKIP for human review.

3. **`{% stylesheet %}` follows the same single-tag rule.** Not relevant to the wrap pattern itself but worth knowing — section CSS bundling has the same constraint.

4. **Never write the literal strings `{% javascript %}` or `{% endjavascript %}` inside a `{% comment %}` block, doc block, or anywhere else in a section file.** Shopify's section JS compiler scans the file as text for these tags — it does NOT respect `{% comment %}` boundaries. A comment that says "the `{% javascript %}` block fires once at parse" will have its prose concatenated into the compiled `scripts.js` bundle, producing a JS parse error like `Uncaught SyntaxError: Unexpected identifier 'once'` and breaking *every* section's registration on the page (single bundle, single failure point).

   Refer to the tag in prose ("the section JS block", "the wrapped JS body", "the JS tag") — never paste the literal Liquid syntax into commentary. The same applies to `{% stylesheet %}` / `{% endstylesheet %}`.

   **Bad:**
   ```liquid
   {% comment %}
     The {% javascript %} block below registers the handler.
   {% endcomment %}
   {% javascript %}
     window.theme.sectionInits['foo'] = function (root) { ... };
   {% endjavascript %}
   ```
   The compiler sees TWO `{% javascript %}` openers and ONE closer, splices the comment text in, and emits broken JS.

   **Good:**
   ```liquid
   {% comment %}
     The section JS block below registers the handler.
   {% endcomment %}
   {% javascript %}
     window.theme.sectionInits['foo'] = function (root) { ... };
   {% endjavascript %}
   ```

   This is exactly the kind of bug `shopify theme check` (SKILL.md Step 5a) catches — the compiled `scripts.js` fails to parse, every section's `sectionInits` registration silently disappears, and the runtime symptom is `[pusha/init] no sectionInits handler for "<handle>"` across multiple handles with no other error.

### Cross-file dependencies inside the wrapped script

If the wrapped script instantiates or invokes a class defined elsewhere (e.g. `new CustomerAddresses()` where `CustomerAddresses` is in `assets/customer.js`), the wrap makes the *call site* PJAX-safe — but the external class itself may still have issues:

- It may use `document.querySelector` instead of accepting a root scope
- It may attach listeners to `window` / `document` with no cleanup
- It may hold module-level state

**The worker rule:** don't follow the reference into the other file. Add the wrap at the call site, then add a manifest entry flagging the external class for a follow-up audit. The follow-up classification will land it in bucket C / D (custom element, needs cleanup) or H (module state). Single-file edits stay single-file.

**Example manifest line:**
```
DEFERRED: assets/customer.js (referenced from sections/main-addresses.liquid)
  Reason: external class CustomerAddresses instantiated in wrapped script.
  Action: separate audit pass to classify customer.js and resolve.
```

---

## F. `{% javascript %}` block — **wrap (unless custom element)**

### Detect
`{% javascript %}` … `{% endjavascript %}` tags inside a `.liquid` file.

### Two sub-cases

**F1. Contains a `class … extends HTMLElement` definition** — treat as bucket C or D (the class itself owns lifecycle). No wrapping needed; just verify `disconnectedCallback` is correct.

**F2. Procedural code** — same transformation as bucket E.

### Why F1 is safe
`{% javascript %}` blocks are concatenated into `scripts.js`, served from `<head>` as deferred. `syncHeadScripts` loads new ones on PJAX nav. The `customElements.define` call only registers a class globally; subsequent definitions of the same tag name are no-ops. So the class is defined once and used every time the element appears, including after PJAX swaps.

---

## G. `DOMContentLoaded` handler — **wrap**

### Detect
```regex
document\.addEventListener\(['"]DOMContentLoaded['"]
window\.addEventListener\(['"]DOMContentLoaded['"]
```
or `$(document).ready(...)` if jQuery is in play.

### Why broken
`DOMContentLoaded` fires once per full page load. PJAX nav does not refire it. Any logic gated on it runs only on first arrival.

### Transform
Same as bucket E: move handler body into `sectionInits[handle](root)`. The section's wrapper guarantees the body re-runs on every navigation.

---

## H. Module-level state / closure state — **triage required**

### Detect
- Real IIFE: opening `(function() {` or `(() => {` with **closing invocation** `})()` somewhere in the file (`pusha audit` requires the trailing `\}\s*\)\s*\(\s*\)` to avoid false-matching plain arrow callbacks)
- Top-level mutation: `window.X = …` or `document.X = …` at module scope
- Module-scope `let` / `const` / `var` mutated by event handlers
- Singleton patterns (`if (window.MyThing) return; window.MyThing = …`)

### Why hard
The wrapping pattern re-runs `init(root)` on every PJAX nav. If a script depends on module-level state being initialized exactly once, naive wrapping will either re-initialize and clobber the state, or skip initialization on the second nav because the singleton guard returns early.

### Resolving an H finding — triage tree

For each H file, the human (or the skill on their behalf) asks **one question first**, then picks one of four resolutions. The default is option 1.

> **What state does this script hold, and at what scope?**

#### Option 1 — Global + stateless OR global + idempotent state → **lift to `window.theme.<feature>`** (DEFAULT)

The majority of H findings end here. The script's state is genuinely global (singleton listener, shared cache, one-time initialization), not per-element. Resolution: keep the script where it is, but gate its top-level work behind a one-time flag on `window.theme.__inits`.

Example — a script that attaches one delegated click handler to `document`:

```js
window.theme = window.theme || {};
window.theme.__inits = window.theme.__inits || {};
if (!window.theme.__inits.autoCloseDetails) {
  window.theme.__inits.autoCloseDetails = true;
  document.addEventListener('click', /* delegated handler */);
}
```

The listener lives on `document` and survives PJAX. The guard prevents re-attachment on subsequent inits. No build pipeline required — this is plain JS in the asset file or wrapped in `sectionInits`.

For state (caches, registries):

```js
window.theme.cache = window.theme.cache || new Map();
// use window.theme.cache instead of a module-local Map
```

This is the *default* resolution. Only escalate to options 2–4 when option 1 doesn't fit.

#### Option 2 — Per-element instance state → **promote to custom element**

The script hangs state off each matching DOM element (animation controllers, intersection observers per element, per-instance configuration). Resolution: wrap as a custom element. The browser handles lifecycle natively, and the file reclassifies from H to C.

```js
class Marquee extends HTMLElement {
  connectedCallback() {
    this.observer = new IntersectionObserver(/* ... */);
  }
  disconnectedCallback() {
    this.observer?.disconnect();
  }
}
customElements.define('pusha-marquee', Marquee);
```

More work than option 1 but produces the cleanest result. Appropriate when state is genuinely per-instance and the script already operates on a clear element type.

#### Option 3 — Complex + high-value + theme has a Vite pipeline → **lift to TypeScript component**

Only when the theme already has the build pipeline AND the component is worth the investment. Lift the script into `src/components/<name>.ts`, type it, register it with the TypeScript registry. This is the "Path B native" route — appropriate for themes that already own a build, but an *upgrade path* not a default for Pusha.

Cost: pulls the theme into a build-tool dependency just to fix one script. Only worth it for high-value components that benefit from typing and the full registry lifecycle (`setupGlobal` / `init` / `destroy`).

#### Option 4 — Risky + low-value → **exclude from PJAX with `data-no-transition`**

The escape hatch. Add `data-no-transition` to all links targeting pages where the script runs. Document why in a comment at the top of the script. The page does a full browser navigation; the script runs as it did pre-PJAX. PJAX is degraded for that route only.

Appropriate for:
- Theme-editor-only scripts (theme editor already disables PJAX anyway, so this is effectively a no-op)
- Legacy or vendor scripts that aren't worth porting
- Scripts that work but you don't have time to audit fully — ship the exclusion, port later

Always include a `// PUSHA-PORT: excluded — <reason>` comment so the next pass knows whether to revisit.

### Choosing between options 1–4

**The one-line heuristic** — read the script and ask: *does any closure-local state need explicit cleanup?* (IntersectionObserver, MutationObserver, ResizeObserver, setInterval/setTimeout holding element refs, anime.js / GSAP animations targeting elements, manually-attached non-delegated listeners on container children)

- **Yes → Option 2.** The custom-element `disconnectedCallback` is the right home for the cleanup. Anything else requires manual lifecycle plumbing in the wrapper.
- **No → Option 1.** The script is either stateless or holds idempotent global state. Wrap with `sectionInits` or a one-time guard on `window.theme.__inits` and you're done.

Options 3 and 4 are escalations from those defaults, not first choices.

| Signal | Resolution |
|---|---|
| One delegated listener on `document` | 1 |
| Module-level cache / registry used globally | 1 |
| Closure-local state with no cleanup needs (per-call function scope is fine) | 1 |
| IntersectionObserver / MutationObserver / ResizeObserver in closure | 2 |
| setInterval / setTimeout holding element refs | 2 |
| anime.js / GSAP animations on container elements | 2 |
| Direct (non-delegated) listeners on container children | 2 |
| Already a Vite/TS theme + worth the typing | 3 |
| Editor-only or low-value | 4 |
| Don't know yet | 4 (temporarily), revisit later |

### Common false-positive shapes — bucket H triages as "no action"

Some H findings are structurally similar to whitelisted Pusha patterns but aren't covered by the whitelist's regex. The audit deliberately doesn't try to anticipate every "stateless namespace" shape — false-positive *suppression* would risk hiding real H findings, so confirmation is the agent's job during triage. When confirmed safe, record the verdict in `pusha-diffs/<theme>/MANIFEST.md` so the next audit pass has a baseline.

Known shapes that audit-as-H but typically triage as Option 1 (global + idempotent, no transform):

**Namespace assignment.** `window.<Name> = { method1, method2 }` where the RHS is an object literal containing only function-valued keys — no top-level state, no module-local closures captured into properties. The methods themselves can be stateless or idempotent. Dawn's `assets/product-model.js` is the canonical example:
```js
window.ProductModel = {
  setupShopifyXR(...) { /* idempotent */ },
  loadShopifyXR(...) { /* idempotent */ },
};
```
Triage steps: confirm no closure-local state, confirm methods are safe to re-call. Record as resolved-no-action.

**Top-level Pusha hook registration.** `window.Pusha.onAfterSwap(boot)` or `window.Pusha.onFirstLoad(boot)` called at module scope, with `boot` responsible for its own idempotency. Same triage — confirm `boot` is re-entrant, record as resolved-no-action. (The G whitelist already covers the typical `addEventListener('DOMContentLoaded', ...)` fallback alongside these registrations; the registration line itself fires H.)

These patterns will keep showing up on every audit — that's intentional. The skill's job is to recognize them and document the verdict, not to expand the whitelist to make them disappear. The audit's signal is "human glanced at it"; the MANIFEST records that the glance happened.

### Reachability — confirm the file is actually used before triaging

The audit script annotates each H finding with a reachability check: `(reachable via N ref(s))` or `(no references found — possibly dead code)`. Before applying any of options 1–4 to an H file, confirm it's reachable. Orphan files (e.g. an original section that's been replaced by a differently-prefixed customized fork of it) shouldn't be ported — they should be deleted in a separate cleanup pass.

Reachability rules the audit currently checks:

- **Section files** (`sections/<name>.liquid`): referenced via `"type": "<name>"` in `templates/*.json` or `sections/*.json` section groups, or via `{% section '<name>' %}` in any `.liquid` file.
- **Asset JS files** (`assets/<name>.js`): referenced via the filename string appearing in any `.liquid` file (typically as `{{ '<name>.js' | asset_url }}`).

The audit currently runs this check only for H findings, since H is the expensive triage bucket. A–G transformations are mechanical regardless of reachability — but you may want to grep for reachability on cleanup-candidate D files too, for the same reason.

**Reachability is heuristic, not authoritative.** False negatives (file flagged dead but actually used) can happen when:

- Asset is loaded via a snippet that constructs the script tag dynamically (`{% render 'script-loader', name: 'foo' %}` where the snippet does `<script src="{{ name | append: '.js' | asset_url }}">`)
- Section is referenced programmatically via dynamic section names
- File is loaded only in specific theme editor contexts or under feature flags

Treat "(no references found)" as a *hint to investigate*, not a green light to delete. The audit never auto-removes anything; deletion is always human-driven.

### What the skill writes when it can't decide

For bucket H, the skill's automated transform pass **does not edit the file**. It writes a comment at the top:

```js
// PUSHA-PORT: bucket H — module-level state detected. Triage required.
// See pusha/skill/PATTERNS.md "Resolving an H finding" for the decision tree.
// Detected indicators: <list>
```

And the audit manifest records the file under `deferred: { reason: "H", indicators: [...] }`. The user runs the triage themselves or invokes the skill again with a `--resolve-h` flag (future work) that asks per-file.

---

## L. Liquid persistent state — **per-request Liquid in the layout shell**

### Detect

Liquid that evaluates per-request — `request.*`, `template.*`, `link.current`/`link.child_active`, `customer.*`, `cart.*`, `localization.*`, `'now' | date`, etc. — when it appears in files that render **outside `#MainContent`** and therefore don't re-render on PJAX nav. These files:

- `layout/theme.liquid` (always — the shell itself)
- `sections/*.liquid` listed in section-group JSON files (`sections/header-group.json`, `sections/footer-group.json`, `sections/aside-group.json`, any group that isn't the main content group)
- `snippets/*.liquid` rendered transitively from either of the above

### Why broken

Pusha only swaps the `#MainContent` element on PJAX nav. Everything else — header, footer, body class, `<head>` aside from the synced meta tags — is the same DOM that loaded on the first request. Any Liquid value in those regions reflects the request context of the **first page the user landed on**, not the current URL.

Concrete symptoms:
- Nav menu's "current page" highlight stuck on `/` after navigating to `/collections/all`.
- `<body class="template-product">` persists across product → collection nav, breaking CSS selectors keyed off the template class.
- Header announcement bar shows the "home page" variant on every subsequent page.
- Cart count badge doesn't update after add-to-cart (this one's usually already JS-driven, but if the theme leans on `{{ cart.item_count }}` alone, it freezes).
- `aria-current="page"` set by `link.current` is stuck — accessibility regression.

### Sub-categorization (mirrors the request-scoped Liquid taxonomy)

Each L finding gets a sub-letter matching the taxonomy categories in `reference-request-scoped-liquid-taxonomy` memory:

| Sub | What | Recommended action | Rank |
|---|---|---|---|
| **L-A** | URL/template (`request.*`, `template.*`, `link.current/active/child_active`) | Client-side re-derive on `onAfterSwap` (URL is the only input) | 🟡 Auto-mitigation available |
| **L-B** | Customer-derived (`customer`, `customer.*`, `customer_logged_in`) | Treat auth state transitions as reload boundaries (already excluded from PJAX since Pusha v0.1+); otherwise leave header customer UI to theme JS | 🟠 Query user |
| **L-C** | Cart-derived (`cart.*`) | Already covered by `cart:mutated` event + theme-side cart JS — confirm theme dispatches `cart:mutated` | 🟢 No action / verify |
| **L-D** | Locale/currency (`localization.*`, `request.locale`, `cart.currency`) | Locale changes are full nav (Pusha v0.1+ excludes `/localization`); no per-nav action needed | 🟢 No action |
| **L-E** | Section/block reading per-page objects (`product`, `collection`, `article` inside a header/footer section) | Query user — either move the section into the main container or section-refetch | 🟠 Query user |
| **L-F** | Personalization (`recommendations.*`, `predictive_search.*` in header/footer) | Predictive search is already Ajax-driven; recommendations in persistent shell = section-refetch | 🟠 Query user |
| **L-G** | Time-of-render (`'now' | date`, `'today' | date`) | Cosmetic (footer year): leave. Logic-bearing (countdowns): rewrite in JS | 🟢 No action (cosmetic) / 🔴 Defer (logic) |
| **L-H** | App-injected blocks reading per-page state (`{% content_for 'block' %}` in header/footer; theme app extension blocks reading `request`/`product`/`cart`) | Re-dispatch a route-change event the app block can listen for; Pusha's existing `pjax:content-swap` event already carries `url`/`template` detail | 🟠 Query user |

### Transform

Bucket L doesn't have one mechanical transformation like buckets E/F/G. The action depends on the sub-category. Three patterns cover most cases:

**1. Client-side re-derive (covers L-A and the URL-derived majority).**

Use Pusha's built-in `initActiveLinks` instead of hand-rolling the loop. It already wires `onAfterSwap`, syncs the body `template-*` class, and walks any `[data-pusha-active-links]` container to toggle per-link state — both with sensible defaults AND with per-element overrides for themes whose CSS already uses theme-specific active-state class names.

```js
import { initActiveLinks } from '@mimetic/pusha/active-links';
initActiveLinks();
```

Then opt nav containers and links into the toggle via Liquid edits:

```liquid
{# Opt-in container marker — links inside this get re-derived per swap. #}
<nav data-pusha-active-links>
  {%- for link in section.settings.menu.links -%}
    {# Default behavior: link gets `is-current` (exact match) or `is-ancestor` (prefix match). #}
    <a href="{{ link.url }}">{{ link.title }}</a>

    {# Override with a theme-specific class for "exact match" (replaces is-current). #}
    <a href="{{ link.url }}" data-pusha-current-class="menu-item--current">{{ link.title }}</a>

    {# Override for "current OR ancestor" (replaces is-current AND is-ancestor). #}
    <a href="{{ link.url }}" data-pusha-active-class="menu-item--active">{{ link.title }}</a>
  {%- endfor -%}
</nav>
```

For the "highlight the parent menu item if any child link is current" pattern (mega-menu / drawer / dropdown), mark the wrapper element:

```liquid
<details>
  {# When the current URL matches ANY <a> inside this <details>, the summary gets the class. #}
  <summary data-pusha-child-active-class="menu-item--active">Catalog</summary>
  <a href="/collections/all">Collections</a>
  <a href="/collections/sale">Sale</a>
</details>
```

Scope resolution for `data-pusha-child-active-class`: nearest `<details>` ancestor → nearest `<a>` ancestor → the `[data-pusha-active-links]` container. This handles both Dawn's `<details><summary>` mega-menu shape and the "span inside the parent anchor" leaf-level shape.

**Why the overrides matter**: most existing themes have CSS keyed off theme-specific class names like `mega-menu__link--active` or `menu-drawer__menu-item--active`. The override attributes let the theme keep its CSS untouched while the active-state class still re-derives on every PJAX nav. Without overrides, porting would require renaming class names across the theme's CSS, which is invasive and risky.

**Liquid → JS migration rule**: any time a port removes a `{% if link.current %}…{% endif %}` block that toggles a class on the rendered `<a>`, the equivalent class name goes into `data-pusha-current-class="…"` on that same `<a>`. Same for `link.active` → `data-pusha-active-class`. Same for `link.child_active` on a wrapper element → `data-pusha-child-active-class` on that same wrapper. The audit's L-A regex (`\b\w*link\.(current|active|child_active|child_current)\b`) catches both the top-level `link` and nested loop variables (`childlink`, `grandchildlink`) — apply the same migration to all of them.

Themes opt in by tagging their nav containers: `<nav data-pusha-active-links>...</nav>`. The skill adds this attribute during the port and replaces `link.current` / `link.child_active` Liquid conditionals with structural class names the helper toggles.

**2. Section Rendering API refetch (covers L-B, L-E, L-F, L-H — anything not URL-derived).**

Mark a persistent section with `data-island-on-nav` (extending the existing `data-island` semantics outward) so Pusha refetches it via `/path?sections=section-id` on every PJAX nav and morphs the result into the existing DOM. Cost: one extra request per nav per island. Use sparingly — for the cart-count badge, customer welcome message, or app blocks reading per-page state.

**3. Mark as reload boundary.**

For L-B auth flows specifically: add the relevant route to `data-no-transition` (the skill's bucket H/K escape hatch) so the link forces a full nav, refreshing the persistent shell's `customer.*` state. Pusha already excludes `/account/login`, `/account/register`, `/account/logout`, `/account/recover`, `/account/activate`, `/customer_authentication/*`, `/localization` from PJAX (`SHOPIFY_RESERVED` in `src/runtime.ts`).

### Audit output

Bucket L findings render with the sub-letter and rank visible, so the orchestrator and user can scan at a glance:

```
## L. Liquid persistent state — request-scoped Liquid in the layout shell
  Files outside #MainContent freeze on first load. Each finding categorized
  by request-scope type (A=URL, B=customer, C=cart, D=locale, E=per-page
  section, F=personalization, G=time, H=app-injected).

  layout/theme.liquid:14   [L-A 🟡 auto]   <body class="template-{{ template.name }}">
  layout/theme.liquid:8    [L-A 🟡 auto]   <link rel="canonical" href="{{ request.origin }}{{ request.path }}">
  sections/header.liquid:42  [L-A 🟡 auto]  {% if link.current %} ... {% endif %}
  sections/header.liquid:18  [L-B 🟠 ask]   {% if customer %} ... {% endif %}
  sections/header.liquid:55  [L-C 🟢 ok]    {{ cart.item_count }} — confirm cart:mutated wired
  sections/footer.liquid:88  [L-G 🟢 ok]    {{ 'now' | date: '%Y' }} (cosmetic — leave)
```

### Worker interaction

Bucket L is not a worker-mechanical bucket like E/F/G. The orchestrator queries the user per finding (or per sub-bucket batch) for cases ranked 🟠 ask. The auto-mitigations (🟡) get applied via a single helper drop-in plus theme-side attribute additions. The 🟢 cases get a one-line note in the manifest and no diff.

### Scope confirmation

For a section file to count as "persistent shell", it must be:
- Listed in a section-group JSON file *other than* the main content group, OR
- Rendered from `layout/theme.liquid` directly via `{% section %}` (older pattern, deprecated by section groups), OR
- A snippet rendered transitively from either of the above.

The audit determines this by parsing `sections/*-group.json`, building a section-membership set, and excluding any section whose group is the main content group (typically the one rendering `content_for_layout` / `#MainContent` — detected by reading `layout/theme.liquid`).

---

## M. Persistent-shell stateful UI — **close-on-nav opt-in**

### Detect

UI elements in `layout/`, section-group sections, or transitively-rendered snippets that hold an open/closed state and were authored assuming a full reload would dismiss them. The audit surfaces:

- `<details>` elements (Dawn-style click-toggle — the biggest single source)
- `<dialog>` elements
- Custom elements whose tag name matches `\w+-(modal|drawer|overlay|popup|search-form|menu-drawer)`
- JS code in `assets/*.js` that calls `document.body.classList.add('overflow-hidden' | 'menu-open' | ...)` — body classes survive PJAX swaps and can lock scroll on the next page

### Why broken

PJAX swaps only `#MainContent`. The shell's DOM, including any modal that's been toggled open, is the *same DOM* on the next page. Authors didn't notice because they tested by clicking links and the modal disappeared — but it disappeared because the browser reloaded the whole page, not because the modal closed itself.

Concrete symptoms in Dawn (verified 2026-05-14):
- Predictive search overlay stays visible after clicking a result; the dark backdrop and search input persist until the user manually closes.
- Mobile menu drawer + `body.overflow-hidden` would persist if the theme had Pusha-aware nav inside the drawer (Dawn's drawer happens to do a full reload because its links don't carry `data-pusha` intent — but a Pusha-ported variant would expose the bug).

### Transform — three options, opt-in

Cart drawers and persistent widgets are real counter-examples: they intentionally survive PJAX nav. Generic "auto-close any modal on swap" would break that UX. So the contract is **opt-in by marker** — themes choose per-element.

**Option 1 — Marker on the modal root (recommended default).**

```liquid
{# Dawn predictive search — adapt the wrapper details element #}
<details
  id="Details-predictive-search"
  data-pusha-close-on-nav
  data-pusha-body-class-on-open="overflow-hidden scroll-locked"
>
  <summary>Search</summary>
  ...
</details>
```

Pusha's `onBeforeLeave` handler then applies the standard close shapes to every element with the marker:

| Detected | Action |
|---|---|
| `<details open>` | strip the `open` attribute |
| `<dialog open>` | call `el.close()` |
| `[aria-expanded="true"]` | set to `"false"` |
| `[aria-hidden="false"]` | set to `"true"` |
| `data-pusha-body-class-on-open="X Y"` | remove tokens `X` and `Y` from `<body>` |

**Option 2 — Custom element with `closeOnNav()` method.**

For complex modals with their own close animation, focus return, or state cleanup:

```js
class PredictiveSearch extends HTMLElement {
  // ...

  closeOnNav() {
    this.close();              // theme's existing close method
    this.input.value = '';     // any extra cleanup
  }
}
customElements.define('predictive-search', PredictiveSearch);
```

```liquid
<predictive-search data-pusha-close-on-nav>...</predictive-search>
```

When the marker is present **and** the element defines `closeOnNav()`, Pusha calls the method and skips the standard shapes — the theme owns the close behavior end to end. Body-class stripping (Option 1's `data-pusha-body-class-on-open`) still runs if declared, since that's a body-side concern the element can't reach as cleanly.

**Option 3 — Manual hook registration.**

Always available; no Pusha feature required:

```js
import { onBeforeLeave } from '@mimetic/pusha/hooks';
onBeforeLeave(() => myModal.close());
```

Useful when the modal isn't a custom element and can't carry a `data-` attribute, or when the close logic spans multiple unrelated elements.

### Counter-case — do NOT mark these

- **Cart drawer**: opens on add-to-cart, designed to stay open until the user closes it. Leave unmarked.
- **Persistent widgets** (chat bubbles, scroll-progress indicators): not modal in nature; close-on-nav would break the feature.
- **Sticky header / footer state** (e.g., `[aria-expanded]` on a "see more" toggle in the footer): debatable — usually the right call is to leave it open, since the user's expanded view should persist.

When in doubt, leave it unmarked. Opt-in is the safe default.

### Why M, not D or K

- **D** is about custom elements that need *destruction* (their JS holds observers/intervals/listeners). M elements don't necessarily need destruction — they just need their visual state reset.
- **K** is about elements that *escape the swap container by portaling to body*. M elements stay inside the persistent shell; their problem is that the shell isn't swapped at all.
- An element can hit M *and* K (a modal that portals AND has open state) — both transforms apply: `data-pusha-cleanup` removes the portal node, `data-pusha-close-on-nav` resets the in-shell trigger's state. Treat them as orthogonal markers.

---

## Section handle derivation

For sections, use the filename without extension: `sections/announcement-bar.liquid` → `announcement-bar`.

For snippets included inside sections, the handle is the *including section's* handle. Snippets don't get their own `data-section-type` — they piggyback on the parent section's root and init function.

Exception: if a snippet is rendered standalone (e.g. `cart-drawer.liquid` rendered in `theme.liquid` outside `#MainContent`), it gets its own handle and lives outside the PJAX swap container entirely — its init runs once on first load and never again.

---

## Idempotency guards — the universal pattern

Every `init(root)` body must be safe to call multiple times against the same DOM. Two reasons:
1. The Shopify theme editor's `shopify:section:load` event re-fires init even without a PJAX nav.
2. The skill's idempotency check (Step 5 in `SKILL.md`) re-runs the audit on the patched theme.

Guard pattern:
```js
const el = root.querySelector('[data-foo]');
if (!el || el.dataset.initialized) return;
el.dataset.initialized = 'true';
// attach listeners, etc.
```

For document-level (delegated) listeners attached in the wrapper body, use a one-time flag on `window.theme.__inits`:
```js
window.theme.__inits = window.theme.__inits || {};
if (!window.theme.__inits['foo']) {
  window.theme.__inits['foo'] = true;
  document.addEventListener('click', /* delegated handler */);
}
```

---

## Cart-state integration

Pusha owns prefetch cache invalidation for routes that display cart state. It doesn't know when the cart mutates — the theme tells it via a single DOM event on `document`.

### The Pusha contract

```js
document.dispatchEvent(new CustomEvent('cart:mutated', {
  detail: {
    source: 'theme',                          // 'theme' | 'app' | 'pusha' | custom
    cart: cartJsonOrNull,                     // optional /cart.js snapshot
    lastOperation: {                          // optional
      type: 'add',                            // 'add' | 'update' | 'remove' | 'clear'
      line: { /* line item, if applicable */ },
    },
  },
}));
```

`source` is the only required field. `cart` and `lastOperation` are optional — publishers that don't have them at the dispatch site (e.g. bridging from an internal pubsub that doesn't carry a cart snapshot) may omit them. Subscribers must tolerate missing optionals.

**`cart:mutated` is additive to Shopify's cart APIs**, not a replacement. Themes and apps still call `/cart/add.js`, `/cart/change.js`, `/cart/update.js`, etc. as they always did. Pusha's event is an intra-theme *coordination* signal on top of those mutations — it tells subscribers (the prefetch invalidator, header cart count, mini-cart, app embeds) that the cart's state just changed, so they can refresh their view.

**Confirmed with Shopify devrel (2026-05-13):** there is no Shopify-documented intra-theme cart-state convention. Theme Store review evaluates user-visible cart behavior, not the JS contract. Dawn's `assets/pubsub.js` + `PUB_SUB_EVENTS` is Dawn's internal pattern, not a platform API. Pusha is defining its own contract here intentionally.

### Detection — does the theme need a bridge?

Audit step:

1. **Grep for `cart:mutated`** in `assets/`, `sections/`, `snippets/`, `layout/`. If found → bridge already wired, skip.
2. **Grep for cart mutation entry points** — most themes have one or more of:
   - `routes.cart_add_url`, `/cart/add.js`, `/cart/update.js`, `/cart/change.js`, `/cart/clear.js` in fetch calls
   - A shared cart helper (Dawn: `assets/cart.js`, `assets/cart-drawer.js`, `assets/cart-notification.js`; product-form: `assets/product-form.js`)
3. **Identify the theme's existing cart-event mechanism** (if any) — this determines which bridge variant to apply:
   - Pubsub convention: `assets/pubsub.js` exporting `subscribe`/`publish`, plus `PUB_SUB_EVENTS` in `assets/constants.js`. Originated in Dawn and inherited by most Dawn-derived themes — detect it by those two files, not by the theme's name.
   - Custom in-theme bus: search for `subscribers`, `eventBus`, `addObserver` etc.
   - No bus at all: theme fires-and-forgets `fetch('/cart/add')`, no UI subscription model — the bridge instruments the fetch directly.

### Variant 1 — pubsub bridge (themes shipping `assets/pubsub.js`)

The theme already has `pubsub.js` exposing `subscribe()` and `publish()` as globals, plus `PUB_SUB_EVENTS` from `constants.js` (`cartUpdate`, `quantityUpdate`, `variantChange`, `cartError`). Bridge it once on `DOMContentLoaded`:

```liquid
{# snippets/pusha-bridges.liquid — rendered from layout/theme.liquid after pubsub.js #}
<script>
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof subscribe !== 'function' || typeof PUB_SUB_EVENTS === 'undefined') return;
    subscribe(PUB_SUB_EVENTS.cartUpdate, (payload) => {
      document.dispatchEvent(new CustomEvent('cart:mutated', {
        detail: {
          source: payload?.source || 'theme',
          cart: payload?.cartData ?? null,
          lastOperation: payload?.variantId
            ? { type: payload.source === 'cart-items' ? 'update' : 'add', line: { variantId: payload.variantId } }
            : undefined,
        },
      }));
    });
  });
</script>
```

The skill renders this snippet by inserting `{% render 'pusha-bridges' %}` into `layout/theme.liquid` after the `pubsub.js` script tag and before `{% render 'pusha' %}`. Idempotency: skip if the bridge file already exists; warn if the include line is missing but the file isn't.

The mapping from Dawn's `payload` to Pusha's `lastOperation.type` is best-effort — Dawn's internal payload shape varies between `product-form.js` (`source: 'product-form'`) and `cart.js` (`source: 'cart-items'`). Where the type can't be inferred, omit `lastOperation`.

**Caveat — payload shape is version-dependent.** Dawn's `PUB_SUB_EVENTS.cartUpdate` payload is not strongly typed and has drifted between Dawn versions and across the forks that inherited it. Smoke-test the bridge on the actual theme version in use; if a payload field is missing on a given fork, fall back to dispatching `cart:mutated` with `source` only — subscribers must tolerate missing optionals (per the Pusha contract).

### Variant 2 — Theme without a pubsub (cart fetch instrumentation)

For themes that fire `/cart/add` etc. directly with no internal event bus, instrument the fetch wrapper or success handler in the theme's cart code. Audit identifies the fetch site and the skill adds a dispatch:

```js
// In the theme's cart code, in the .then() after a successful cart mutation:
fetch(routes.cart_add_url, { /* ... */ })
  .then((r) => r.json())
  .then((cart) => {
    // existing UI update
    document.dispatchEvent(new CustomEvent('cart:mutated', {
      detail: { source: 'theme', cart, lastOperation: { type: 'add' } },
    }));
  });
```

The skill marks each fetch site one at a time and inserts the dispatch in the appropriate `.then()` / `await` chain. Cross-file: if cart fetches live across several files (Dawn-style: `product-form.js` + `cart.js` + `cart-drawer.js`), each needs a dispatch — but in practice these themes have a pubsub and Variant 1 applies.

### Variant 3 — App-block participation

App-block scripts that mutate the cart (e.g. an upsell app that does its own `/cart/change`) should dispatch `cart:mutated` the same way after success. They're third-party code — the skill doesn't transform them — but the contract documentation should make this expectation explicit so app authors can support Pusha-aware themes.

### Anti-patterns

- **Don't dispatch on every cart-fetch** — only on successful mutations. Read-only `/cart.js` fetches don't mutate state.
- **Don't `setTimeout`-delay the dispatch.** Subscribers (Pusha's prefetch invalidator, header cart count, mini-cart) expect the event to fire while the relevant data is still fresh in scope.
- **Don't conflate with Customer Events.** `cart:mutated` is intra-theme UI coordination, not analytics — they're different channels. Note that `Shopify.analytics.publish('product_added_to_cart', …)` is **not** a usable analytics path either: standard event names are rejected from the storefront ([docs](https://shopify.dev/docs/api/web-pixels-api/emitting-data)). Shopify fires that event itself on a real cart add; theme code should not try to.

### Audit bucket

Cart-state integration is **not a script bucket** (A–H, K) — it's a cross-cutting concern flagged in the audit's "Bridges" or "Integration points" section. Bucket J now ships and covers the *analytics* surface specifically (event coverage, payload conformance, marker placement, raw pixels); cart-state still needs its own letter when the audit expands.

---

## Whitelists — what they hide, when to refresh trust

The audit ships three whitelists. Each suppresses a class of false positives that would otherwise clutter every run on a Pusha-aware theme. They're listed in `WHITELISTS` inside `bin/pusha.js` and surfaced in two places in the audit output:

- `## Suppressed by whitelists` — every finding that *was* classified but excluded this run, with file, matched line, and the whitelist reason.
- `## Active whitelists` — the rules themselves, with their `why` text.

The agent should treat the Suppressed section as a peer of the live bucket sections: read it on every audit, watch for unfamiliar entries.

### files whitelist — Pusha-self files

**What it hides:** every finding in `pusha.liquid`, `pusha.min.js`, `pusha.esm.js`. These are framework files. The framework's snippet contains the boot `<script>` (would flag as E); the runtime UMD has DOMContentLoaded internally (would flag as G) and is itself top-level code (would flag as H).

**Why narrow:** matches by basename. If the same filename appears elsewhere by coincidence, it'd be falsely whitelisted, but in practice no theme has a `pusha.min.js` that isn't Pusha.

**Trust window:** stable across audits. Only refresh trust if you've modified the bundle by hand or replaced it with a fork — both are off the supported path.

### G whitelist — DOMContentLoaded fallback in Pusha-aware files

**What it hides:** `addEventListener('DOMContentLoaded', …)` calls in any file that *also* contains `window.Pusha.on*` calls. The rationale: the canonical "make this file work with or without Pusha" shape is:
```js
if (window.Pusha) {
  window.Pusha.onAfterInit(initThing);
} else {
  window.addEventListener('DOMContentLoaded', () => initThing(document));
}
```
On a Pusha-loaded theme, the DOMContentLoaded branch is dead code, kept defensively.

**Why narrow:** file-level check. If a file calls `Pusha.on*` *and* has a separate DOMContentLoaded that isn't a fallback (e.g., real page-init code unrelated to the Pusha branch), the whitelist hides it. **This is the most realistic Risk A scenario** — author refactors out the `window.Pusha` guard but the DOMContentLoaded handler stays as a separate concern.

**Trust window:** refresh whenever a `Pusha.on*`-using file gets a substantial edit. The `## Suppressed by whitelists` section lists every line currently hidden — read it and confirm each entry is actually a fallback.

### H whitelist — canonical Pusha top-level mutation

**What it hides:** top-level `window.theme.*` assignments matching one of:
- `window.theme = window.theme || {}` (bootstrap shim)
- `window.theme.sectionInits = …` (container init)
- `window.theme.sectionDestroy = …`
- `window.theme.sectionInits['<handle>'] = …` (individual registration)
- `window.theme.sectionDestroy['<handle>'] = …`
- `window.theme.config = …`

**Why narrow:** matches the LHS of the assignment only. The function body on the RHS is *not* analyzed — the H bucket detects top-level mutation *patterns*, not what the assigned function does. If the function body itself contains module-level state, observer leaks, non-delegated listeners without `data-initialized`, etc., those issues are invisible to the static audit. Some of them surface as runtime warnings (`[pusha/dev]` console output with `config.debug = true`); others are entirely runtime-only.

**Structurally-similar shapes are NOT auto-suppressed.** Other top-level patterns that *look* like stateless namespaces (`window.ProductModel = {…}`, top-level `window.Pusha.onAfterSwap(…)` calls, etc.) still fire bucket H and require manual triage — see "Common false-positive shapes — bucket H triages as 'no action'" in the H bucket section. Don't extend this whitelist for them; the audit's job is to keep surfacing them, the agent's job is to record the verdict in MANIFEST.

**Trust window:** refresh after every substantial change to a wrapped section. The Suppressed section's H entries list the matched registration line — the agent can grep the file for the corresponding function body and re-read it. The cheapest discipline: when a `sectionInits[…]` body is edited, run `pusha audit --no-whitelist` once on that branch and diff against the previous run.

### When to run `--no-whitelist`

Generic workflow, mirrored in SKILL.md:
- First audit of an unfamiliar theme.
- First audit of a new branch that touches `sections/`, `snippets/`, or `assets/`.
- Before a release / Theme Store submission.
- Any time `## Suppressed by whitelists` shows a new entry or a changed entry vs. the previous audit.

The audit is fast (<1s on Dawn-sized themes), so running both forms on key milestones costs almost nothing.
