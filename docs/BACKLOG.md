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

### 3. Unidentified a11y console message mentioning Moss

Reported from a live walk; not reproduced. Nothing in the rig writes "Moss" to
the console, `assets/focus.js` is clean, and no `moss.*` file remains — so the
source is unknown. Capture the exact console line and its stack before chasing
it.

The rename sweep narrows this usefully: one deliberate mention now survives in
`pusha-horizon`, in the comment explaining the dead `window.Moss` guard, and it
is a comment. If the message appears again it did not come from the rig —
suspect a stale bundle, a cached asset, or the browser profile.

Possibly related and separately confirmed: `Autofocus processing was blocked
because a document already has a focused element` on Horizon's collection page
(see item 6).

---

## Publishing

### 4. npm publish

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

### 5. Repo hygiene

No `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, or issue template.
`CLAUDE.md` is 55 KB of public strategy — it should be ~2 KB (what the project
is, the commands, "the README is authoritative", the vocabulary rule) with the
rest in the vault. `docs/STATE-2026-09-11.md` and
`docs/questions-for-shopify-dev.md` still read as internal notes.

---

## Known bugs, none blocking

### 6. `Autofocus processing was blocked because a document already has a focused element`

Seen on Horizon's collection page, and **reproduced 2026-09-11** on a second
walk — same page, same message. Pusha's focus-to-container beats the page's own
autofocus. Benign today; decide whether the a11y focus move should yield to an
explicit `[autofocus]` in the incoming content.

### 7. Deploy the probe reporter fix

`z-reporter.js` reported one `setTimeout(0)` after the swap, which is earlier
than `shopify:page:view` — the bridge resolves its module asynchronously. So
variant J, the only variant that recovers by listening for that event, read
`INERT` in every table while logging its own re-init three lines below. The
measured conclusion in `docs/STATE-2026-09-11.md` was never wrong (the `init`
line is the evidence, not the table), but the table said the sanctioned
vocabulary does not work.

**Fixed in the working tree**, not shipped: the report now waits for
`shopify:page:view` with a 250 ms fallback for themes whose importmap lacks the
entry. Extension assets need `shopify app deploy` to take effect, and
`pusha-probe` still has no git history at all — decide both before the next
probe run, or the next run reads from the stale bundle.

### 8. Bucket H still reports the bridge snippet on a ported theme

One `decide` finding per finished port. Deliberate: the `H_shellBridge`
whitelist is narrow on purpose, and blanket-suppressing H by file would hide
real module-state findings. Revisit only if it becomes noise in practice.

---

## Deferred by decision

### 9. G6 — batching judgment calls

Documented in `SKILL.md` (Step 4.5) and untestable: no assertion proves an
agent presented findings in one block rather than twelve. `--action decide`
returning a complete batch is the closest real coverage, and it exists.
**Not a gap.** Listed so nobody re-opens it.

### 10. `@mimetic` scope

Unclaimed on npm and not ours. If the org is ever wanted, claiming it prevents
someone else publishing `@mimetic/pusha` and having `pusha init` write into a
developer's theme. Low probability, cheap insurance.
