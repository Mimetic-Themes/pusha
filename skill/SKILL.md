---
name: pusha
description: Port a Shopify Online Store 2.0 theme to the Pusha PJAX runtime. Audits sections, snippets, blocks, templates, layout and asset JS for soft-navigation compatibility, classifies each script by transformation difficulty, and produces diffs that wrap procedural JS in the `window.theme.sectionInits` registry. Invoke when the user says "port this theme to PJAX", "pusha audit", "wrap section scripts for Pusha", "make this theme PJAX-compatible", or names a theme directory and asks for a Pusha-readiness pass.
---

# pusha

Port a Shopify Online Store 2.0 theme to the Pusha PJAX runtime.

## Happy path (the common case)

For a typical Online Store 2.0 theme (Dawn-derived, no build pipeline):

1. **`pusha init`** — installs the Path A runtime (`assets/pusha.min.js` + `snippets/pusha.liquid`) and patches `layout/theme.liquid`.
2. **`pusha skill --claude`** (or `--cursor` / `--aider`) — installs this file and `PATTERNS.md` where the agent will find them.
3. **`pusha audit --json --action transform`** — the mechanical work queue. The full report classifies every script into buckets A–H and K, plus the surface buckets J (analytics), L (Liquid shell state), M (shell UI), P (partials) and X (theme app extensions).
4. **Work the queue**, one commit per file, on a branch. Apply `PATTERNS.md` routed by each finding's `location`. Anything not `action: transform` goes to the human, not into a guess.
5. **`shopify theme check`**, then re-run `pusha audit` and compare against the previous run.

The rest of this doc covers edge cases, install detection, the per-bucket transformation contract, and how to delegate worker agents. `pusha audit --full` appends the whole of `PATTERNS.md` to the report, which is the one-read way to hand a worker everything it needs. Skip to "Procedure" if the happy path is what you need.

## This skill is bring-your-own-agent

The skill ships rails, not a runtime. It provides:

- **`pusha audit`** (the Pusha CLI) — deterministic classifier. Runs without any LLM. Reproducible. Same buckets, richer analysis (class hierarchy resolution for portal-to-body custom elements, render-site mapping). Supports `--json` for structured output.
- `PATTERNS.md` — self-contained transformation knowledge readable cold by any agent.
- This file — the procedure that says when to audit, what to ask the user, and how to delegate the per-file transformation work.

**The agent that does the actual file edits is whatever's available** — a Claude Code subagent, a different LLM runtime, or a human pairing with one. The skill doesn't care. It hands each in-scope file + its classification + the relevant `PATTERNS.md` section to a worker and collects diffs back. The CLI is the only required tool.

## Two passes

1. **Audit** — classify every script in the theme by transformation difficulty. Produce a report. No edits.
2. **Transform** — delegate per-file work to agents. Apply mechanical wrappers (`sectionInits` registry, `data-section-type` roots, `root`-scoped queries, idempotency guards). Produce diffs, not in-place edits.

Always run the audit first. Don't transform until the user reviews the audit and approves the scope.

## When to use

- User points at a theme directory and asks for a Pusha-readiness check.
- User wants to wrap section/block scripts in the `sectionInits` registry pattern so a theme survives PJAX navigation.
- User asks "what would it take to port Dawn / Horizon / [theme name] to PJAX?"

Do NOT use this skill for:

