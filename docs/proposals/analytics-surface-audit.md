# Proposal — Bucket J (analytics surface)

Status: **IMPLEMENTED** (2026-08-01), **premise partly corrected 2026-08-04**.
Companion to `partials-and-remediation-routing.md` (bucket P) and
`app-integration-audit.md` (bucket X). Not shipped in the npm package (`files`
excludes `docs/`).

> ## ⚠ Correction — 2026-08-04
>
> This proposal assumes the runtime's serialized `data-pusha-analytics-event`
> payloads actually reach Web Pixels. **They do not.** The storefront publish
> API is [custom events only](https://shopify.dev/docs/api/web-pixels-api/emitting-data):
> standard event names are rejected and `publish()` returns `false`. Web Pixels
> Manager also initializes once per document and is not re-initialized on a soft
> navigation.
>
> Two consequences for what follows:
>
> 1. **The "auditable by design" argument below is weaker than written.** It
>    claims the declarative-Liquid approach beats intercepting WPM internals
>    because a static tool can check it. The checking part is true. But the
>    approach it is being compared against is the one that *does* reach pixels,
>    and this one currently reaches nothing — so it is not a trade that has paid
>    off yet. It becomes one if a supported publish path appears, or if the
>    payloads are routed through a custom event into a merchant-authored custom
>    pixel.
> 2. **"Migrate to Customer Events" is removed as a remedy for raw pixels.**
>    It would move a working pixel onto the unreachable channel. Manual refire
>    from `onAfterInit` is the only remedy.
>
> Bucket J is still worth keeping. Validating payload shape is what makes a
> supported path cheap to adopt later, and the coverage/conformance/placement
> checks are correct as implemented. What must change is the framing: the bucket
> does not make pixels work, and its output must not imply that it does.

Motivation: the runtime makes its strongest correctness claim about analytics —
*"Left unhandled, every store on Pusha silently corrupts merchant data"* — and
the audit was the only boundary with no coverage of it at all. Twelve buckets
(A–H, K, L, M, P) classified sections, blocks, templates, shell scope, partials,
portal-to-body elements, and app-injected Liquid. A grep for `gtag|fbq|dataLayer|
pixel|analytics` across the classifier returned zero hits.

That gap matters more than the others because of how the analytics contract is
shaped. `data-pusha-analytics-event` payloads are **hand-written Liquid living in
the merchant's theme**, one per template — not code Pusha ships. When they drift,
nothing throws: a stale payload still publishes, and the downstream pixel quietly
drops or mis-attributes it. Every other Pusha contract fails loudly or is
mechanically transformable. This one fails silently and is distributed across N
files per store.

Which is exactly what a static analyzer is for. The payload is declarative Liquid
*by design* — that is the whole reason the bridge re-publishes theme-serialized
events instead of intercepting Web Pixels Manager internals. Runtime
interception would be less work for the theme author and completely
un-auditable. Bucket J is what makes the trade pay off.

---

## The four surfaces and how each breaks

| Surface | Detection | Failure under PJAX | Kind |
|---|---|---|---|
| **Missing page-type event** — a product/collection/search/cart page ships no marker | template or main-section exists, no marker names its event | On a native load Shopify auto-fires the page-type event; on a swap nothing does. Meta/GA4/TikTok/Klaviyo lose the event entirely → **silent attribution loss** | `coverage` |
| **Malformed marker** — bad JSON, missing `type`, missing required payload key | parse + shape check on the marker body | Bad JSON → runtime warns and skips. Missing `type="application/json"` → **the browser executes the body as JavaScript**. Missing required key → pixel receives a structurally invalid event | `conformance` |
| **Marker in the persistent shell** | `locationClass` returns `shell` | `readSerializedEvents()` queries the whole document, so a shell marker is found on *every* nav and re-publishes one page's payload forever → **systematically wrong data** | `placement` |
| **Raw pixel** — `gtag(` / `fbq(` / `dataLayer.push(` in theme files, not routed through Customer Events | source scan | Shell scope: fires once, never again. Container scope: injected inline scripts don't execute after a swap. Either way **dark after page 1** | `raw-pixel` |

---

## Detection

Like **P** and **X**, J is **informational + advisory**. It inventories, assigns
a rank, and routes to a posture. It never rewrites a payload — Pusha can't know
what a merchant's product schema should contain.

### Markers

Scanned across `sections/`, `snippets/`, `blocks/`, `templates/`, `layout/`:

```
/<script([^>]*\bdata-pusha-analytics-event\b[^>]*)>([\s\S]*?)<\/script>/g
```

**Liquid probe.** A real payload is not valid JSON — `"amount": {{ price |
divided_by: 100.0 }}` is a bare Liquid tag in value position. Before parsing,
`{%…%}` is stripped and `{{…}}` is replaced with `1`, which is valid both bare
(number) and inside quotes (string). Structure survives; values don't matter,
because J validates shape, not content.

The event **name** is read from the raw body (`/"name"\s*:\s*"([^"]*)"/`) so a
Liquid-computed name is visible as such rather than collapsing to the probe
token. A computed name ranks `warn` — honestly unverifiable, not a defect.

### The page-type table

```js
product_viewed    → data.productVariant   probes templates/product,    sections/main-product
collection_viewed → data.collection       probes templates/collection, sections/main-collection
search_submitted  → data.searchResult     probes templates/search,     sections/main-search
cart_viewed       → data.cart             probes templates/cart,       sections/main-cart
```

Coverage is only asserted when the theme actually has the page — a headless or
partial theme without `templates/cart*` is not missing a `cart_viewed`.

`page_viewed` is special-cased: the runtime publishes a prefixed
`pusha:page_viewed` on every swap already, so a theme-supplied `page_viewed`
block is a **double-count** on the custom-event channel, ranked `warn`.
(Under its bare standard name it is rejected by the platform outright and
reaches nothing — the runtime no longer makes that call at all.)

### Ranks

Following L's precedent of a small ordered vocabulary:

- **`gap`** — silent data loss or corruption. Missing coverage, unparseable
  payload, missing `type`, missing required key, shell placement.
- **`warn`** — advisory or unverifiable. Unknown event name, Liquid-computed
  name, theme-supplied `page_viewed`, raw pixels.

No `ok` rank: a well-formed marker in the right place produces an inventory line,
not a finding, matching how P lists partials without flagging them.

### Location routing

`locationClass` is reused unchanged. For markers the mapping is binary —
`shell` is a `gap`, everything else is correct — so J adds no
`REMEDIATION[bucket][location]` entry. Raw pixels carry their location in the
advisory text instead, since the fix differs (`shell` → refire via
`onAfterInit`; container → the script won't re-execute at all). Per the
correction above, migrating raw pixels into Customer Events is not an option.

---

## Output & additivity

- New `## J. Analytics surface` section between M and P.
- Inventory line per marker (`sections/main-product.liquid:14: product_viewed
  [section] ok`), then the ranked findings.
- Summary line: `J analytics surface: N (gaps: N, warns: N)`.
- `--json`: `findings.J[]`, each `{ kind, rank, file, line, event?, what }`.
- **Additive**: zero findings → `## J. Analytics surface (none)`. Adding the
  section changes every theme's report → **regen goldens once**, same as the P
  rollout. The golden harness catches it; that is its job.
- J joins the Pusha-self file whitelist partition so `pusha.liquid` never
  self-reports.

---

## Open questions — ratified

1. **Letter**: `J` — reserved for this in `CLAUDE.md` since the analytics-bridge
   design note. Kept.
2. **Coverage strictness**: assert only when the page exists in the theme
   (chosen) vs. always expect all four. Chosen — false positives on partial
   themes would train people to ignore the bucket.
3. **Liquid probe token**: `1` (chosen) vs. attempting a real Liquid render.
   Rendering needs a theme context the audit doesn't have and would make the
   classifier non-deterministic.
4. **Raw-pixel scope**: flag all call sites (chosen) vs. only those outside
   Customer Events. Whether a pixel is *also* wired through admin is not visible
   in theme files, so the finding is advisory and says so.
5. **Auto-fix**: none. A generated payload would be a guess at the merchant's
   schema, and a wrong payload is worse than an absent one — the runtime's
   "no script, no event, never fabricate" rule applies to the audit too.

Out of scope: bucket X (its own proposal); validating payload *values* against
live catalog data; whether admin double-counts a re-fired `PageViewEvent`
(unknowable without the Web Pixels sandbox — see `docs/platform-asks-shopify.md`
ask #5).
