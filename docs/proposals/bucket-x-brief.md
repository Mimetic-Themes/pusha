# Starting brief — implement Bucket X, run it against a real app stack

**Status:** not started. Design exists in [`app-integration-audit.md`](./app-integration-audit.md)
Part 1; this is the implementation brief and the test corpus.

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

## Where it goes

`bin/pusha.js` — a ~2.2k-line audit CLI with buckets A–H, J, K, L, M, P already
implemented and greppable. X is a new bucket in the same shape: detect, classify
by location, emit a paradigm-correct remediation per `(bucket, location)` via the
existing `BUCKET_RULES` / remediation-routing machinery. Don't invent a second
reporting path; reuse P's informational-advisory shape.

## What it detects

Three surfaces, each with a different failure mode and a different fix:

| Surface | Where | Under PJAX | Verdict |
|---|---|---|---|
| **App block** | `@app` entry in a JSON template's `blocks` | swapped out, returns as inert HTML, init JS never re-runs | **at-risk** |
| **App embed** | `{% content_for 'app' %}` in `layout/theme.liquid` | survives in the shell, but listeners may point at replaced nodes | **survives, verify** |
| **App `<script>`** | Script Tag API — runtime-injected, not in theme files | initializes once, silent after page one | **opaque** — can't be seen statically, report as a known blind spot |

Detection is mostly a JSON walk: parse `templates/*.json` and
`sections/*.json`, collect blocks whose `type` starts with `shopify://apps/`,
and record which template and which section they sit in. That location is what
determines the verdict — an app block inside `#MainContent` is at-risk; the same
app rendered in a shell section is not.

## Test corpus

Run it against a theme with this stack installed. Chosen because it spans all
four outcomes and is a realistic mid-size merchant, not a toy.

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

## Definition of done

1. `pusha audit` emits Bucket X findings with location-routed verdicts.
2. Run against the corpus above produces zero findings for the admin-only apps
   and real findings for the PDP/cart ones. False positives on admin-only apps
   mean detection is wrong, not that the apps are broken.
3. Every finding carries a remediation, not just a flag: re-init path,
   `data-no-transition` opt-out, or "opaque — verify by hand."
4. The Script Tag blind spot is reported *as* a blind spot. Silence there would
   read as "no findings," which is the opposite of true.

## ⚠ Stale text to fix while you're in there

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