- Building components from scratch in a Pusha-native theme (just write them against the registry directly).
- Debugging an already-ported theme (read `PATTERNS.md`'s "Runtime lifecycle" section for the runtime contract; flip `debug: true` in `snippets/pusha.liquid` for live `[pusha/*]` console output).
- Building Pusha itself — this skill is the consumer side, not the framework side.

## Procedure

### Step 1 — Locate the theme

The user will either pass a path or one is obvious from context. Confirm the path is a Shopify theme the same way the CLI does — **any one** of `layout/theme.liquid`, `sections/`, or `config/settings_schema.json`. Do not require all four of `sections/ snippets/ assets/ templates/`: new-Liquid themes have no `sections/` at all and would be rejected. If `shopify.theme.toml` exists, even better.

### Step 1.5 — Check Pusha install + detect path

Before auditing, check whether the Pusha runtime is installed in this theme:

- **Path B detection** — `package.json` exists and `@mimeticthemes/pusha` is in `dependencies`
- **Path A detection** — `assets/pusha.min.js` exists AND `snippets/pusha.liquid` exists

If Pusha is already installed, skip to Step 2.

If not installed, detect which path the theme is set up for and propose the matching install:

Pusha is not on a registry yet — every install comes from the git repository.
The package name is still `@mimeticthemes/pusha`, so imports are unaffected.

- `package.json` exists with `vite` in deps/devDeps → suggest Path B:
  ```bash
  npm install github:mimetic-themes/pusha
  # Add `import { initRuntime } from '@mimeticthemes/pusha'; initRuntime();` to your entry point
  ```
  **Path B installs no Liquid.** `pusha init` writes the snippet and patches the
  layout for Path A only, so on Path B the theme conventions are the dev's job
  and nothing warns when they are missing. Confirm all three before auditing:
  ```liquid
  <body data-template="{{ template }}">
    <main id="MainContent" data-page-container data-page-type="{{ template }}">
  ```
  Without `data-page-type` / `data-template`, `meta.template` is empty: named
  transitions stop matching and active-link body-class sync degrades, silently.
  There is also no config object and no default fade — both live in the snippet.
- Otherwise → suggest Path A:
  ```bash
  npx github:mimetic-themes/pusha init
  # Copies assets/pusha.min.js + snippets/pusha.liquid and offers to add {% render 'pusha' %}
  ```

The dev can override the recommendation. Both paths remain supported. Confirm install completed before proceeding to the audit — the wrapped scripts produced by Step 4 reference `window.theme.sectionInits`, which doesn't exist until Pusha is loaded.

### Step 2 — Run the audit

Run `pusha audit <theme-path>` (or `pusha audit` from inside the theme dir). The CLI ships with the Pusha package — run `npx github:mimetic-themes/pusha audit <path>` if it is not on `$PATH`. It scans the theme and emits a categorized report:

- **A. External `<script src="...">`** — safe, no transformation needed (`syncHeadScripts` in Pusha handles re-loading on PJAX nav)
- **B. JSON data `<script type="application/json">`** — safe, non-executable, no transformation
- **C. Custom elements with `disconnectedCallback`** — likely safe; audit cleanup completeness manually
- **D. Custom elements without `disconnectedCallback`** — needs cleanup added before PJAX nav will work reliably
- **E. Procedural inline scripts** — wrap in `sectionInits`
- **F. `{% javascript %}` blocks** — wrap in `sectionInits` unless already a custom element class definition
- **G. `DOMContentLoaded` handlers** — replace handler body with `sectionInits[handle](root)`
- **H. Module-level state / IIFE with closure state** — hard bucket, flag for human review
- **K. Portal-to-body custom elements** — class moves itself to `<body>` in `connectedCallback`; render sites need `data-pusha-cleanup` attribute. Hierarchy-resolved, so subclasses of portal classes are caught too.

Pass `--json` for structured output if you want to consume the audit programmatically. Read `PATTERNS.md` for the full transformation catalog.

### Step 3 — Present the audit to the user

Summarize counts per bucket. Call out the H bucket (hard) by name — these need human eyes before automation touches them. Ask the user to confirm scope: which buckets to transform automatically, which to defer.

**Read the `## Suppressed by whitelists` section too.** It lists every finding the audit classified but excluded. Each entry has the file, the matched pattern, and *why* the whitelist fired. This is the audit's "what's currently invisible to me" surface — review it the same way you'd review the live findings. If anything in there looks structurally different from the whitelist's intent (e.g., a `sectionInits[…]` registration whose body looks unusual), surface it to the user.

**When to run `pusha audit --no-whitelist`:**
- First audit of a theme you haven't seen before — verify the whitelist isn't hiding something pathological.
- First audit of a new branch where someone has touched sections/snippets/assets.
- Before a release / Theme Store submission — confirms no drift snuck in.
- Any time the `Suppressed by whitelists` section's content changes in shape (new file showing up, new H pattern match) since the previous run.

The whitelists are heuristic guards on syntax patterns — they trust the *registration shape* (`sectionInits[…] = function(root) {…}`) but cannot validate the *function body*. Periodically re-auditing with whitelists off catches drift the static check would otherwise hide.

### Step 4 — Transform (only after approval) — delegate to agents

**Drive from `--json`, not from the text report.** Every finding carries:

| Field | Use |
|---|---|
| `id` | Stable across the edits you make — line numbers are excluded from it. Address findings by `id`, record progress by `id`, and a half-finished port resumes cleanly. |
| `action` | `transform` → do it. `decide` → hand to the human. `verify` → needs a real storefront. `none` → **do not touch**. |
| `location` | Which fix applies. See `PATTERNS.md` → "Routing by location". Non-negotiable. |
| `bucket` | What the script is. |

`queue` gives the ids in work order, mechanical first. `doNotTransform` names the
buckets to leave alone. Fetch one slice per worker rather than the whole report:

```sh
pusha audit --json --action transform --file sections/
pusha audit --json --bucket E,G
pusha audit --json --action decide      # the batch for the human
```

For each in-scope file, **spawn a worker agent** with a tight, self-contained prompt:

- The file path
- The finding `id`, `bucket` **and `location`** — a worker without the location
  cannot route, and will wrap a shell script in `sectionInits`, where it will
  never run
- The matching section of `PATTERNS.md`, plus the routing entry for that location
- A directive: "if the script doesn't match the documented pattern, or the
  location is one you have no rule for, return `SKIP: <reason>`."

Run workers in parallel when possible — each is independent and operates on one file.

**Write into the theme, on a branch, one commit per file.** The human reviews the
diff, which is the point: they watch the port happen and steer it, rather than
triaging a pile of patches. Require a clean working tree before starting, and
never commit to the default branch. Record each finding `id` and its outcome
(transformed / skipped / deferred) in `.pusha/MANIFEST.md` so a later run can tell
new findings from ones already judged.

Rules workers must follow:
- Transformations come from `PATTERNS.md` verbatim. Do not improvise new wrapping shapes.
- Bucket H files do not get transformed by workers — they get the deferred-comment treatment described in `PATTERNS.md` "Resolving an H finding". Triage is a separate workflow.
- If a worker's diff would touch more than the single file it was assigned, return SKIP. Cross-file edits need orchestrator review.
- Output must be valid Liquid AND valid JS. The orchestrator validates downstream with `shopify theme check` (Step 5), so workers don't invoke it, but they must not introduce constructs that obviously break either side — unescaped `{{` or `{%` inside `{% javascript %}`, mismatched braces, stray semicolons in Liquid, multiple `{% javascript %}` blocks in one file, **literal `{% javascript %}` / `{% endjavascript %}` strings inside `{% comment %}` blocks or doc prose** (Shopify's section JS compiler scans the file as text and ignores comment boundaries — it will splice the comment contents into the compiled bundle). PATTERNS.md "E. Hard Shopify constraints on `{% javascript %}`" enumerates the rules.

