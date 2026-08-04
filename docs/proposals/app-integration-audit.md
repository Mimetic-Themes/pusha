# Proposal — Bucket X (theme app extension surface) + the app re-init seam

Status: **DRAFT** (2026-07-23). Companion to
`partials-and-remediation-routing.md`. Closes the gap the README names
explicitly ("No third-party app integration yet"): the audit sees app-injected
*Liquid data* (`L·H`) but is blind to the app *JS/HTML surface* — app blocks,
app embeds, and app-injected `<script>` tags. Not shipped in the npm package
(`files` excludes `docs/`) until ratified.

Motivation: apps reach a theme through **theme app extensions** in three shapes,
each with a distinct failure mode under a container swap. Pusha can't wrap code
it doesn't own, so the honest v1 is **detect + classify + route to a safe
posture**, not "auto-fix." Two changes: an audit bucket (Part 1, buildable now)
and a runtime seam that leans on Shopify's new Standard Events/Actions (Part 2,
depends on the new-Liquid platform surface).

---

## The three app surfaces and how each breaks

| Surface | Where it lives | On a PJAX swap | Bucket |
|---|---|---|---|
| **App block** (`blocks/*` `@app`, dropped into a section/template) | inside `#MainContent` | swapped out → back in as inert HTML; its init JS ran on the old document and never re-runs → **dead** | X·block |
| **App embed** (floating widget — chat, reviews badge, `{% content_for 'app' %}`) | persistent shell, outside `#MainContent` | survives, but listeners bound to now-removed container DOM go **stale** | X·embed |
| **App `<script>`** (Script Tag API / injected tag) | runtime-injected, not in theme files | initializes once on full load; a swap doesn't re-run it → **silent after page 1** | X·script |

Plus the case already partly covered: an app that mutates the cart through its
own path bypasses the theme's `cart:mutated` dispatch, so Pusha's prefetch cache
goes stale and the cart badge/drawer desync. Part 2 fixes this at the contract
level via Standard Actions.

---

## Part 1 — Bucket X (app-surface inventory)

Like **P** (partials) and **B/A** (safe), **X is informational + advisory**, not
a "needs-wrapping" bucket — you can't mechanically transform an app's code. It
**inventories** app surfaces, assigns each a **PJAX-safety verdict**, and routes
each to a **paradigm-correct posture**.

### Detection

App surfaces are not all in `.liquid`, so detection reads JSON too (the partials
detector only walks `.liquid` — this bucket extends the walk):

- **App blocks** — `"type": "@app"` (and `"@app"`-prefixed block types) in
  `templates/*.json`, `sections/*.json` (section groups), and inline
  `{% content_for 'blocks' %}`/`{% block '@app' %}` sites in new-Liquid templates.
- **App embeds** — `config/settings_data.json` → `current.blocks` entries whose
  `type` is an `@app`/`shopify://apps/...` reference with `disabled: false`; and
  `{% content_for 'app' %}` in `layout/*.liquid` (the app-embed render point).
- **App scripts** — `<script src>` whose host is an app CDN
  (`cdn.shopify.com/extensions/`, `*.myshopify.dev`, known third-party pixel/app
  hosts). Runtime Script-Tag-API injections are **invisible statically** → emit a
  single "runtime app scripts can't be seen by a static audit; verify in a live
  session (Shopify API context, if present)" note. Ties into the CLAUDE.md
  "Shopify API context — opportunistic" hook.

### Classification & location routing

`locationClass` already distinguishes `block` / `shell` / `template` / `include`.
Reuse it: an app surface's verdict is a function of *where it renders*, matching
the existing `REMEDIATION[bucket][location]` shape.

| location | verdict | posture |
|---|---|---|
| `block` (app block inside the container) | **at-risk** | Prefer: app block authored as a custom element re-inits on swap for free (the new-Liquid direction). Else: wrap the render site in `<pusha-app-bridge>` (re-fires the app's known init on `onAfterInit`) — **allowlist-gated**, fragile. Else: opt the section out (`data-no-transition`). |
| `shell` (app embed, `{% content_for 'app' %}`, floating widget) | **survives (verify)** | Persists across navs — init once via `onFirstLoad`. Flag only if it binds to container DOM. This is the **recommended app placement.** |
| `script` (app CDN `<script>`) | **at-risk / opaque** | If wired through Customer Events, the analytics bridge covers re-fire. If it self-inits DOM on load, no static fix — opt-out or migrate to an app embed. Runtime-injected: verify live. |

### Output & additivity

- New `## X. Theme app extensions` section: an inventory line per surface
  (`app-block 'product-reviews' — sections/main-product.json:regform; verdict:
  at-risk [block]`), the verdict, and the routed posture.
- `--json`: an `appSurfaces[]` array + a `remediationByLocation.X` block, mirroring
  `detectPartials`' shape.
- **Additive**: 0 app surfaces → `## X. Theme app extensions (none)`. Adding the
  section changes every theme's output → **regen goldens once** (harness catches
  it — its job), same as the P rollout.
