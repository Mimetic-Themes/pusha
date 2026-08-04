# Proposal — Bucket P (partials) + per-file remediation routing

Status: **IMPLEMENTED** (2026-07-22, branch `audit/block-based-coverage`). All
five open questions ratified as recommended. Kept for design rationale; the
behavior is now locked by the golden fixtures. Not shipped in the npm package
(`files` excludes `docs/`).

Motivation: the audit's remediation is written for one paradigm. "Wrap the body
in `window.theme.sectionInits[handle]`" is correct for a *section*, wrong for a
theme block or a new-Liquid template (no sections, no handle). And `{% partial %}`
— new-Liquid's named, server-rendered, client-refreshed regions — is a genuinely
new construct the bucket model doesn't see at all. Two changes, independent but
complementary.

---

## Part 1 — Per-file remediation routing

Today `BUCKET_RULES[bucket]` is one flat string per bucket. Replace it with
`remediation(bucket, location)` where **location** is derived from where the
finding lives. Same *finding*, paradigm-correct *fix*.

### Location classes

| class | where | re-init model | remediation for procedural JS (E / F2 / G) |
|---|---|---|---|
| `section` | `sections/*.liquid` | per-nav via registry | `window.theme.sectionInits['<handle>'] = (root) => {…}` (unchanged) |
| `block` | `blocks/*.liquid` | custom-element lifecycle | promote to a custom element (`connectedCallback`/`disconnectedCallback`); blocks have no per-block init registry |
| `template` | `templates/*.liquid` | once per page load | custom element, or an `onAfterInit((c,meta)=>…)` hook keyed on `meta.template` |
| `shell` | `layout/*` + any snippet/section in the persistent-shell set (outside `#MainContent`) | once, then persists across navs | `onFirstLoad` / registry `setupGlobal` — **never** `sectionInits` (it doesn't re-fire, and shouldn't) |
| `head-config` | inline `<script>` in `<head>` whose body is assignments/object-literals only, no calls | once, persists | **leave as-is** — inert config under PJAX (this is the `theme-routes.liquid` case) |
| `include` | `snippets/*.liquid` not in the shell set | inherits its renderer's scope | can't resolve statically → recommend custom element; note "verify render context" |

### How location is determined

```
locationClass(relPath, shellSet, scriptBodyIsConfigOnly):
  if file in shellSet and scriptBodyIsConfigOnly and inHead → 'head-config'
  if file in shellSet                                        → 'shell'
  if relPath starts 'sections/'                              → 'section'
  if relPath starts 'blocks/'                                → 'block'
  if relPath starts 'templates/'                             → 'template'
  if relPath starts 'snippets/'                              → 'include'
  else                                                       → 'shell'   // layout, fallthrough
```

`shellSet` already exists — `resolvePersistentShellFiles()`. `section` handle =
basename. "config-only body" = a `<script>` whose statements are only
assignments / object literals (no `(` call tokens outside the RHS literal) — a
small heuristic, conservative (misclassifying behavioral code as config is the
only risk, so bias toward *not* calling it config unless clearly inert).

### Output & compatibility

- Every routed finding gains a `location` tag in text output, e.g.
  `sections/hero.liquid:4: [E · section] <script>`, and a `location` field in
  `--json`.
- **Section-based themes keep the same remediation meaning** (section-located
  E/F/G still route to `sectionInits`); only a `[section]` tag is added.
- This is an intended output change → **regenerate goldens** (harness catches it;
  that's its job). Both fixtures + any real-theme snapshots regen once.

---

## Part 2 — Bucket P (Partials)

`{% partial 'name' %}` + `@shopify/partial-rendering` (`partials.fetch(...names)`
/ `partials.apply(html)`) are new-Liquid's islands substrate: named regions the
server re-renders and the client swaps in place. The audit should **inventory**
them, **flag the string-naming contract**, and **inform bucket L** that state
inside a partial region self-heals.

### Detection

- **Declarations:** `/\{%-?\s*partial\s+['"]([\w-]+)['"]/g` across
  `templates/ layout/ blocks/ snippets/`.
- **Consumers (v1, attribute-based):**
  `/data-partials=["']([^"']+)["']/` (comma-split) and `/\bpartial=["']([\w-]+)["']/`.
  (Optional v2: parse JS `partials.fetch('name')` string args — deferred; the
  theme's own convention is the `data-partials` attribute.)
- **Map** each declared name → its consumer sites; a declared partial with **no
  consumer** and a consumer referencing an **undeclared** name are both flagged
  (the naming contract is load-bearing — the theme's own comments warn that
  renaming breaks live updates).

### Classification

P is **informational/safe** (like A/B), not a "needs-wrapping" bucket — partials
already work; they're Shopify machinery. It emits:

1. An inventory: `partial 'cart-items' — declared cart.liquid:12; consumed by
   <s-cart data-partials> theme.liquid:275`.
2. A **naming-contract** note per partial (rename ⇒ break).
3. One **dual-swap** note when partials are present: Pusha's container swap and
   the theme's `partials.apply()` both mutate the DOM; nav during an in-flight
   partial refresh has undefined ordering — a runtime seam to coordinate.

### Cross-link to bucket L

An L finding (e.g. `cart.item_count` in the shell) that sits inside a
partial-covered region is **not** stale — it self-heals on the next partial
refresh. v1 (conservative): if a shell file declares/consumes a partial,
**annotate** nearby L findings with `[covered by partial 'X']` but **do not
auto-downgrade** their rank (auto-downgrade is statically fuzzy; annotate, don't
hide). v2 can tighten the region mapping.

### Letter & additivity

- Proposed letter **P** (mnemonic; `I`/`J` reserved — `J` = analytics surface per
  CLAUDE.md; `N` is the sequential alternative).
- **Additive**: 0 declarations on classic themes → empty `## P. Partials (none)`
  section. Adding the section changes every theme's output → regen goldens once.

Out of scope here: bucket J (analytics surface) — separate proposal.

---

## Open questions to ratify

1. **Letter**: `P` (mnemonic) or `N` (sequential)? — rec **P**.
2. **Location tags on all findings**, including section-based themes (adds
   `[section]` tags to Dawn/Horizon output, regen goldens) vs. tag only
   non-section locations? — rec **tag all** (clearer, honest).
3. **Consumer detection depth**: `data-partials`/`partial=` attributes only (v1)
   vs. also parse JS `partials.fetch()` string args? — rec **attributes only v1**.
4. **L × partials**: annotate partial-covered L findings only (v1) vs.
   auto-downgrade their rank to `ok`? — rec **annotate only** (don't hide state).
5. **head-config "leave as-is"**: add the inert-config-script route (the
   `theme-routes.liquid` case), or keep flagging those as E? — rec **add it**.
