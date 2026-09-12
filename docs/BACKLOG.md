# Backlog

Open work, ranked. Written 2026-09-11 at the end of a long session, so the
reasoning is recorded rather than just the task — the *why* is the part that
gets lost.

Closed items are not listed; `git log` has them. Numbers are stable identifiers,
not an ordering — a closed item leaves a gap rather than renumbering everything
below it, because other documents cite these by number.

---

## Blocking a public demo

### 1. Islands have never run in a browser

The rig has no `data-island` anywhere, so the hash-URL fix — the most
consequential bug in the last round — is only covered by a jsdom test.

**Rig is now built; the walk is what remains.** `snippets/pusha-island-test.liquid`
marks the product-information section as an island and carries a Liquid render
stamp, which is what makes the result readable: `now` renders server-side, so a
section served from the prefetch cache shows the time it was *warmed*, and
revalidation moves it forward. `__navAudit.islands()` in `assets/nav-audit.js`
warms, clicks, and reports.

The trap it exists to avoid: islands fire **only on a cached navigation**, so a
hover that is too short caches nothing, nothing fires, and the run looks like
islands failing rather than the setup failing. The instrument reports `cached`
alongside the result so that case is named rather than guessed at. It dispatches
`mouseover`, not `mouseenter` — the runtime delegates from `document` and only
sees bubbling events.

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

Two more were found and removed 2026-09-12 — "the moss audit" in
`shopify-xr-init.js` and "moss.min.js" in `theme-editor.js`, both comments.
Neither could have produced a console message, but reasoning from the absence
of the old name while two stale references sat in the tree is how this hunt
stays confusing. The tree is now clean apart from the one deliberate mention.

Possibly related, and now **fixed rather than open**: `Autofocus processing was
blocked because a document already has a focused element` on Horizon's
collection page was item 6. It turned out not to be benign — the message is the
browser *declining* to run autofocus on swapped-in content, so the attribute was
silently dead on every soft navigation and Pusha's focus-to-container then took
the focus the author had asked for. Pusha now applies it in the browser's place.
If the Moss message and the autofocus message were ever the same sighting, one
of them is now accounted for.

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

`CONTRIBUTING.md`, `CHANGELOG.md` and `SECURITY.md` landed 2026-09-12.
CONTRIBUTING carries the four-surfaces rule, because a contributor is the reader
most likely to change one surface and leave the other three. SECURITY routes
through GitHub private vulnerability reporting and names what is *not* a
vulnerability — the pixel gap and app code going inert are measured
limitations, and a triage queue that re-litigates them each time is worse than
one that says so up front.

**Still open, and both need a decision rather than typing:**

- No issue template.
- No security contact address. SECURITY.md deliberately has none rather than an
  invented one that would bounce. Add a real address or leave GitHub reporting
  as the only channel.
- `CLAUDE.md` is 55 KB of public strategy — it should be ~2 KB (what the
  project is, the commands, "the README is authoritative", the four-surfaces
  rule, the vocabulary rule) with the rest in the vault. The split is the
  decision: which sections are *rationale a contributor needs* and which are
  *studio strategy that should not be in a public repo at all*.
- `docs/STATE-2026-09-11.md` and `docs/questions-for-shopify-dev.md` still read
  as internal notes.

---

## Known bugs, none blocking

### 7. Deploy the probe reporter fix

`z-reporter.js` reported one `setTimeout(0)` after the swap, which is earlier
than `shopify:page:view` — the bridge resolves its module asynchronously. So
variant J, the only variant that recovers by listening for that event, read
`INERT` in every table while logging its own re-init three lines below. The
measured conclusion in `docs/STATE-2026-09-11.md` was never wrong (the `init`
line is the evidence, not the table), but the table said the sanctioned
vocabulary does not work.

**Fixed and committed**, not shipped: the report now waits for
`shopify:page:view` with a 250 ms fallback for themes whose importmap lacks the
entry. Extension assets need `shopify app deploy` before a run picks it up, so
until then the next probe reads the stale bundle.

One note on that repo: it has no remote, so its history is local only.

The stray outer git repo is **gone** (2026-09-12). `~/Work/pusha-probe` wrapped
the real repo at `~/Work/pusha-probe/pusha-probe`, and running git in the
wrapper reported an empty repository — which is how this backlog came to claim
the probe had no commits at all. It had zero commits, zero refs and zero
stashes, so nothing was lost.

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
