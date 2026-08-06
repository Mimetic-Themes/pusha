# Starting brief — implement Bucket X, run it against a real app stack

**Status:** not started. Design exists in [`app-integration-audit.md`](./app-integration-audit.md)
Part 1; this is the implementation brief, the test corpus, and the ground truth
gathered on 2026-08-06 from two real themes plus a docs review.

## The question this answers

"I have twenty apps installed. Which of them break under PJAX, and what do I do
about each one?"

Today that's answered by reading the theme by hand, one app at a time, and the
answer expires the moment the merchant installs anything. It should be a command.

## Why now

The analytics half of the app problem is settled — admin reporting is recoverable
(`analytics: { trekkie: true }`, measured), pixels are understood (authored
works, installed doesn't, checkout survives). What's still guesswork is the
**runtime** half: which app *code* stops working, and where.

That's Bucket X, and it's the last unmapped surface in the audit.

It also stopped being purely an audit problem. The theme owns the container every
app block renders in, and the platform documents a re-initialization contract for
the exact situation PJAX creates. That turns the remediation column from "verify
by hand" into something testable — see [The runtime half](#the-runtime-half)
below, and do the pre-test before writing either half.

***

## Part 0 — the editor pre-test, before any code

The theme editor re-renders section HTML into a live DOM without a page reload —
structurally the same event as a PJAX swap. Shopify's guidance for that situation
(`storefronts/themes/best-practices/editor/integrate-sections-and-blocks.md:14`):

> "their HTML is dynamically added, removed, or re-rendered directly onto the
> existing DOM, without reloading the entire page. **However, any associated
> JavaScript that runs when the page loads won't run again.**"

The prescribed fix is `shopify:section:load` / `shopify:section:unload`, and the
docs do **not** say the editor re-executes `<script>` tags inside the re-rendered
markup. The event is the only sanctioned re-init path.

The inference that matters: **an app block that visibly works after a merchant
changes its settings in the theme editor is re-initializing off
`shopify:section:load`, because nothing else re-runs.**

So the recovery rate is measurable before Pusha is involved at all:

1. Install the app stack on the test store.
2. Open the theme editor. For each app block, change a setting and watch.
3. Record: comes back correct / comes back inert / needs a reload.

Anything in the first bucket will also survive a re-dispatched event on the
storefront — minus apps that gate their listener on `Shopify.designMode`, which
is the residual you measure afterwards by installing Pusha.

This is a morning's work on a store being built anyway, and it decides how the
feature ships. High recovery rate: dispatching is a headline feature and the
audit's remediation column is concrete. Low rate: it ships opt-in and the audit
leads with "verify by hand."

**What the pre-test gates is the default and the claims, not the code.** Both
halves can be written against fixtures first — the dispatcher ships behind a flag
defaulted off either way, and the audit's detection is testable against real
theme files already on disk. Run the pre-test before writing README copy or the
remediation text, not before writing the implementation.

***

## What detection actually is

One recursive walk, one predicate. **Any node in a `blocks` tree whose `type`
starts with `shopify://apps/`.** The classic Dawn-style shape is the depth-1 case
of the same walk; nothing about the platform changes per theme architecture.

Each finding carries two things:

**What it is** — the type string parses identically everywhere:

```
shopify://apps/{app-handle}/blocks/{block-handle}/{extension-uuid}
   → kiwi-size-chart-recommender · kiwiSizing · b7369922-…
```

App handle is the identity for dedupe and remediation lookup. Block handle says
which surface of that app it is — an app with three blocks breaks in three
different ways.

**Where it's exposed** — the path from the swap container down:

```
templates/product.json → section 1708627536b63d27c7 (type: apps) → block kiwi_…_jJEH4d
```

Container membership at the top of that path is the entire verdict. Everything
below it is the address.

**App embeds are the same predicate on a different file** —
`config/settings_data.json` → `current.blocks`, filtered to `disabled: false`.
Same type-string parse, different location semantics.

### Verdicts

| Surface | Where | Under PJAX | Verdict |
|---|---|---|---|
| **App block** | any `blocks` tree in `templates/*.json` or `sections/*.json` | swapped out, returns as inert HTML, init JS never re-runs | **at-risk** — recoverable if the app honors the section lifecycle contract |
| **App block in a section group** | host section belongs to `sections/*-group.json` | lives in the shell, never swapped | **survives** |
| **App embed** | `settings_data.json` → `current.blocks`, `disabled: false` | injected outside the container, survives — but references *into* the swapped region go stale | **survives, verify** — and no signal exists to repair it |
| **App `<script>`** | Script Tag API — runtime-injected, not in theme files | initializes once, silent after page one | **opaque** — invisible statically, report as a known blind spot |

### Two reports, not one

X should emit both. They answer different questions and have different
preconditions.

| | Source | Needs apps installed? | Answers |
|---|---|---|---|
| **X-surface** (informational) | `"type": "@app"` declarations in `{% schema %}`, split by container | **No** | "App blocks can land in these N places; M are inside the swap container" — a risk map that stays valid when the merchant installs something new tomorrow |
| **X-placed** (advisory) | the recursive walk + the embed list | Yes | "These specific apps are here, and this is what happens to each" |

X-surface is buildable and testable today against `pusha-horizon`, with no store
and no apps. It's also the half that doesn't expire — the original complaint was
that a hand-audit goes stale on the next install.

***

## Ground truth (verified 2026-08-06)

Two real themes, read directly. `DR2023` is a client theme (classic OS 2.0, Dawn
lineage) with apps actually installed. `pusha-horizon` is the new block-based
architecture with none.

### DR2023 — app embeds live in `config/settings_data.json`

```json
"blocks": {
  "16250556887416161327": {
    "type": "shopify://apps/easy-appointment-booking/blocks/select_time/cc7b690c-…",
    "disabled": false,
    "settings": {}
  },
  "18058786784788209018": { "type": "shopify://apps/kutoku/blocks/landing-snippet/…", "disabled": false },
  "10877485987994266655": { "type": "shopify://apps/kilatech-currency-converter/blocks/app-embed/…",
                            "disabled": false, "settings": { "enable_shopify_market": false } }
}
```

Key is an opaque numeric id, not a slug. **`disabled` is the most important field
in the bucket** — an installed app whose embed is off contributes nothing, and
reporting it is a false positive.

### DR2023 — app blocks nest inside a host section

```json
"1708627536b63d27c7": {
  "type": "apps",
  "blocks": { "kiwi_size_chart_recommender_kiwi_sizing_jJEH4d": {
    "type": "shopify://apps/kiwi-size-chart-recommender/blocks/kiwiSizing/…" } },
  "block_order": ["kiwi_size_chart_recommender_kiwi_sizing_jJEH4d"]
}
```

The block key is `{app-handle}_{block-handle}_{6char}` — the generated-ID species,
not an author slug. The host section sits in the template's top-level `order`
between `main` and the rest, so it is inside `#MainContent` and at-risk. The same
section id recurs across `product.json`, `product.event.json` and
`product.provision.json`: **dedupe by (app, block) and report the template list**,
or a three-template theme reports one app three times.

### Horizon — same platform, deeper nesting

Around thirty files declare `{ "type": "@app" }` in their `{% schema %}` blocks
array, including nested theme blocks (`_card`, `_slide`, `_accordion-row`,
`_product-details`, `_collection-info`). Templates already reach **block depth 3
with zero apps installed**. A flat section→blocks walk returns nothing here, which
reads as "no apps" rather than "wrong detector." Recurse, assume no depth limit,
and resolve location up the whole nesting chain to the section.

`sections/footer.liquid` declares `@app` and footer is in `footer-group.json`, so
the shell/survives verdict is reachable on Horizon. `header.liquid` does not
declare `@app`.

`disabled_on: { "groups": ["header", "footer"] }` short-circuits location
resolution — such a section can only be in the swapped container.

***

## Traps

**1. Escaped forward slashes.** `DR2023/templates/product.json` writes the type as
`"shopify:\/\/apps\/kiwi-size-chart-recommender\/…"` while `product.event.json`,
`product.provision.json` and `settings_data.json` use plain `shopify://apps/`.
**Both encodings coexist in one theme.** A grep for `shopify://apps` over that
theme finds two of three files and reports the flagship product template as
app-free. `JSON.parse` decodes `\/` transparently — so parse and read `type`,
never text-match the file.

**2. Comment headers.** `config/settings_data.json` opens with an auto-generated
`/* … */` block, so a raw `JSON.parse` throws. `bin/pusha.js` already has
`parseSectionGroupJson` (~line 804) which strips them; generalize it rather than
writing a second parser.

**3. `{% content_for 'app' %}` is not how embeds render, and is not a detector.**
DR2023's `layout/theme.liquid` doesn't contain it (only `content_for_header` and
`content_for_layout`) and its three embeds work. Per
`apps/build/online-store/theme-app-extensions/configuration.md:157`, Shopify
injects app embed blocks before the closing `</head>` and `</body>` tags; targets
are `compliance_head`, `head`, `body`. Grepping the layout reports zero embeds on
every theme.

**4. The app wrapper resolves in three steps, and both files are theme-owned.**
Per `storefronts/themes/architecture/blocks/app-blocks.md:112–124`, a top-level
app block is wrapped by `sections/apps.liquid` if present, else
`sections/_blocks.liquid`, else a platform-generated fallback. DR2023 ships
`apps.liquid` (Dawn's); **Horizon ships `_blocks.liquid`** (`@theme` + `@app` +
`_divider`, with presets). Don't assume a theme without `apps.liquid` is on the
platform default. Constraints worth knowing: `apps.liquid` can't carry a
`templates` schema attribute (including inside `enabled_on`/`disabled_on`), can't
be rendered via `{% section 'apps' %}`, and doesn't appear in the editor's
add-section list.

Consequence of 4: **there is no app block that renders outside theme-owned
Liquid.** Every host — authored section, `apps.liquid`, `_blocks.liquid` — is a
theme file. The app's *code* isn't ours; its *container* always is.

***

## Where the code goes

`bin/pusha.js` — a ~2.2k-line audit CLI with buckets A–H, J, K, L, M, P already
implemented and greppable. X is a new bucket in the same shape: detect, classify
by location, emit a paradigm-correct remediation per `(bucket, location)` via the
existing `BUCKET_RULES` / remediation-routing machinery. Don't invent a second
reporting path; reuse P's informational-advisory shape.

`resolvePersistentShellFiles` already computes shell-vs-container membership,
which is the location routing X needs. Reuse it.

***

## The runtime half

Separate from the audit, and gated on Part 0's result.

**The mechanism.** On each swap: dispatch `shopify:section:unload` on every
outgoing `#shopify-section-*` element before removal, insert the new markup, then
dispatch `shopify:section:load` on each incoming one. `detail.sectionId` is the
**full dynamic section ID** — `template--5678__image_banner`,
`sections--1234__header` — the same string as in the wrapper's
`id="shopify-section-[id]"` (`api/ajax/section-rendering.md:116–126`). Derive it
by stripping the `shopify-section-` prefix off the element id; no JSON-key parsing
belongs in this path.

**Free classification.** Section-group sections carry a second class on the
wrapper — `class="shopify-section shopify-section-group-header-group"`
(`api/ajax/section-rendering.md:65`). The dispatcher can tell shell from container
straight off the element; static resolution is only needed by the audit.

**Symmetry with what already exists.** `src/runtime.ts:557–573` already *consumes*
these events in the theme editor, where PJAX is off, to re-init Pusha's own
components. Dispatching on swap makes Pusha a producer of the same contract it
already trusts as a consumer. The two paths can never both run.

### What shopify.dev confirmed, and what it didn't

Asked directly (2026-08-06). Useful because it closed every door to overselling
this:

- **Not documented as supported, not documented as forbidden.** There is no
  reserved-namespace rule and no alternative signal a theme can emit that
  extensions are required to observe. Ship it as best-effort compatibility,
  never as a Shopify-blessed lifecycle. Say so in the README.
- **No published ordering guarantee.** Don't rely on anything beyond
  unload → remove → insert → load, and don't assume strict 1:1 pairing.
- **No guidance either way on `Shopify.designMode` gating.** Apps that wrap their
  listener in a design-mode check stay dead on the storefront, and nothing can fix
  that. This is the residual Part 0 can't measure — only installing Pusha can.
- **App embeds have no re-init signal at all.** Their failure is subtler than
  inert: an embed holding references into the swapped container goes stale
  silently. Nothing can be emitted to repair it.
- **Shopify has no published position on client-side navigation in themes.** The
  Section Rendering API is the sanctioned partial-render path, and it has no
  lifecycle event attached either.

**Unload is not optional.** Dispatching load without unload leaks a listener set
per navigation, compounding across a session — worse than doing nothing.

**Double-init is a real risk** on apps that re-bind without guarding. Argues for
allowlist or opt-in until the corpus says otherwise.

***

## Test corpus

Run against a theme with a real stack installed. The classic and Horizon shapes
exercise the same detector at different depths, so build the heavier stack on
**Horizon** — it's where the walk can silently return nothing while looking
healthy, and it's the architecture Shopify is moving to.

**Expect zero findings** (admin-side, no storefront runtime — if X flags these,
detection is too broad): Easyteam, eShipper Commerce, QuickBooks Online,
Chargeflow, Order Printer, Flow, Collabs, Messaging.

**Expect server-rendered, unaffected** (Liquid output, no client lifecycle):
Translate & Adapt, Search & Discovery.

**Expect real findings** — these render UI into product/cart surfaces and are the
reason the bucket exists: Judge.me Reviews, FoxSell Bundles Plus, Zapiet
(Pickup + Delivery), Discount Kit, Love Loyalty, Shopify Forms, Subscriptions,
Recheck, Send To Many, The Good API / raisewave.

**Expect shell-resident** (floating widget, survives the swap):
Commslayer helpdesk & chat.

Two are genuinely uncertain and worth reporting honestly rather than guessing:
**Zapiet** (delivery/pickup date picker — cart *and* checkout surface, likely the
highest-stakes breakage in the list) and **Subscriptions** (selling-plan UI is
usually theme-rendered, but the app can inject).

### Placements the corpus must include

The app list alone doesn't exercise the detector. Place them deliberately:

- **one embed left disabled** — proves the `disabled` filter (all three of
  DR2023's are on, so this arm has never run)
- **one app block in the footer** on Horizon — the only reachable "survives in the
  shell" placement
- **one app block at nesting depth 3** — proves recursion
- **one app block on cart** — highest-stakes swap surface; DR2023 only has product
- **one Script-Tag-only app** — confirms the blind spot is reported, not silent

***

## Definition of done

1. `pusha audit` emits Bucket X findings with location-routed verdicts, from a
   recursive parse — never a text match.
2. Run against the corpus produces zero findings for the admin-only apps and real
   findings for the PDP/cart ones. False positives on admin-only apps mean
   detection is wrong, not that the apps are broken.
3. Both encodings (`shopify://apps/` and `shopify:\/\/apps\/`) are detected, and
   there's a test fixture for each.
4. Every finding carries a remediation, not just a flag: re-init path,
   `data-no-transition` opt-out, or "opaque — verify by hand."
5. The Script Tag blind spot is reported *as* a blind spot. Silence there would
   read as "no findings," which is the opposite of true.
6. X-surface runs on a theme with zero apps installed and reports the `@app`
   capability map split by container.

## Stale text to fix while you're in there

`BUCKET_RULES.J` in `bin/pusha.js` says Pusha "cannot currently reach Web Pixels
at all." That predates the `customEvents` bridge. Prefixed custom events *do*
reach the pixel sandbox — what's fenced is publishing under *standard* names.
The distinction is the whole basis of the companion-pixel doc, and the audit
currently contradicts it.

## Context you don't need to re-derive

All of it is in the repo now:

- `README.md` → "Before you ship this" / "Who this is safe for" — the
  authored-vs-installed line, checkout surviving, the retargeting fence
- `docs/analytics-companion-pixel.md` — forwarding pattern, browse-abandonment trap
- `experiments/abc-session-test.md` — admin reporting is recoverable, measured
- `app-integration-audit.md` — Bucket X design, and the Standard-Actions cart
  bridge that shipped from Part 2a
- `docs/platform-asks-shopify.md` — ask #2 is the platform fix for this whole
  bucket
