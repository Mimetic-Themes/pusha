# Editor re-init pre-test — what fraction of an app stack survives a re-render?

**Status: SUPERSEDED — the instrument does not work.** Measured 2026-09-11: the
theme editor performs a **full page reload on any theme app extension change**, app
blocks and app embeds alike. A reload re-runs everything, so every app reads as
`recovers` and the measurement carries no information. The inference below is sound;
the editor simply cannot be used to test it.

Replaced by `~/Work/pusha-probe` — a purpose-built theme app extension whose blocks
differ by exactly one variable each, measured under real Pusha navigation instead of
in the editor. That rig also reaches the two residuals called out below as
unmeasurable here: `Shopify.designMode`-gated listeners, and app embeds.

It also changes what is being measured first. This document chased a **recovery
rate** across third-party apps. The probe chases the **mechanism**, because if an
uncooperative re-init path exists, the rate stops being load-bearing — remediation
would no longer depend on the app cooperating, and the [Decision](#decision) table
below would be the wrong shape rather than merely unfilled.

The rest of this file is retained for the inference, the verdict vocabulary, and the
corpus expectations, all of which carry over. **Do not run the procedure.**

Gates: the *default* and the *README claims* for the Bucket X runtime half
(`docs/proposals/bucket-x-brief.md` → "The runtime half"). Not the code — the
dispatcher ships behind a flag defaulted off either way, and both halves are
fixture-testable without a store.

---

## The inference this rests on

The theme editor re-renders a section's HTML into a live DOM with no page
reload — structurally the same event as a PJAX container swap. Shopify's own
guidance for that situation
(`storefronts/themes/best-practices/editor/integrate-sections-and-blocks.md:14`):

> "their HTML is dynamically added, removed, or re-rendered directly onto the
> existing DOM, without reloading the entire page. **However, any associated
> JavaScript that runs when the page loads won't run again.**"

The prescribed fix is `shopify:section:load` / `shopify:section:unload`, and the
docs do **not** say the editor re-executes `<script>` tags inside re-rendered
markup. The event is the only sanctioned re-init path.

So: **an app block that visibly works after a setting change is re-initializing
off `shopify:section:load`, because nothing else re-runs.** Anything in that
bucket will also survive a re-dispatched event on the storefront.

### What this test cannot tell you

- **`Shopify.designMode`-gated apps.** An app that wraps its listener in a
  design-mode check passes here and stays dead on the storefront. That residual
  is only measurable by installing Pusha. Expect the storefront number to be
  *lower* than this one — never higher.
- **App embeds.** They render outside the container and are never re-rendered by
  a section-level editor change. Their failure mode is different (stale
  references into the swapped region, no signal available to repair them) and
  this test does not reach it. Embeds are out of scope here by construction.
- **Whether double-init breaks anything on the storefront.** The editor measures
  whether it *happens* (step 4 below). Whether it compounds across a session is
  a Pusha-installed measurement.

---

## Pre-flight

Do these in order. Step 0 can invalidate the whole run.

**0. Prove the editor actually dispatches, in this theme.** Open the editor, open
devtools, select the **preview iframe** as the console context (not the top
frame), and paste:

```js
document.addEventListener('shopify:section:load',   e => console.log('LOAD',   e.detail.sectionId));
document.addEventListener('shopify:section:unload', e => console.log('UNLOAD', e.detail.sectionId));
```

Change one setting on a **theme** section with known JS. You should see the pair
log. If nothing logs, the rig is wrong and every app below will read as a false
negative. Fix this before recording a single row.

Note the console clears when the iframe reloads — a whole-page re-render (theme
settings, template switch) drops the listeners. Re-paste after any of those.

**1. Pull the theme locally** and run the audit against it, so the checklist
below is generated rather than remembered:

```bash
shopify theme pull --store <store> --theme <id> --path ~/Work/<theme>
node ~/Work/pusha/bin/pusha.js audit ~/Work/<theme> --json \
  | jq -r '.findings.X[] | select(.kind=="app-block")
           | "\(.appHandle)\t\(.blockHandle)\t\(.verdict)\t\(.placements[0].address)"'
```

Every row that comes back is one row of the table. If the audit returns nothing
and you know apps are installed, that is a **detection defect** — stop and fix X,
because a silent zero is exactly the failure the parse-not-grep rule exists to
prevent.

**2. Confirm the corpus placements are actually placed.** The app list alone
doesn't exercise anything. Required (`bucket-x-brief.md` → "Placements the corpus
must include"):

- [ ] one embed left **disabled** — proves the `disabled` filter
- [ ] one app block in the **footer** on Horizon — the only reachable "survives"
- [ ] one app block at **nesting depth 3** — proves recursion
- [ ] one app block on **cart** — highest-stakes swap surface
- [ ] one **Script-Tag-only** app — confirms the blind spot prints, not silence

**3. Disable ad blockers.** Several of these apps load their widget from their own
CDN; a blocked request reads identically to "failed to re-init."

---

## Procedure — per app block

Repeat for every row from pre-flight step 1. One block at a time.

1. **Navigate the editor preview to a page where the block renders.** Confirm it
   works on first paint. If it doesn't work here, it's broken independently of
   any of this — record `broken-baseline` and move on.
2. **Decide whether it has client behavior at all**, and write it down before
   touching anything. A server-rendered Liquid block (a static star rating, a
   translated string) comes back correct and proves *nothing* — it had no JS to
   re-run. Only blocks with client behavior count toward the rate.
3. **Change one setting on the block itself** (or its host section) and watch.
   Not a theme setting — those re-render the whole page, which is a different
   event. Then **interact with the widget**: open the size chart, click the
   review tab, pick a date, expand the bundle. Looking at it is not the test.
4. **Change a second setting** and interact again. Two things to catch: whether
   it still recovers on a repeat cycle, and whether anything **duplicated** —
   two date pickers, doubled event handlers, a widget rendered twice. Double-init
   is a distinct failure from inert, and it is worse under PJAX than in the
   editor because it compounds per navigation.
5. **Record console errors** even when the widget looks fine. An error that
   doesn't break the visible surface here often breaks a different surface later.

### Verdicts

| Verdict | Means | Under a dispatched `section:load` |
| --- | --- | --- |
| `recovers` | comes back, interactions work | survives — unless design-mode gated |
| `inert` | HTML returns, interactions dead | not recoverable by dispatch |
| `reload-only` | wrong or missing until F5 | not recoverable by dispatch |
| `duplicated` | comes back **twice** | dispatch makes it worse — allowlist out |
| `n/a` | no client behavior; server-rendered | excluded from the rate |
| `broken-baseline` | didn't work before the change either | excluded; report to the app |

---

## Recording sheet

Store: `________________`  Theme: `________________`  Date: `__________`
Audit run at commit: `__________`  App count installed: `____`

### App blocks

| # | App handle | Block handle | Placement | Client behavior? | 1st change | 2nd change / dupe? | Console | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |  |  |  |
| 6 |  |  |  |  |  |  |  |  |  |
| 7 |  |  |  |  |  |  |  |  |  |
| 8 |  |  |  |  |  |  |  |  |  |
| 9 |  |  |  |  |  |  |  |  |  |
| 10 |  |  |  |  |  |  |  |  |  |
| 11 |  |  |  |  |  |  |  |  |  |
| 12 |  |  |  |  |  |  |  |  |  |

### Tally

```
blocks with client behavior (the denominator) : ____
  recovers                                    : ____
  inert                                       : ____
  reload-only                                 : ____
  duplicated                                  : ____
excluded — n/a (server-rendered)              : ____
excluded — broken-baseline                    : ____

recovery rate = recovers / (blocks with client behavior) = ____ %
```

---

## Second pass, same session — discharge DoD #2

While the stack is installed and the theme is pulled, run the audit for real.
This is the corpus check the fixtures can't do
(`bucket-x-brief.md` → "Definition of done" #2).

```bash
node ~/Work/pusha/bin/pusha.js audit ~/Work/<theme>
```

**Must produce zero findings** — admin-side, no storefront runtime. A hit here
means detection is too broad, not that the app is broken:

Easyteam · eShipper Commerce · QuickBooks Online · Chargeflow · Order Printer ·
Flow · Collabs · Messaging

**Must produce real findings** — these render UI into product/cart surfaces and
are the reason the bucket exists:

Judge.me · FoxSell Bundles Plus · Zapiet · Discount Kit · Love Loyalty ·
Shopify Forms · Subscriptions · Recheck · Send To Many · The Good API

**Expect server-rendered, unaffected** (Liquid output, no client lifecycle):
Translate & Adapt · Search & Discovery

**Genuinely uncertain — record what you see, don't decide in advance:** Zapiet
(cart *and* checkout surface, likely the highest-stakes breakage in the list) and
Subscriptions (selling-plan UI is usually theme-rendered, but the app can inject).

| App | Expected | Actual | Match? |
|---|---|---|---|
|  |  |  |  |

---

## Decision

Read the recovery rate against the denominator, and treat `duplicated` as a veto
independent of the rate.

| Result | How the dispatcher ships | What the audit's remediation column says |
| --- | --- | --- |
| **High recovery** (most client-behavior blocks come back) | flag defaulted **off**, documented as the recommended setting; dispatching is a headline feature | concrete: "dispatch re-inits this" |
| **Mixed** | flag off, **allowlist** of apps measured to recover | per-app: named apps get the bridge, the rest get opt-out |
| **Low recovery**, or any `duplicated` | flag off, opt-in only, allowlist mandatory | leads with "verify by hand"; `data-no-transition` on surrounding nav |

Independent of the number, three things stay true in the README:

- **Best-effort compatibility, never a Shopify-blessed lifecycle.** Confirmed
  2026-08-06: not documented as supported, not documented as forbidden, no
  reserved-namespace rule, and no alternative signal a theme can emit that
  extensions are required to observe.
- **No ordering guarantee beyond** unload → remove → insert → load. Don't assume
  strict 1:1 pairing.
- **Unload is not optional.** Dispatching `load` without `unload` leaks a listener
  set per navigation, compounding across a session — worse than doing nothing.

## What this feeds

- `docs/proposals/bucket-x-brief.md` → "The runtime half" — the implementation
  spec this gates
- `docs/platform-asks-shopify.md` ask #2 — the platform fix that would retire the
  whole bucket. A low recovery rate is the evidence for that ask.