### Example worker prompt

A concrete copy-pasteable template for one file in bucket E:

```
You are transforming a Shopify Online Store 2.0 section file to be PJAX-safe
for the Pusha runtime.

File: sections/announcement-bar.liquid
Finding: 4f2a91c0de11
Bucket: E (procedural inline <script>)
Location: section
Pattern: PATTERNS.md "E. Procedural inline `<script>`" + "Routing by location" → `section`

Source file:
<<< [paste file contents here] >>>

Instructions:
- Follow the pattern in PATTERNS.md exactly. Do not improvise new wrapping shapes.
- The Location above decides the fix. This prompt is the `section` case. If the
  file turns out not to be section scope, return SKIP rather than wrapping it.
- Use the section basename (`announcement-bar`) as the `data-section-type` and
  the `sectionInits` key.
- Move the inline `<script>` body into a single `{% javascript %}` block in the
  same file (one per file is a hard Shopify constraint — see PATTERNS.md E).
- Wrap the body in
  `window.theme.sectionInits['announcement-bar'] = function (root) { ... }`.
- Replace `document.querySelector(...)` with `root.querySelector(...)` so the
  same handle handles multiple section instances on one page.
- Add per-element `data-initialized` idempotency guards on every listener
  attachment (the handle re-fires on every PJAX swap AND on theme-editor
  `shopify:section:load`).
- If the script contains Liquid tokens (`{{` or `{%`) that can't survive
  inside `{% javascript %}`, OR the file already has an incompatible
  `{% javascript %}` block, return only: `SKIP: <one-line reason>`.

Output: the edited file, and nothing else. No commentary.
```

Substitute the file, bucket, **location** and pattern reference per-invocation. The
orchestrator runs these in parallel, commits each result separately, and writes
`.pusha/MANIFEST.md` tagging each finding id as transformed / skipped / deferred.

### Step 4.5 — Batch the judgment calls, don't dribble them

Everything the audit marks `action: decide` goes to the human **in one block**,
after the mechanical work is committed — not one interruption per finding. A port
produces dozens of these; asked one at a time they stop being decisions and
become a queue the human rubber-stamps.

```sh
pusha audit --json --action decide
```

For each, give: the finding `id`, the file and line, the audit's own line quoted,
the surrounding code, and the options with a recommendation. Then stop and wait.
Never pick a `decide` on the agent's own authority — that is the difference
between the human steering the port and merely watching it happen.

Typical members of this batch: bucket L `ask` findings (does this shell value
need to be live?), bucket M custom modals (does it already own its close
behaviour?), bucket X at-risk app blocks (opt the page out, or ask the vendor?),
bucket H reachability, and any `include` whose render context you could not
determine.

### Step 4.6 — Re-running against an already-ported theme

The skill must be idempotent, and it must survive an upstream merge (Shopify
ships a new Dawn; the fork rebases).

1. Read `.pusha/MANIFEST.md` first. It is keyed by finding `id`, and ids are
   stable across the edits a port makes.
2. Run the audit. Any `id` already recorded as transformed or skipped is
   **settled** — do not re-open it, and do not re-ask a `decide` the human
   already answered.
3. Work only ids absent from the manifest. Those are genuinely new: upstream
   added code, or a file changed enough that its finding is materially different.
4. An id that vanished is not automatically a success — confirm it went away
   because the file was ported, not because the file was deleted upstream.

### Step 5 — Validate

With the transform commits on the branch, run two checks in this order:

**5a — `shopify theme check`** (required, not optional).

It surfaces Liquid syntax errors, malformed `{% javascript %}` blocks, and JS parse failures inside section/snippet scripts. A wrapping that looks correct in the diff can still produce a `{% javascript %}` block that fails to render — extra brace, dangling token, accidental `{{` interpolation. The browser symptom is silent, and silent by default: the diagnostic
`[pusha/init] no sectionInits handler for "<handle>"` only prints with
`debug: true` set in `snippets/pusha.liquid`. **Turn it on before validating.**
Without it there is no error at all, because the entire `{% javascript %}` tag silently dropped and the registration never executed. `pusha audit` cannot catch this — it inspects source shape, not rendered Liquid.

Run it from the theme root:

```bash
shopify theme check
```

Treat any `error`-severity finding in sections/snippets the skill touched as a blocker. Style warnings (`UnusedAssign`, `MissingTemplate` in unrelated files, etc.) can be ignored. If `shopify` isn't on `$PATH`, the dev needs Shopify CLI installed — surface that as a blocker, don't skip the step.

**5b — `pusha audit`** (progress check, not a pass/fail gate).

**A correctly ported file should disappear from the queue.** Two whitelists make
that true, and both only fire on the exact ported shape:

- an F2 whose `{% javascript %}` body contains *nothing but* `sectionInits` /
  `sectionDestroy` registrations
- an E or G finding in a file that also calls `window.Pusha.on*` — the bridge
  shape this skill tells you to write

So a finished port audits with an empty `transform` queue:

```sh
pusha audit --json --action transform      # expect count: 0
```

If a file you transformed is still in the queue, the wrapper is not the
documented shape — most often procedural statements left at the top level of the
`{% javascript %}` body alongside the registration. Read
`## Suppressed by whitelists` to see what the audit *did* accept, and
`--no-whitelist` to see everything raw.

Judge completion by the queue plus `.pusha/MANIFEST.md`, and treat these as real
problems: a finding that moved to a *different* bucket than before, a new `id` in
a file you just edited, or a count that went up.

## Output contract

- Audit report: stdout, structured by bucket, includes file path + line range + classification per script.
- Transform output: one commit per source file on a working branch, plus `.pusha/MANIFEST.md` keyed by finding `id`, listing what was changed, what was skipped and why, and what was deferred to the human.
- Never edit `theme/` files in place. The user applies patches manually.

## What this skill is NOT

- Not a build tool. It doesn't bundle, compile, or install dependencies.
- Not a runtime. It produces source-level changes; the Pusha runtime is a separate package the theme depends on.
- Not a one-shot rewriter. It is a conservative auditor + targeted transformer. Anything ambiguous defers to the human.
- Not an MCP server, not a CLI, not a library. It's a procedure document plus `PATTERNS.md`, driven by the `pusha audit` CLI. Bring your own agent.

## Runtime contract reference

`PATTERNS.md` "Runtime lifecycle" inlines the call graph an agent needs to reason about wrapped scripts. The runtime source itself ships in `node_modules/@mimeticthemes/pusha/dist/pusha.esm.js` (and `pusha.min.js` for Path A) — typed via `dist/index.d.ts` if your agent has TypeScript access. When in doubt about behaviour, the source is the contract.

## Optional: enriched audit with Shopify API context

If the agent running this skill has Shopify API tools available — typically because the dev has independently installed the Shopify AI toolkit and connected Claude to a store (dev or production) — the skill should opportunistically use them to extend the audit beyond the local file system. This is **not required**. The skill works fine with only local file access; API context is additional signal when it happens to be in the room.

### Detect availability

Look for Shopify-namespaced MCP tools in the running session (typical naming: `mcp__shopify-admin__*`, `mcp__shopify-storefront__*`, or similar). If present, the agent can:

- **List installed apps** — Admin API. Cross-reference against a curated PJAX-compatibility list (when one exists).
- **Inspect theme app extension blocks** — what app embeds are enabled, where they render.
- **Read `script_tags.json`** — runtime-injected `<script>` tags from apps that use the Script Tag API.
- **Fetch a sample storefront page** — see what JS actually loads on a rendered page, including app-injected scripts that aren't visible in theme files.

### What this adds to the audit

The local file audit (`pusha audit`) has a structural blind spot: it can't see scripts injected by installed apps. With API context, the agent can render a real page and inspect what scripts actually loaded, then add an additional bucket to the audit report:

- **I. Third-party app scripts** — listed by source app, with PJAX-compatibility verdict where known.

Bucket X findings are **never transformed** — see `PATTERNS.md` → "X. Theme app
extensions". Measured: exactly two app-block shapes survive a swap (one that
listens for `shopify:page:view`, and one authored as a custom element), and every
other loading shape goes inert identically. If the merchant owns the app, the fix
belongs in the app and the agent writes it up for the vendor. If not, the options
are `data-no-transition` around the navigation or treating the page as ineligible.
Never enable `appCompat.*` on an agent's initiative — `reexecuteExtensionScripts`
is measured harmful, and the two flags compound multiplicatively.

### Connection to local file audit

The agent should not duplicate work. If `content_for_header`, `{% content_for %}` tags, or `@app` block schemas appear in the local audit, the API-context check fills in *what's actually behind them*. The local audit says "this is a render point for apps"; the API check says "and these specific apps are rendering here right now."

Without API context, the skill flags app render points as out-of-scope and recommends manual smoke-testing the live storefront. With API context, the skill produces an itemized list.
