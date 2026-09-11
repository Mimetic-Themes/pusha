# Backlog

Open work, ranked. Written 2026-09-11 at the end of a long session, so the
reasoning is recorded rather than just the task — the *why* is the part that
gets lost.

Closed items are not listed; `git log` has them.

---

## Blocking a public demo

### 1. Live-verify the three fixes a browser has not seen

The first live walk (Horizon on a dev store, 10 navigations) confirmed head
sync, cleanup-on-swap, same-URL scroll-to-top, stale-while-revalidate, and the
app-compat result. It did **not** exercise:

- **Fast triple-click** — the abort race. Click three links faster than the
  350 ms leave transition and confirm content matches the URL bar. Highest
  real-world exposure of anything fixed today, and jsdom is the least
  convincing place to prove it.
- **`href="#"`** — Horizon's localization selector and menu toggles. The
  theme's own handler must see the click.
- **Timeout fallback** — throttle to Offline mid-navigation. After 10 s it
  should fire `onNavError` and hand off to a real browser load.

### 2. Islands have never run in a browser

The rig has no `data-island` anywhere, so the hash-URL fix — the most
consequential bug in the last round — is only covered by a jsdom test. Mark a
price or badge region in a Horizon section and walk it.

### 3. Measure the Klaviyo claim before repeating it

`docs/apps/klaviyo.md` says Klaviyo tracks *Active on Site* and *Viewed
Product* through a snippet in its **app embed**, not through the Shopify pixel.
The README attributes browse-abandonment loss to the app pixel. If Klaviyo's
split is right the outcome still holds — a once-per-document snippet fires once
— but the channel is wrong and the fix is two lines of theme code rather than a
companion pixel. Measure on a store with Klaviyo installed before saying it
out loud.

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

Seen on Horizon's collection page. Pusha's focus-to-container beats the page's
own autofocus. Benign today; decide whether the a11y focus move should yield to
an explicit `[autofocus]` in the incoming content.

### 7. The suite is 11 s, and 4 s of that is two tests

`syncHeadStyles` waits out its real 2 s stylesheet-load cap twice, because
jsdom never fires `load` or `error` on an injected `<link>`. Same shape as the
script-load timer, which is `unref`'d. Not a product bug; it slows the loop.

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
