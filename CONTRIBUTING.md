# Contributing

Pusha is small and opinionated, and it is pre-1.0. The most useful contribution
right now is a theme it breaks on — a real Online Store 2.0 theme, the audit
output, and what went wrong in the browser.

## Setup

```sh
npm install
npm test          # node's test runner over test/*.test.ts, jsdom fixtures
npm run typecheck
npm run build     # vite ESM + UMD, then tsc for the .d.ts files
```

Node `^22.13.0 || >=24.0.0`. CI runs both, and it has caught a real difference
between them at least once — if a test passes locally and fails on 22.13, that
is a signal, not noise.

## The four surfaces must agree

`pusha init`, `pusha audit`, the skill (`skill/SKILL.md` + `skill/PATTERNS.md`),
and the README describe one contract to four different readers. Three of them
are consumed by an agent or a machine rather than a person, so a stale one does
not read as out of date — it reads as authoritative and wrong. An audit rule
that describes a removed config key teaches the removed key to every agent that
runs it.

Any change to config keys, defaults, hook or event names and payloads, bucket
rules or their remediation text, install layout, or the `--json` contract
touches all of these:

1. Source (`src/`) — the behaviour.
2. `bin/pusha.js` — `audit` rules and remediation, `init` writes.
3. `skill/SKILL.md` and `skill/PATTERNS.md` — procedure and patterns.
4. `README.md` — the documented contract, and the tie-breaker when two
   surfaces disagree.
5. Tests, including the audit golden files.

If one genuinely does not apply, say so in the commit message. Silence reads as
an oversight, because usually it is.

## Tests

Every bug fix gets a test that fails without the fix. Check that it does —
comment the fix out, watch it go red, put it back. A regression test that never
failed is decoration.

Assert on the damage, not on the mechanism. A test that asserts "no stray
request reached the wire" keeps working when the internals move; one that
asserts on a private counter breaks for reasons that are not bugs.

The jsdom fixture in `test/dom.ts` is deliberately thin. jsdom leaves some DOM
APIs undefined rather than warning, so a code path can be silently unreachable
from the suite — `Element.scrollIntoView` hid the whole hash branch of
`focus.ts` until it was stubbed. If a branch looks covered but has never gone
red, check that the API it depends on exists in the fixture.

## Commits

Write the reasoning, not the diff. The subject says what changed; the body says
what was true that made it necessary and what you ruled out. `git log` is where
this project keeps its reasoning, so a message that only restates the patch
throws that away.

## Browser verification

jsdom coverage is not browser coverage, and the gap is not theoretical: the
abort race, the navigation timeout, and hash-link handling all needed a real
browser to be believed. Anything touching navigation timing, focus, or
transitions should say in the commit message whether it was walked in a browser
or only tested in jsdom.

## Scope

Cart is theme code. Analytics is framework code. If you are not sure which side
of that line something falls on, the README's "Cart is theme code" section
explains the test being applied.