- **Cross-link to `L·H`**: an app-injected *Liquid* finding (L·H) and an app
  *surface* (X) for the same app get annotated as the same app so the report
  reads as one entry, not two unrelated findings.

### The `<pusha-app-bridge>` element (the one remediation you can ship)

Revives the historical App-Block-Lifecycle pattern. For app blocks the dev *can*
edit the render site of, wrap it:

```liquid
<pusha-app-bridge data-app="product-reviews" data-reinit="window.Spr?.initDomEls">
  {% content_for 'block' %}   {# or the app block render #}
</pusha-app-bridge>
```

The custom element's `connectedCallback` re-runs the named init on every mount
(so it fires on the swap-in), `disconnectedCallback` tears down. It's **opt-in,
allowlist-driven, and honestly fragile** — it depends on the app exposing a
re-init global. Where it can't, the audit says "opt-out," not "bridge." This is
the ceiling of what's possible until Shopify blesses a navigation event (Part 2 /
the platform asks).

---

## Part 2 — The runtime seam (Standard Events / Standard Actions)

Shopify's new-Liquid preview shipped the two primitives that convert Pusha's most
bespoke app-facing subsystems into subscriptions against a platform contract.

### 2a. Cart interop via Standard Actions

`Shopify.actions.updateCart / openCart / getCart` are on every Liquid storefront,
and *"when a configured action succeeds, the action runtime auto-emits the
matching standard events."* So:

- Add a **standard-events cart bridge**: subscribe to the cart standard event and
  re-dispatch Pusha's existing `cart:mutated` (source `'shopify-actions'`).
- **This captures app-driven cart mutations Pusha currently misses** — any app
  routing through `Shopify.actions.updateCart` becomes visible with zero
  per-theme wiring. The Dawn-family `pubsub` bridge stays the fallback for
  classic themes; on new-Liquid, standard-events is the canonical source.
- Gated `'auto'` like the analytics standard-events path: no-op when the action
  runtime/global is absent (classic themes).

### 2b. App re-init — what we can do vs. what needs the platform

- **Can do now:** custom-element app blocks re-init on swap for free; the
  `<pusha-app-bridge>` allowlist covers a handful of common apps (reviews,
  Klaviyo, wishlist).
- **Can't do without Shopify:** a *general* re-init signal apps subscribe to.
  Apps init on `DOMContentLoaded`; there is **no soft-navigation event** in the
  standard vocabulary (it's product/cart/collection-filter — all *content*
  events). That's the platform ask — see `docs/platform-asks-shopify.md`.

---

## Open questions to ratify

1. **Letter**: `X` (mnemonic — app eXtension) or `N` (next sequential)? — rec
   **X** (P set the mnemonic precedent; `X` reads as "third-party/extension").
2. **JSON-file walk**: extend the audit to read `templates/*.json`,
   `sections/*.json`, `config/settings_data.json` (needed for app-block/embed
   detection) — accept the wider walk, or keep the audit `.liquid`-only and detect
   only `{% content_for %}` + app `<script>`? — rec **extend the walk** (JSON is
   where app blocks/embeds actually live; `.liquid`-only misses most of them).
3. **`<pusha-app-bridge>` allowlist**: ship a seed allowlist of common apps'
   re-init globals in the package, or keep the element generic
   (`data-reinit="<expr>"`) and document per-app values in `PATTERNS.md`? — rec
   **generic element + PATTERNS.md allowlist** (an in-package app-name→global map
   rots fast and invites false confidence).
4. **Verdict vocabulary**: `at-risk / survives / opaque` vs. reusing L's
   `auto / ask / ok` ranks? — rec **app-specific words** (`survives`/`at-risk` are
   clearer than `ok`/`ask` for a surface you can't auto-fix).
5. **Standard-actions cart bridge default**: `'auto'` (fire only when the action
   runtime resolves) vs. off-by-default opt-in? — rec **`'auto'`** (matches the
   analytics standard-events default; no-ops on classic themes).

Out of scope here: the platform asks themselves (their own brief); bucket J
(analytics surface) — separate proposal.
