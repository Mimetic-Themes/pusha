---
name: pusha
description: Port a Shopify Online Store 2.0 theme to the Pusha PJAX runtime. Audits sections, snippets, and asset JS for PJAX compatibility, classifies each script by transformation difficulty, and produces diffs that wrap procedural JS in the `window.theme.sectionInits` registry. Invoke when the user says "port this theme to PJAX", "pusha audit", "wrap section scripts for Pusha", "make this theme PJAX-compatible", or names a theme directory and asks for a Pusha-readiness pass.
---

# pusha

Port a Shopify Online Store 2.0 theme to the Pusha PJAX runtime.

## Happy path (the common case)

For a typical Online Store 2.0 theme (Dawn-derived, no build pipeline):

1. **`pusha init`** — installs the Path A runtime (`assets/pusha.min.js` + `snippets/pusha.liquid`) and patches `layout/theme.liquid`.
2. **`pusha audit`** — classifies every script into buckets A–H, K, and reports the surface buckets (J analytics, L Liquid shell state, M shell UI, P partials). Most Dawn-shaped themes land mostly in A/B/C (safe) with a handful of E/G/H findings.
3. **Read this skill** (or your agent does) — produces unified diffs in `./pusha-diffs/`, one per file, wrapping bucket E/F2/G scripts into `window.theme.sectionInits[handle] = function (root) { ... }`. No theme files edited in place.
4. **Apply diffs with `git apply`**, run `shopify theme check` to catch any Liquid or JS errors introduced by the wrapping, then re-run `pusha audit` to confirm everything moved into safe buckets.

The rest of this doc covers edge cases, install detection, the per-bucket transformation contract, and how to delegate worker agents. Skip to "Procedure" if the happy path is what you need.

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

The user will either pass a path or one is obvious from context. Confirm the path is a Shopify theme by checking for `sections/`, `snippets/`, `assets/`, and `templates/` at the root. If `shopify.theme.toml` exists, even better.

### Step 1.5 — Check Pusha install + detect path

Before auditing, check whether the Pusha runtime is installed in this theme:

- **Path B detection** — `package.json` exists and `@mimetic/pusha` is in `dependencies`
- **Path A detection** — `assets/pusha.min.js` exists AND `snippets/pusha.liquid` exists

If Pusha is already installed, skip to Step 2.

If not installed, detect which path the theme is set up for and propose the matching install:

Pusha is not on a registry yet — every install comes from the git repository.
The package name is still `@mimetic/pusha`, so imports are unaffected.

- `package.json` exists with `vite` in deps/devDeps → suggest Path B:
  ```bash
  npm install github:mimetic-themes/pusha
  # Add `import { initRuntime } from '@mimetic/pusha'; initRuntime();` to your entry point
  ```
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

For each in-scope file, **spawn a worker agent**. Each worker gets a tight, self-contained prompt:

- The file path
- Its classification bucket (A–H) from the audit
- The matching section of `PATTERNS.md` for that bucket
- A directive: "produce a unified diff against this file. Do not edit in place. If the script doesn't match the documented pattern, return a `SKIP: <reason>` line instead of a diff."

Run workers in parallel when possible — each is independent, operates on one file, returns one diff. The orchestrating agent (the one running this skill) collects the diffs into `./pusha-diffs/` plus a manifest of what transformed, what skipped, and why.

Do not write to the theme directory. The user applies patches manually with `git apply` (assumes the theme is in a git repo with a clean working tree).

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
Bucket: E (procedural inline <script> in section/snippet — wrap)
Pattern: PATTERNS.md "E. Procedural inline `<script>` in section/snippet — wrap"

Source file:
<<< [paste file contents here] >>>

Instructions:
- Follow the pattern in PATTERNS.md exactly. Do not improvise new wrapping shapes.
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

Output: a unified diff against the original file, and nothing else. No commentary.
```

Substitute the file, bucket, and pattern reference per-invocation. The orchestrator runs these in parallel, collects diffs into `./pusha-diffs/<theme>/`, and writes a `MANIFEST.md` tagging each file as transformed / skipped / deferred.

### Step 5 — Validate

After the user applies patches with `git apply`, run two checks in this order:

**5a — `shopify theme check`** (required, not optional).

It surfaces Liquid syntax errors, malformed `{% javascript %}` blocks, and JS parse failures inside section/snippet scripts. A wrapping that looks correct in the diff can still produce a `{% javascript %}` block that fails to render — extra brace, dangling token, accidental `{{` interpolation. The browser symptom is silent: `[pusha/init] no sectionInits handler for "<handle>"` with no other error, because the entire `{% javascript %}` tag silently dropped and the registration never executed. `pusha audit` cannot catch this — it inspects source shape, not rendered Liquid.

Run it from the theme root:

```bash
shopify theme check
```

Treat any `error`-severity finding in sections/snippets the skill touched as a blocker. Style warnings (`UnusedAssign`, `MissingTemplate` in unrelated files, etc.) can be ignored. If `shopify` isn't on `$PATH`, the dev needs Shopify CLI installed — surface that as a blocker, don't skip the step.

**5b — `pusha audit`** (idempotency check).

Wrapped scripts should classify into the same "safe" buckets as their already-wrapped counterparts. Anything that re-classifies as needing transformation again is a bug in the skill — report and don't double-wrap.

## Output contract

- Audit report: stdout, structured by bucket, includes file path + line range + classification per script.
- Transform output: one `.patch` file per source file under `./pusha-diffs/`, plus a manifest listing what was changed and what was deferred.
- Never edit `theme/` files in place. The user applies patches manually.

## What this skill is NOT

- Not a build tool. It doesn't bundle, compile, or install dependencies.
- Not a runtime. It produces source-level changes; the Pusha runtime is a separate package the theme depends on.
- Not a one-shot rewriter. It is a conservative auditor + targeted transformer. Anything ambiguous defers to the human.
- Not an MCP server, not a CLI, not a library. It's a procedure document + a bash script. Bring your own agent.

## Runtime contract reference

`PATTERNS.md` "Runtime lifecycle" inlines the call graph an agent needs to reason about wrapped scripts. The runtime source itself ships in `node_modules/@mimetic/pusha/dist/pusha.esm.js` (and `pusha.min.js` for Path A) — typed via `dist/index.d.ts` if your agent has TypeScript access. When in doubt about behaviour, the source is the contract.

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

Bucket I findings are **never auto-transformed**. They get triaged manually: the dev decides whether to keep the app, exclude its pages from PJAX with `data-no-transition`, or contact the app vendor about PJAX support.

### Connection to local file audit

The agent should not duplicate work. If `content_for_header`, `{% content_for %}` tags, or `@app` block schemas appear in the local audit, the API-context check fills in *what's actually behind them*. The local audit says "this is a render point for apps"; the API check says "and these specific apps are rendering here right now."

Without API context, the skill flags app render points as out-of-scope and recommends manual smoke-testing the live storefront. With API context, the skill produces an itemized list.
