# Backlog

Open work, ranked. Written 2026-09-11 at the end of a long session, so the
reasoning is recorded rather than just the task — the *why* is the part that
gets lost.

Closed items are not listed; `git log` has them.

---

## Blocking a public demo

### 1. Islands have never run in a browser

The rig has no `data-island` anywhere, so the hash-URL fix — the most
consequential bug in the last round — is only covered by a jsdom test. Mark a
price or badge region in a Horizon section and walk it.

### 2. Measure the Klaviyo claim before repeating it

`docs/apps/klaviyo.md` says Klaviyo tracks *Active on Site* and *Viewed
Product* through a snippet in its **app embed**, not through the Shopify pixel.
The README attributes browse-abandonment loss to the app pixel. If Klaviyo's
split is right the outcome still holds — a once-per-document snippet fires once
— but the channel is wrong and the fix is two lines of theme code rather than a
companion pixel. Measure on a store with Klaviyo installed before saying it
out loud.

### 3. The Horizon rig still calls the framework "Moss"

16 mentions across 6 files in `~/Work/pusha-horizon`, left from the rename.
Most are `MOSS-PORT:` audit-trail comments, which are harmless but misleading
to anyone reading the rig as an example.

One is **live code, and broken**:

```js
// assets/recently-viewed-init.js:18
if (window.Moss && typeof window.Moss.onAfterSwap === 'function') {
  window.Moss.onAfterSwap(recordCurrentProduct);
}
```

`window.Moss` does not exist — the global is `window.Pusha`. The guard is
permanently false, so recently-viewed tracking has been dead across every
navigation since the rename, failing in exactly the silent way the audit warns
about. Fix the call, then sweep the comments.

Files: `recently-viewed-init.js` (live bug), `theme-editor.js`,
`view-transitions.js`, `utilities.js`, `qr-code-generator.js`,
`auto-close-details.js`, `sections/header.liquid`.

**Worth asking:** should `pusha audit` flag a guard on a global that is not
`window.Pusha`? A dead feature-detect on a renamed global is undetectable by
every existing bucket, and any theme ported before the rename has the same
latent bug.

### 4. Unidentified a11y console message mentioning Moss

Reported from a live walk; not reproduced. Nothing in the rig writes "Moss" to
the console, `assets/focus.js` is clean, and no `moss.*` file remains — so the
source is unknown. Capture the exact console line and its stack before chasing
it.

Possibly related and separately confirmed: `Autofocus processing was blocked
because a document already has a focused element` on Horizon's collection page
(see item 7).

---

## Publishing

### 5. npm publish

Scope is renamed to `@mimeticthemes`; `"private": true` is still set. Held
deliberately: `0.1.0` can never be reused, so don't burn it until the README
describes a build that has been driven in a browser.

```sh
npm login
npm publish --dry-run
npm publish --access public          # --access public is required the FIRST time
```

`--tag alpha` publishes without moving `latest`, if you want the name reserved
before the release is real.

### 6. Repo hygiene

No `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, or issue template.
`CLAUDE.md` is 55 KB of public strategy — it should be ~2 KB (what the project
is, the commands, "the README is authoritative", the vocabulary rule) with the
rest in the vault. `docs/STATE-2026-09-11.md` and
`docs/questions-for-shopify-dev.md` still read as internal notes.

---

## Known bugs, none blocking

### 7. `Autofocus processing was blocked because a document already has a focused element`

Seen on Horizon's collection page, and **reproduced 2026-09-11** on a second
walk — same page, same message. Pusha's focus-to-container beats the page's own
autofocus. Benign today; decide whether the a11y focus move should yield to an
explicit `[autofocus]` in the incoming content.

### 8. `peekInFlight` hands the nav a prefetch that has not started

Found while proving the navigation timeout (see `docs/STATE-2026-09-11.md`).
`prefetchPage` registers its promise in `inFlight` at `prefetch.ts:247`, which
runs *before* `acquirePrefetchSlot()` resolves. So with both slots of
`MAX_CONCURRENT_PREFETCH = 2` busy, a queued-but-unstarted warm is still
visible to `peekInFlight`, and `navigate()` awaits it instead of fetching.

This contradicts the comment at `prefetch.ts:169` — *"leaves the connection
budget for real navigation, which always bypasses this queue."* A nav that
fires its own fetch does bypass it. A nav that dedups against a **queued**
prefetch inherits the queue wait.

Low severity: the queue normally drains in milliseconds and the 10 s timeout
bounds the worst case. But on a slow connection with both slots busy, a click
waits behind two warms rather than going straight out. Fix is to have
`peekInFlight` return `null` until the entry holds a slot, so the nav fetches
directly. Not urgent, but the source comment should not claim a guarantee the
code does not make.

### 9. The probe reporter scores variant J before J's handler runs

In `pusha-probe`, the post-navigation report prints while `shopify:page:view`
is still pending, so J reads `INERT` in the table and then logs `init {why:
'shopify:page:view'}` immediately after. The measured conclusion in
`docs/STATE-2026-09-11.md` is unaffected — the `init` line is the evidence, not
the table — but anyone reading the auto-table would score the one variant that
*does* recover as dead. Delay the report past the dispatch, or have the reporter
re-read after a tick.

### 10. The suite is 11 s, and 4 s of that is two tests

`syncHeadStyles` waits out its real 2 s stylesheet-load cap twice, because
jsdom never fires `load` or `error` on an injected `<link>`. Same shape as the
script-load timer, which is `unref`'d. Not a product bug; it slows the loop.

### 11. Bucket H still reports the bridge snippet on a ported theme

One `decide` finding per finished port. Deliberate: the `H_shellBridge`
whitelist is narrow on purpose, and blanket-suppressing H by file would hide
real module-state findings. Revisit only if it becomes noise in practice.

---

## Deferred by decision

### 12. G6 — batching judgment calls

Documented in `SKILL.md` (Step 4.5) and untestable: no assertion proves an
agent presented findings in one block rather than twelve. `--action decide`
returning a complete batch is the closest real coverage, and it exists.
**Not a gap.** Listed so nobody re-opens it.

### 13. `@mimetic` scope

Unclaimed on npm and not ours. If the org is ever wanted, claiming it prevents
someone else publishing `@mimetic/pusha` and having `pusha init` write into a
developer's theme. Low probability, cheap insurance.
