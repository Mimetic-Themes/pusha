#!/usr/bin/env node
// Pusha CLI. v0.1 ships `init`, `audit`, and `skill`. The Vite-based install
// path remains stubbed.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
const SKILL_DIR = resolve(PACKAGE_ROOT, 'skill');
const SKILL_MD_PATH = join(SKILL_DIR, 'SKILL.md');
const PATTERNS_MD_PATH = join(SKILL_DIR, 'PATTERNS.md');
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();
const VERSION_MARKER_RE = /<!--\s*@pusha-skill-version:\s*([^\s>]+)\s*-->/;
const versionMarker = () => `<!-- @pusha-skill-version: ${PACKAGE_VERSION} -->`;

const HELP = `Pusha v${PACKAGE_VERSION} — instant page transitions for Shopify Online Store 2.0 themes.

Usage:
  pusha init  [options]            Install Pusha into the current Shopify theme
  pusha audit [path] [options]     Audit a theme's scripts for Pusha-readiness
  pusha skill [options]            Print or install the pusha agent skill
  pusha --help                     Show this message

init options:
  --dry-run             Print actions without writing
  --force               Overwrite existing files without prompting
  --yes, -y             Accept the layout edit prompt

audit options:
  --json                Emit machine-readable JSON instead of text
  --bucket <A,B,...>    Only these buckets          (--json only)
  --action <name,...>   Only these actions          (--json only)
                        transform | decide | verify | none
  --file <substring>    Only findings whose path contains this  (--json only)
  --full                Append the full PATTERNS.md to the audit output (one
                        self-contained doc an agent can absorb in one read)
  --no-whitelist        Disable false-positive filters (canonical Pusha patterns,
                        Pusha-self files, fallback DOMContentLoaded handlers)
                        and show all raw findings
  --help                Detail on the JSON contract and the filters
  path                  Theme directory to audit (defaults to cwd)

skill options:
  --print               Print SKILL.md + PATTERNS.md to stdout
  --claude              Install for Claude Code (.claude/skills/pusha/)
  --cursor              Install for Cursor    (.cursor/rules/pusha.md)
  --aider               Install for Aider     (.aider-conventions.md, appended)
  --global              Install into ~/ instead of project-local
  --force               Overwrite existing skill files without prompting

  Combine agents:  pusha skill --claude --cursor
  Global install:  pusha skill --claude --global

Pusha is not published yet — install it from the repository:
  npm install github:mimetic-themes/pusha

Docs: https://github.com/mimetic-themes/pusha
`;

const AUDIT_USAGE = `
pusha audit — classify a theme's scripts for Pusha-readiness.

  pusha audit [path] [options]

The report is written to be consumed by a coding agent. Every finding in --json
carries:

  id        stable across the edits the agent itself makes — line numbers are
            excluded from it on purpose, so progress survives a rewrite
  action    what the agent should do:
              transform  apply the documented fix; the rule is in
                         remediationByLocation or bucketRules
              decide     do not guess — surface it to the human with context
              verify     not answerable from source; check on a real storefront
              none       already safe, or not yours to change; do not edit
  bucket    the classification, explained in bucketRules
  file,line where it is (line is for humans; address findings by id)

Top level adds \`queue\`: finding ids in work order, mechanical first, with every
action:none finding omitted. \`doNotTransform\` names the buckets an agent must
leave alone and why.

Filters (--json only) cut the payload to the slice you are about to work on,
which is the difference between one agent reading everything and an
orchestrator handing each worker its own queue:

  pusha audit --json --action transform          # the whole mechanical queue
  pusha audit --json --bucket E,G --file sections/
  pusha audit --json --action decide             # what the human must rule on

A filtered response drops the whitelists, app surfaces and analytics blocks,
and carries bucketRules and remediationByLocation for the matched buckets only.

Examples:
  pusha audit                        # full text report
  pusha audit ../dawn --json         # everything, structured
  pusha audit --full                 # text report plus PATTERNS.md inline
`;

// ─── tiny logger ────────────────────────────────────────────────────────────
const log = {
  step: (msg) => console.log(`  ${msg}`),
  add:  (msg) => console.log(`+ ${msg}`),
  same: (msg) => console.log(`= ${msg}`),
  warn: (msg) => console.log(`! ${msg}`),
  err:  (msg) => console.error(`✖ ${msg}`),
  ok:   (msg) => console.log(`✓ ${msg}`),
  blank: () => console.log(''),
};

// ─── readline-based prompts (no deps) ───────────────────────────────────────
function ask(question, { defaultYes = false } = {}) {
  // Non-interactive stdin (CI, a coding agent, a pipe, `< /dev/null`): there is
  // nobody to answer. Take the default and say so, rather than hanging forever
  // or dying with "Detected unsettled top-level await".
  if (!process.stdin.isTTY) {
    console.log(`${question}${defaultYes ? ' [Y/n]' : ' [y/N]'} ${defaultYes ? 'Y' : 'N'} (non-interactive, using default)`);
    return Promise.resolve(defaultYes);
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
    rl.question(question + suffix, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === '') return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
  });
}

// ─── Path A install ─────────────────────────────────────────────────────────

function detectShopifyTheme(cwd) {
  const markers = [
    'layout/theme.liquid',
    'sections',
    'config/settings_schema.json',
  ];
  return markers.some((m) => existsSync(join(cwd, m)));
}

function readSafe(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function buffersEqual(a, b) {
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.equals(b);
}

async function copyOrSkip(srcAbs, destAbs, { force, dryRun }) {
  const existing = readSafe(destAbs);
  const incoming = readSafe(srcAbs);
  if (!incoming) {
    log.err(`source missing: ${srcAbs}`);
    process.exit(1);
  }
  if (existing && buffersEqual(existing, incoming)) {
    log.same(`${destAbs} (already up to date)`);
    return false;
  }
  // Check dry-run BEFORE prompting: a run that writes nothing has no reason to
  // ask permission to overwrite.
  if (dryRun) {
    log.add(`${destAbs} (dry-run, would ${existing ? 'overwrite' : 'create'})`);
    return true;
  }
  if (existing && !force) {
    const ok = await ask(`  ${destAbs} exists with different content. Overwrite?`);
    if (!ok) {
      log.warn(`skipped ${destAbs}`);
      return false;
    }
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  copyFileSync(srcAbs, destAbs);
  log.add(destAbs);
  return true;
}

const RENDER_TAG = `{% render 'pusha' %}`;

function alreadyHasRender(themeLiquid) {
  // Tolerate single quotes, double quotes, and "pusha.liquid" form.
  return /\{\%-?\s*render\s+['"]pusha(?:\.liquid)?['"]/.test(themeLiquid);
}

// Insert {% render 'pusha' %} as early as possible inside <head>, but never
// after another deferred <script src> — order matters because deferred scripts
// execute in document order. If pusha.min.js loads after animations.js, then
// `if (window.Pusha)` guards in animations.js evaluate to false (Pusha isn't
// loaded yet) and the script silently falls through to its DOMContentLoaded
// fallback. Pusha is effectively disabled for everything that loaded earlier.
//
// Strategy:
//   1. If there's a <script src=> inside <head>, insert just before the first one.
//   2. Else if <head> exists, insert immediately after the opening <head ...> tag.
//   3. Else fall back to inserting before </head> (last-resort).
function insertIntoHead(themeLiquid) {
  const headOpenMatch = themeLiquid.match(/<head\b[^>]*>/i);
  const headCloseIdx = themeLiquid.search(/<\/head>/i);
  if (!headOpenMatch || headCloseIdx === -1) return null;

  const headOpenEnd = (headOpenMatch.index ?? 0) + headOpenMatch[0].length;
  const headInner = themeLiquid.slice(headOpenEnd, headCloseIdx);
  const firstScriptInHead = headInner.search(/<script\b[^>]*\bsrc=/i);

  let anchor;
  if (firstScriptInHead !== -1) {
    anchor = headOpenEnd + firstScriptInHead;
  } else {
    anchor = headOpenEnd;
  }

  // Insert at the start of the anchor line so we don't duplicate its indent.
  const lineStart = themeLiquid.lastIndexOf('\n', anchor) + 1;
  const beforeOnLine = themeLiquid.slice(lineStart, anchor);
  const indent = /^\s*$/.test(beforeOnLine) ? beforeOnLine : '  ';

  return themeLiquid.slice(0, lineStart) + `${indent}${RENDER_TAG}\n` + themeLiquid.slice(lineStart);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Detect the main content container per shopify.dev guidance:
//   1. Skip-link target (most authoritative — accessibility-driven)
//   2. <main id="..."> (Dawn / OS 2.0 convention)
//   3. element with role="main" carrying an id
function detectContainerId(themeLiquid) {
  // Skip link — `<a … href="#X" … class="…skip…">` in either attribute order.
  const skipPatterns = [
    /<a[^>]*\bhref=['"]#([A-Za-z0-9_-]+)['"][^>]*\bclass=['"][^'"]*\bskip[^'"]*['"]/i,
    /<a[^>]*\bclass=['"][^'"]*\bskip[^'"]*['"][^>]*\bhref=['"]#([A-Za-z0-9_-]+)['"]/i,
  ];
  for (const re of skipPatterns) {
    const m = themeLiquid.match(re);
    if (m) return { id: m[1], via: 'skip link' };
  }
  const mainMatch = themeLiquid.match(/<main[^>]*\bid=['"]([^'"]+)['"]/i);
  if (mainMatch) return { id: mainMatch[1], via: '<main id>' };
  const roleMatch =
    themeLiquid.match(/<\w+[^>]*\brole=['"]main['"][^>]*\bid=['"]([^'"]+)['"]/i) ??
    themeLiquid.match(/<\w+[^>]*\bid=['"]([^'"]+)['"][^>]*\brole=['"]main['"]/i);
  if (roleMatch) return { id: roleMatch[1], via: '[role="main"]' };
  return null;
}

const CONTAINER_ATTRS = `data-page-container data-page-type="{{ template }}"`;

function patchContainerElement(themeLiquid, id) {
  const tagPattern = new RegExp(`<(\\w+)([^>]*\\bid=['"]${escapeRegExp(id)}['"][^>]*)>`, 'i');
  const match = themeLiquid.match(tagPattern);
  if (!match) return { themeLiquid, status: 'not-found' };
  if (/\bdata-page-container\b/i.test(match[0])) {
    return { themeLiquid, status: 'already-patched' };
  }
  const replaced = match[0].replace(/>$/, ` ${CONTAINER_ATTRS}>`);
  return { themeLiquid: themeLiquid.replace(match[0], replaced), status: 'patched' };
}

function patchBodyElement(themeLiquid) {
  const match = themeLiquid.match(/<body([^>]*)>/i);
  if (!match) return { themeLiquid, status: 'not-found' };
  if (/\bdata-template\b/i.test(match[0])) {
    return { themeLiquid, status: 'already-patched' };
  }
  const replaced = match[0].replace(/>$/, ` data-template="{{ template }}">`);
  return { themeLiquid: themeLiquid.replace(match[0], replaced), status: 'patched' };
}

// All layout edits in one pass — head insert, container patch, body patch.
// Single read, single write, single confirmation prompt.
async function applyLayoutEdits(cwd, { yes, dryRun }) {
  const layoutPath = join(cwd, 'layout/theme.liquid');
  if (!existsSync(layoutPath)) {
    log.warn(`layout/theme.liquid not found — apply these manually:`);
    log.blank();
    console.log(`    ${RENDER_TAG}                          (in <head>)`);
    console.log(`    <main id="MainContent" ${CONTAINER_ATTRS}>`);
    console.log(`    <body … data-template="{{ template }}">`);
    log.blank();
    return;
  }

  const original = readFileSync(layoutPath, 'utf8');
  let working = original;

  // Plan the edits without applying — so we can report and prompt once.
  const plan = [];
  const warnings = [];

  // 1. <head> insert
  if (alreadyHasRender(working)) {
    plan.push({ kind: 'head', status: 'already' });
  } else {
    const inserted = insertIntoHead(working);
    if (inserted === null) {
      warnings.push(`<head> not found — paste \`${RENDER_TAG}\` near the top of <head> (before any <script src>) manually.`);
      plan.push({ kind: 'head', status: 'no-target' });
    } else {
      plan.push({ kind: 'head', status: 'will-patch', preview: RENDER_TAG });
    }
  }

  // 2. Container element
  const detected = detectContainerId(working);
  if (!detected) {
    warnings.push(
      `couldn't find a main container (no skip link, <main id>, or [role="main"]).\n` +
      `    Add \`${CONTAINER_ATTRS}\` to your main content element manually.`,
    );
    plan.push({ kind: 'container', status: 'no-target' });
  } else {
    const test = patchContainerElement(working, detected.id);
    if (test.status === 'not-found') {
      warnings.push(
        `detected container id "#${detected.id}" via ${detected.via} but no element with that id exists.`,
      );
      plan.push({ kind: 'container', status: 'no-target' });
    } else if (test.status === 'already-patched') {
      plan.push({ kind: 'container', status: 'already', id: detected.id });
    } else {
      plan.push({ kind: 'container', status: 'will-patch', id: detected.id, via: detected.via });
    }
  }

  // 3. <body>
  const bodyTest = patchBodyElement(working);
  if (bodyTest.status === 'not-found') {
    warnings.push(`<body> tag not found — add \`data-template="{{ template }}"\` manually.`);
    plan.push({ kind: 'body', status: 'no-target' });
  } else if (bodyTest.status === 'already-patched') {
    plan.push({ kind: 'body', status: 'already' });
  } else {
    plan.push({ kind: 'body', status: 'will-patch' });
  }

  // 4. <body class="template-..."> sniff. Pusha syncs body[data-template] on
  // every PJAX nav but does NOT overwrite body.className — themes that rely on
  // a `template-product` / `template-collection` class for CSS targeting will
  // see those classes freeze to the first-loaded page. Warn the dev to either
  // (a) rewrite CSS selectors to `body[data-template="product"]`, or (b)
  // accept that body classes are stale and the data attribute is the live one.
  const bodyMatch = working.match(/<body([^>]*)>/i);
  if (bodyMatch && /\btemplate-\{\{\s*template/.test(bodyMatch[0])) {
    warnings.push(
      `<body> uses class="template-{{ template.name }}" pattern.\n` +
      `    Pusha syncs [data-template] on every navigation but not body.className.\n` +
      `    Rewrite CSS selectors that target \`.template-X\` to \`[data-template="X"]\`,\n` +
      `    or accept that those class names freeze to the first-loaded page.`,
    );
  }

  const willPatchAny = plan.some((p) => p.status === 'will-patch');
  if (!willPatchAny) {
    plan.forEach((p) => {
      if (p.status === 'already') log.same(`${layoutPath} (${p.kind} already patched)`);
    });
    warnings.forEach((w) => log.warn(w));
    return;
  }

  log.blank();
  console.log(`  Layout edits planned for ${layoutPath}:`);
  for (const p of plan) {
    if (p.status !== 'will-patch') continue;
    if (p.kind === 'head') console.log(`    + insert ${RENDER_TAG} near top of <head> (before any deferred <script src>)`);
    if (p.kind === 'container') console.log(`    + add \`${CONTAINER_ATTRS}\` to #${p.id} (detected via ${p.via})`);
    if (p.kind === 'body') console.log(`    + add \`data-template="{{ template }}"\` to <body>`);
  }
  log.blank();

  const proceed = yes || dryRun || (await ask(`  Apply these edits?`, { defaultYes: true }));
  if (!proceed) {
    log.warn(`skipped layout edits`);
    warnings.forEach((w) => log.warn(w));
    return;
  }

  // Apply in order. Each helper returns the updated content.
  for (const p of plan) {
    if (p.status !== 'will-patch') continue;
    if (p.kind === 'head') working = insertIntoHead(working) ?? working;
    if (p.kind === 'container') working = patchContainerElement(working, p.id).themeLiquid;
    if (p.kind === 'body') working = patchBodyElement(working).themeLiquid;
  }

  if (dryRun) {
    log.add(`${layoutPath} (dry-run, ${plan.filter((p) => p.status === 'will-patch').length} edit(s) not written)`);
  } else {
    writeFileSync(layoutPath, working);
    log.add(`${layoutPath} (${plan.filter((p) => p.status === 'will-patch').length} edit(s) applied)`);
  }

  // Heads-up if the detected container isn't the default '#MainContent'.
  const containerStep = plan.find((p) => p.kind === 'container');
  if (containerStep?.id && containerStep.id !== 'MainContent') {
    log.warn(
      `your container is #${containerStep.id}, not #MainContent.\n` +
      `    Edit snippets/pusha.liquid and set:\n` +
      `      window.theme.config.containerSelector = '#${containerStep.id}';`,
    );
  }
  warnings.forEach((w) => log.warn(w));
}

async function runInit(args) {
  const flags = {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    yes: args.includes('--yes') || args.includes('-y'),
  };

  const cwd = process.cwd();

  if (!detectShopifyTheme(cwd)) {
    log.err(`${cwd} doesn't look like a Shopify theme.`);
    log.warn(`expected one of: layout/theme.liquid, sections/, config/settings_schema.json`);
    log.warn(`re-run with --force from a theme root`);
    if (!flags.force) process.exit(1);
  }

  if (flags.dryRun) {
    log.warn('dry-run mode — no files will be written');
    log.blank();
  }

  const distSrc = join(PACKAGE_ROOT, 'dist/pusha.min.js');
  const snippetSrc = join(PACKAGE_ROOT, 'snippets/pusha.liquid');

  if (!existsSync(distSrc)) {
    log.err(`${distSrc} missing — run \`npm run build\` first or reinstall the package.`);
    process.exit(1);
  }
  if (!existsSync(snippetSrc)) {
    log.err(`${snippetSrc} missing — package install looks corrupted.`);
    process.exit(1);
  }

  log.step(`installing Pusha into ${cwd}`);
  log.blank();

  await copyOrSkip(distSrc, join(cwd, 'assets/pusha.min.js'), flags);
  await copyOrSkip(snippetSrc, join(cwd, 'snippets/pusha.liquid'), flags);

  await applyLayoutEdits(cwd, flags);

  log.blank();
  if (flags.dryRun) {
    log.ok('dry-run complete. No files were written. Re-run without --dry-run to apply.');
  } else {
    log.ok('done. Commit the changes and reload your theme to see Pusha in action.');
  }
}

// ─── audit ──────────────────────────────────────────────────────────────────
// Canonical audit. Greppable buckets A–H plus J (analytics surface), K
// (portal-to-body custom
// elements with class-hierarchy resolution). Two output modes: human-readable
// text (default), or `--json` for agent consumption.
//
// Buckets:
//   A. external <script src="...">              — safe, no transformation
//   B. JSON data <script type="application/json">— safe, non-executable
//   C. custom element with disconnectedCallback  — safe (verify cleanup)
//   D. custom element without disconnectedCallback + external refs — needs cleanup
//   E. procedural inline <script>                — wrap in sectionInits
//   F. {% javascript %} block                    — wrap unless custom element
//   G. DOMContentLoaded handler                  — replace with sectionInits
//   H. module-level state / IIFE with closure    — hard, human review

// ─── Whitelists ─────────────────────────────────────────────────────────────
// Each whitelist entry suppresses audit findings that would otherwise be
// false positives. They're collected here so they're greppable and so the
// audit can report which ones are active. Pass `--no-whitelist` to disable
// every entry and see the raw, unfiltered audit.

// Is this {% javascript %} body nothing but Pusha registrations? Scans at
// brace depth 0 so a `sectionInits[...] = function (root) { … }` counts as one
// statement no matter what is inside it. Deliberately strict: any other
// top-level statement means the body still does procedural work on parse, and
// the finding is real.
function portedSectionBody(body) {
  const src = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const statements = [];
  let depth = 0;
  let current = '';
  for (const ch of src) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (ch === ';' && depth === 0) {
      statements.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  statements.push(current);
  const meaningful = statements.map((t) => t.trim()).filter(Boolean);
  if (meaningful.length === 0) return false;
  return meaningful.every((t) => /^window\.theme\.section(Inits|Destroy)\s*\[/.test(t));
}

const WHITELISTS = {
  files: {
    description: "Skip Pusha's own bundled files — pusha.liquid is framework config (E false positive), pusha.min.js is the runtime (G/H false positives).",
    items: ['pusha.liquid', 'pusha.min.js', 'pusha.esm.js'],
  },
  H: {
    description: 'Suppress H findings for canonical Pusha patterns (sectionInits/sectionDestroy registrations, the window.theme bootstrap shim, runtime config). These ARE the recommended patterns; flagging them would mean every successfully-ported theme shows H findings forever.',
    patterns: [
      { rule: /^window\.theme\s*=\s*window\.theme\s*\|\|/, why: 'window.theme bootstrap shim' },
      { rule: /^window\.theme\.sectionInits\s*=/, why: 'sectionInits container init' },
      { rule: /^window\.theme\.sectionDestroy\s*=/, why: 'sectionDestroy container init' },
      { rule: /^window\.theme\.sectionInits\[/, why: 'individual sectionInits registration' },
      { rule: /^window\.theme\.sectionDestroy\[/, why: 'individual sectionDestroy registration' },
      { rule: /^window\.theme\.config\s*=/, why: 'Pusha runtime config' },
    ],
  },
  E: {
    description: 'Suppress E findings (inline <script>) in files that also call window.Pusha.on* hooks. The script has already been ported — it registers through the runtime instead of running procedurally on parse. Without this, the bridge snippets this skill tells you to write re-report as findings on the next pass, and an agent "fixes" the thing it just wrote.',
    fileTest: (text) => /window\.Pusha\.on(FirstLoad|AfterSwap|AfterInit|BeforeNav|BeforeLeave|NavError)/.test(text),
  },
  F: {
    description: 'Suppress F2 findings whose {% javascript %} body contains nothing but sectionInits / sectionDestroy registrations. That IS the ported shape. Without this a correctly ported section reports as work forever, and the audit can never say a port is finished.',
    bodyTest: (body) => portedSectionBody(body),
  },
  G: {
    description: 'Suppress G findings (DOMContentLoaded handlers) in files that also call window.Pusha.on* hooks. These are typically the "fallback" branch of an `if (window.Pusha) { ... } else { addEventListener("DOMContentLoaded", ...) }` pattern — dead code on Pusha-loaded themes, kept defensively.',
    fileTest: (text) => /window\.Pusha\.on(FirstLoad|AfterSwap|AfterInit|BeforeNav|BeforeLeave|NavError)/.test(text),
  },
};

function walkFiles(dir, exts, { skipPushaFiles = true } = {}) {
  if (!existsSync(dir)) return [];
  const skip = skipPushaFiles ? new Set(WHITELISTS.files.items) : new Set();
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
        if (skip.has(entry.name)) continue;
        out.push(p);
      }
    }
  };
  walk(dir);
  // Sort for deterministic output — readdirSync order is filesystem-dependent,
  // which would make audit output (and golden snapshots) flaky across machines.
  out.sort();
  return out;
}

function readFileText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// Blank out Liquid comment ({% comment %}…{% endcomment %}) and doc
// ({% doc %}…{% enddoc %}) spans so their *contents* aren't scanned as code.
// Non-newline chars inside the span become spaces; newlines are preserved so
// reported line numbers stay accurate. Covers single-line, multi-line, and the
// new-Liquid {% doc %} construct in one pass — the previous per-line depth
// counter missed single-line spans (open + close on one line) and had no notion
// of {% doc %} at all, so block/theme docs leaked into L/M findings.
function stripLiquidComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, blank)
    .replace(/\{%-?\s*doc\s*-?%\}[\s\S]*?\{%-?\s*enddoc\s*-?%\}/g, blank);
}

function findMatches(content, regex) {
  const out = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      out.push({ line: i + 1, match: lines[i].trim() });
    }
    // Reset state for global regex if any.
    regex.lastIndex = 0;
  }
  return out;
}

// Reachability check for H findings (the expensive bucket to triage).
function checkHReachability(themePath, file) {
  const rel = relative(themePath, file);
  if (rel.startsWith('sections/') && rel.endsWith('.liquid')) {
    const name = rel.replace(/^sections\//, '').replace(/\.liquid$/, '');
    let refs = 0;
    const search = (root, patterns) => {
      for (const f of walkFiles(root, ['.liquid', '.json'])) {
        const text = readFileText(f);
        for (const p of patterns) if (p.test(text)) { refs++; break; }
      }
    };
    search(join(themePath, 'templates'), [new RegExp(`"type":\\s*"${escapeRegExp(name)}"`)]);
    search(join(themePath, 'sections'), [new RegExp(`"type":\\s*"${escapeRegExp(name)}"`)]);
    // {% section 'name' %} or {% section "name" %}
    const sectionTag = new RegExp(`\\{%\\s*section\\s+['"]${escapeRegExp(name)}['"]\\s*%\\}`);
    for (const f of walkFiles(themePath, ['.liquid'])) {
      if (sectionTag.test(readFileText(f))) { refs++; break; }
    }
    return refs > 0 ? `reachable via ${refs} ref(s)` : 'no references found — possibly dead code';
  }
  if (rel.startsWith('assets/') && rel.endsWith('.js')) {
    const base = rel.replace(/^assets\//, '');
    for (const f of walkFiles(themePath, ['.liquid'])) {
      if (readFileText(f).includes(base)) return 'reachable';
    }
    return 'no references found — possibly dead code';
  }
  return '';
}

function classifyCustomElement(content) {
  if (!/customElements\.define/.test(content)) return null;
  const hasDisconnect = /disconnectedCallback/.test(content);
  const extendsHtml = /class\s+\w+\s+extends\s+HTMLElement/.test(content);
  const extendsAny = /class\s+\w+\s+extends\s+[A-Z][A-Za-z0-9]+/.test(content);
  const extendsCustomBase = extendsAny && !extendsHtml;
  const hasExternalRefs = /(window|document)\.addEventListener|new (Intersection|Mutation|Resize)Observer|setInterval/.test(content);

  if (hasDisconnect) return { bucket: 'C', shape: 'has disconnectedCallback' };
  if (extendsCustomBase) return { bucket: 'C', shape: 'extends custom base — verify base has disconnectedCallback' };
  if (extendsHtml && hasExternalRefs) return { bucket: 'D', shape: 'extends HTMLElement, no cleanup, external refs' };
  if (extendsHtml) return { bucket: 'C', shape: 'extends HTMLElement, no external refs' };

  // No inline `class … extends` in this file. Before falling through to
  // "unknown", check whether the element is registered from a binding produced
  // elsewhere — an imported class or a factory call (e.g. Shopify's
  // `createViewEventElement()` from @shopify/standard-events). These are common
  // on module-native / new-Liquid themes; the lifecycle lives in the imported
  // source we can't inspect, so classify as C (delegated) with a note rather
  // than flagging it as a broken/unknown shape.
  const delegated = resolveDelegatedDefine(content);
  if (delegated) return { bucket: 'C', shape: `element registered from ${delegated} — lifecycle delegated to source, verify externally` };

  return { bucket: '?', shape: 'customElements.define without recognized class shape' };
}

// For `customElements.define('tag', Binding)` where `Binding` is not an inline
// class expression, report where the class comes from: a factory call
// (`const X = makeThing()`) or an import (`import { X } from '…'`). Returns a
// short human-readable source label, or null if the binding can't be traced.
function resolveDelegatedDefine(content) {
  const defineRe = /customElements\.define\s*\(\s*['"][\w-]+['"]\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
  let m;
  while ((m = defineRe.exec(content)) !== null) {
    const binding = m[1];
    if (binding === 'class') continue; // inline class expression — handled above
    // Factory assignment: `const/let/var X = factoryFn(...)`, incl. `export const`.
    const fa = content.match(new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(binding)}\\s*=\\s*([\\w$.]+)\\s*\\(`));
    if (fa) return `factory ${fa[1]}()`;
    // Import binding: `import { X }`, `import X`, `import { Y as X }`.
    const im = content.match(new RegExp(`import\\s+[^;]*\\b${escapeRegExp(binding)}\\b[^;]*from\\s*['"]([^'"]+)['"]`));
    if (im) return `import '${im[1]}'`;
  }
  return null;
}

// Extract a class body by brace-matching from the opening { after `start`.
// Naive (doesn't account for braces in strings/comments) but good enough for
// typical Shopify theme JS, which doesn't use brace-heavy template literals
// inside class bodies.
function extractClassBody(content, start) {
  const open = content.indexOf('{', start);
  if (open < 0) return '';
  let depth = 1;
  let i = open + 1;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return content.slice(open, i);
}

// K bucket — custom elements that move themselves out of MainContent into <body>
// during connectedCallback. Survive PJAX swaps as orphaned <body> children.
// Render sites need `data-pusha-cleanup` so Pusha removes them on each leave.
//
// Detection has two phases:
//   1. Find every class definition + every customElements.define call across
//      assets/*.js. For each class, check if its body contains a direct portal
//      pattern: document.body.{appendChild|prepend|append|insertBefore|replaceChildren}
//      with `this` in the args.
//   2. Resolve `extends` chains. A class inherits the portal trait from any
//      ancestor with portalsDirectly. (Dawn's <product-modal> via ProductModal
//      extends ModalDialog is the canonical case.)
//   3. For each portal-tagged class with a known tag mapping, find render
//      sites in sections/*.liquid and snippets/*.liquid.
const PORTAL_PATTERN = /document\.body\.(?:appendChild|prepend|append|insertBefore|replaceChildren)\s*\([^)]*\bthis\b/;

function detectPortalClasses(themePath) {
  const classRe = /class\s+(\w+)(?:\s+extends\s+(\w+))?\s*{/g;
  // Match both `define('foo', ClassName)` and `define('foo', class ClassName extends X { ... })`.
  const defineRe = /customElements\.define\s*\(\s*['"]([\w-]+)['"]\s*,\s*(?:class\s+)?(\w+)/g;

  /** @type {Record<string, { parent: string|null, portalsDirectly: boolean, file: string }>} */
  const classes = {};
  /** @type {Record<string, string>} */ // tag → className
  const tagToClass = {};

  for (const file of walkFiles(join(themePath, 'assets'), ['.js'])) {
    const text = readFileText(file);
    const rel = relative(themePath, file);

    classRe.lastIndex = 0;
    let m;
    while ((m = classRe.exec(text)) !== null) {
      const name = m[1];
      const parent = m[2] ?? null;
      const body = extractClassBody(text, m.index);
      classes[name] = {
        parent,
        portalsDirectly: PORTAL_PATTERN.test(body),
        file: rel,
      };
    }

    defineRe.lastIndex = 0;
    while ((m = defineRe.exec(text)) !== null) {
      const tag = m[1];
      const cls = m[2];
      // Skip generic words that aren't class names.
      if (cls && cls !== 'class') tagToClass[tag] = cls;
    }
  }

  function resolvePortal(name, seen = new Set()) {
    if (!classes[name] || seen.has(name)) return null;
    seen.add(name);
    if (classes[name].portalsDirectly) return name;
    if (classes[name].parent) return resolvePortal(classes[name].parent, seen);
    return null;
  }

  const findings = [];
  for (const [tag, className] of Object.entries(tagToClass)) {
    const portalAncestor = resolvePortal(className);
    if (!portalAncestor) continue;

    const sites = [];
    const tagOpenRe = new RegExp(`<${escapeRegExp(tag)}\\b`);
    for (const liquid of [
      ...walkFiles(join(themePath, 'sections'), ['.liquid']),
      ...walkFiles(join(themePath, 'snippets'), ['.liquid']),
      ...walkFiles(join(themePath, 'blocks'), ['.liquid']),
      ...walkFiles(join(themePath, 'templates'), ['.liquid']),
    ]) {
      const text = readFileText(liquid);
      const lines = text.split('\n');
      // Walk the file looking for `<tag` openers. For each, scan forward
      // (across multiple lines if needed) until the closing `>` to find the
      // entire opening tag — multi-line opening tags are normal Liquid style
      // and the cleanup attribute may live on any line of the opener.
      let charOffset = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (tagOpenRe.test(line)) {
          // Find the absolute position of the opener and the matching `>`.
          const openerIdx = text.indexOf(`<${tag}`, charOffset);
          let endIdx = openerIdx;
          if (openerIdx !== -1) {
            // Naive but effective: find the first `>` after the opener that
            // isn't inside a quoted attribute. Liquid tags inside attributes
            // can contain `>` so be careful with quote tracking.
            let inQuote = null;
            endIdx = openerIdx + 1;
            while (endIdx < text.length) {
              const ch = text[endIdx];
              if (inQuote) {
                if (ch === inQuote) inQuote = null;
              } else {
                if (ch === '"' || ch === "'") inQuote = ch;
                else if (ch === '>') break;
              }
              endIdx++;
            }
          }
          const fullOpener = openerIdx !== -1 ? text.slice(openerIdx, endIdx + 1) : line;
          const alreadyMarked = /\bdata-pusha-cleanup\b/i.test(fullOpener);
          sites.push({
            file: relative(themePath, liquid),
            line: i + 1,
            snippet: line.trim().slice(0, 120),
            alreadyMarked,
          });
        }
        charOffset += line.length + 1; // +1 for the newline
      }
    }

    findings.push({
      tag,
      className,
      definedIn: classes[className].file,
      portalsDirectly: classes[className].portalsDirectly,
      via: portalAncestor === className ? null : portalAncestor,
      sites,
    });
  }

  return findings;
}

// ─── Bucket L: Liquid persistent state ──────────────────────────────────────
// Per-request Liquid in files that render OUTSIDE #MainContent. The persistent
// shell (layout + section groups + their snippets) freezes on first load, so
// request-scoped Liquid values go stale across PJAX navs. See PATTERNS.md
// "L. Liquid persistent state" for taxonomy and recommended fixes.

const L_PATTERNS = [
  // L-A: URL/template derived — auto-mitigation via client-side re-derive
  { sub: 'A', rank: 'auto', re: /\brequest\.(path|page_type|host|origin|locale|design_mode|visual_preview_mode)\b/, what: 'request.*' },
  { sub: 'A', rank: 'auto', re: /\btemplate\.(name|suffix|directory)\b/, what: 'template.* property' },
  { sub: 'A', rank: 'auto', re: /\{\{-?\s*template\s*[-|}]/, what: '{{ template }}' },
  { sub: 'A', rank: 'auto', re: /\btemplate\s*(?:==|!=|contains)\s*/, what: 'template comparison' },
  { sub: 'A', rank: 'auto', re: /\b\w*link\.(current|active|child_active|child_current)\b/, what: 'link.current/active/child_* (incl. nested loop vars like childlink/grandchildlink)' },
  { sub: 'A', rank: 'auto', re: /class\s*=\s*["'][^"']*template-\{\{/, what: 'class="template-{{ … }}"' },

  // L-B: customer-derived — query user (auth state)
  { sub: 'B', rank: 'ask', re: /\{%-?\s*if\s+customer\b/, what: '{% if customer %}' },
  { sub: 'B', rank: 'ask', re: /\bcustomer_logged_in\b/, what: 'customer_logged_in' },
  { sub: 'B', rank: 'ask', re: /\bcustomer\.\w+/, what: 'customer.* property' },

  // L-C: cart-derived — already covered by cart:mutated (verify wired)
  { sub: 'C', rank: 'ok', re: /\bcart\.(item_count|items|total_price|original_total_price|total_discount|items_subtotal_price|note|attributes|requires_shipping|taxes_included|duties_included|checkout_charge_amount)\b/, what: 'cart.*' },
  { sub: 'C', rank: 'ok', re: /\bcart\.empty\?/, what: 'cart.empty?' },

  // L-D: locale/currency — already excluded from PJAX (/localization route)
  { sub: 'D', rank: 'ok', re: /\blocalization\.\w+/, what: 'localization.*' },
  { sub: 'D', rank: 'ok', re: /\bcart\.currency\b/, what: 'cart.currency' },

  // L-E: per-page section objects appearing in persistent-shell sections
  { sub: 'E', rank: 'ask', re: /\bproduct\.\w+/, what: 'product.* in shell' },
  { sub: 'E', rank: 'ask', re: /\bcollection\.\w+/, what: 'collection.* in shell' },
  { sub: 'E', rank: 'ask', re: /\barticle\.\w+/, what: 'article.* in shell' },
  { sub: 'E', rank: 'ask', re: /\bblog\.\w+/, what: 'blog.* in shell' },

  // L-F: personalization
  { sub: 'F', rank: 'ask', re: /\brecommendations\./, what: 'recommendations.*' },
  { sub: 'F', rank: 'ask', re: /\bpredictive_search\./, what: 'predictive_search.*' },

  // L-G: time-of-render
  { sub: 'G', rank: 'ok', re: /['"](?:now|today)['"]\s*\|\s*date/, what: "'now'/'today' | date" },

  // L-H: app-injected blocks reading per-page state
  { sub: 'H', rank: 'ask', re: /\{%-?\s*content_for\s+['"]block['"]/, what: "content_for 'block'" },
];

// Lines that match a pattern but should not be flagged because Pusha already
// handles the staleness for that specific construct.
const L_WHITELIST = [
  { re: /<link[^>]+rel=["']canonical["']/i, why: 'Pusha syncs <link rel=canonical>' },
  { re: /<meta[^>]+property=["']og:url["']/i, why: 'Pusha syncs <meta property=og:url>' },
  { re: /<meta[^>]+property=["']og:[^"']+["']/i, why: 'Pusha syncs og:title/description' },
  { re: /<body[^>]+data-template=/i, why: 'Pusha syncs body[data-template]' },
  { re: /\bdata-page-type=/, why: 'inside swap container, re-renders on every nav' },
];

// Parse a theme JSON file. Shopify auto-generates a leading /* ... */ header on
// settings_data.json, templates/*.json and section groups; strip it only if the
// text does not already parse, so a /* */ sequence inside a setting value can
// never be mangled. Returns null on parse failure.
function parseThemeJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  try { return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').trim()); } catch { return null; }
}

// Resolve the set of files that render OUTSIDE #MainContent (the persistent
// shell). Includes layout/theme.liquid, every section type referenced in
// sections/*-group.json (section groups always render in the layout shell),
// and snippets transitively rendered from those — capped at depth 3.
function resolvePersistentShellFiles(themePath) {
  const layoutPath = join(themePath, 'layout/theme.liquid');
  const result = new Set();
  if (existsSync(layoutPath)) result.add(layoutPath);

  const sectionsDir = join(themePath, 'sections');
  if (existsSync(sectionsDir)) {
    for (const entry of readdirSync(sectionsDir)) {
      if (!entry.endsWith('.json')) continue;
      const text = readFileText(join(sectionsDir, entry));
      const parsed = parseThemeJson(text);
      if (!parsed || !parsed.sections) continue;
      for (const inst of Object.values(parsed.sections)) {
        const type = inst && inst.type;
        if (!type) continue;
        const sectionFile = join(sectionsDir, `${type}.liquid`);
        if (existsSync(sectionFile)) result.add(sectionFile);
      }
    }
  }

  const snippetsDir = join(themePath, 'snippets');
  // Match {% render 'foo' %} / {% include 'foo' %} form.
  const renderTagRe = /\{%-?\s*(?:render|include)\s+['"]([\w-]+)['"]/g;
  // Inside a `{%- liquid ... -%}` block, statements are bare (no `{% %}`
  // wrappers per line). We extract block bodies, then match `render 'foo'` at
  // line-start. Without this, snippets rendered from `{% liquid %}` blocks
  // (e.g. Dawn's sections/header.liquid → header-mega-menu) get skipped.
  const liquidBlockRe = /\{%-?\s*liquid\s*([\s\S]*?)-?%\}/g;
  const liquidRenderRe = /^\s*(?:render|include)\s+['"]([\w-]+)['"]/gm;
  let frontier = Array.from(result);
  for (let depth = 0; depth < 3; depth++) {
    const nextFrontier = [];
    for (const file of frontier) {
      const text = readFileText(file);
      const addSnippet = (name) => {
        const snippetFile = join(snippetsDir, `${name}.liquid`);
        if (!existsSync(snippetFile) || result.has(snippetFile)) return;
        result.add(snippetFile);
        nextFrontier.push(snippetFile);
      };
      renderTagRe.lastIndex = 0;
      let m;
      while ((m = renderTagRe.exec(text)) !== null) addSnippet(m[1]);
      liquidBlockRe.lastIndex = 0;
      let lb;
      while ((lb = liquidBlockRe.exec(text)) !== null) {
        const body = lb[1];
        liquidRenderRe.lastIndex = 0;
        let lr;
        while ((lr = liquidRenderRe.exec(body)) !== null) addSnippet(lr[1]);
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }

  return Array.from(result);
}

// Scan one persistent-shell file for L-bucket findings. Lines inside a
// `<main ...>...</main>` block (the swap container, present in
// layout/theme.liquid) are skipped — they re-render on every nav.
function detectLiquidPersistentState(file, themePath) {
  const text = stripLiquidComments(readFileText(file));
  const lines = text.split('\n');
  const findings = [];
  const seen = new Set();
  // Multi-line `{% comment %}` suppression: track depth, skip while inside.
  let commentDepth = 0;
  // Swap-container suppression: skip lines from `<main` (inclusive of its
  // opener, since attributes on the opening tag are also swap-replaced) to
  // `</main>` (inclusive of the closer).
  let inMainContainer = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    if (/<main\b/i.test(ln)) inMainContainer = true;
    const wasInMain = inMainContainer;
    if (/<\/main\s*>/i.test(ln)) inMainContainer = false;

    const opens = (ln.match(/\{%-?\s*comment\s*-?%\}/g) || []).length;
    const closes = (ln.match(/\{%-?\s*endcomment\s*-?%\}/g) || []).length;
    if (commentDepth > 0) {
      commentDepth += opens - closes;
      if (commentDepth < 0) commentDepth = 0;
      continue;
    }
    commentDepth += opens - closes;

    if (wasInMain) continue;

    const wl = L_WHITELIST.find((w) => w.re.test(ln));
    if (wl) continue;

    for (const p of L_PATTERNS) {
      if (!p.re.test(ln)) continue;
      const key = `${i}:${p.sub}:${p.what}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        file: relative(themePath, file),
        line: i + 1,
        match: ln.trim().slice(0, 160),
        sub: p.sub,
        rank: p.rank,
        what: p.what,
      });
    }
  }
  return findings;
}

// ─── Bucket M: persistent-shell stateful UI ─────────────────────────────────
// Modals, drawers, overlays, and dropdowns that live OUTSIDE #MainContent and
// were authored assuming a full reload would dismiss them. PJAX swaps don't
// reload the shell, so the open state persists. See PATTERNS.md "M. Persistent-
// shell stateful UI" for the three remediation options.

const M_PATTERNS = [
  // <details> with click-toggle inside the shell. Dawn's predictive search +
  // mobile drawer use this pattern.
  { kind: 'details', re: /<details\b[^>]*>/i, what: '<details> in persistent shell' },
  // <dialog> elements — rare in Shopify themes today, but the pattern is the same.
  { kind: 'dialog', re: /<dialog\b[^>]*>/i, what: '<dialog> in persistent shell' },
  // Custom elements whose tag name suggests stateful overlay UI.
  { kind: 'custom-modal', re: /<(\w+-(?:modal|drawer|overlay|popup|search-form|menu-drawer))\b/i, what: 'stateful-named custom element in shell' },
];

// JS code that mutates <body> classes to lock scroll or mark an open state.
// When triggered from persistent-shell JS, the class survives PJAX swap and
// can trap users on subsequent pages with disabled scroll.
const M_BODY_CLASS_PATTERNS = [
  { re: /document\.body\.classList\.(?:add|toggle)\s*\(\s*['"]([^'"]+)['"]/g, what: 'body.classList.add/toggle' },
  { re: /document\.body\.classList\.add\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g, what: 'body.classList.add (multi)' },
];

function detectShellModals(themePath, shellFiles) {
  const findings = [];
  const shellSet = new Set(shellFiles);

  for (const file of shellFiles) {
    const text = stripLiquidComments(readFileText(file));
    const lines = text.split('\n');
    let inMainContainer = false;
    let inComment = 0;

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/<main\b/i.test(ln)) inMainContainer = true;
      const wasInMain = inMainContainer;
      if (/<\/main\s*>/i.test(ln)) inMainContainer = false;

      const opens = (ln.match(/\{%-?\s*comment\s*-?%\}/g) || []).length;
      const closes = (ln.match(/\{%-?\s*endcomment\s*-?%\}/g) || []).length;
      if (inComment > 0) {
        inComment += opens - closes;
        if (inComment < 0) inComment = 0;
        continue;
      }
      inComment += opens - closes;

      if (wasInMain) continue;

      for (const p of M_PATTERNS) {
        const m = ln.match(p.re);
        if (!m) continue;
        // Skip elements already wired to close on nav.
        if (/data-pusha-close-on-nav/i.test(ln)) continue;
        findings.push({
          file: relative(themePath, file),
          line: i + 1,
          kind: p.kind,
          match: ln.trim().slice(0, 140),
          what: p.what,
        });
      }
    }
  }

  // Scan persistent-shell asset JS for body-class lockouts. We can't perfectly
  // attribute a JS file to "the shell" — themes load most JS globally — so we
  // walk every assets/*.js and report. The porter decides reachability.
  const assetsDir = join(themePath, 'assets');
  if (existsSync(assetsDir)) {
    for (const file of walkFiles(assetsDir, ['.js'])) {
      const text = readFileText(file);
      const seenClasses = new Set();
      for (const p of M_BODY_CLASS_PATTERNS) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(text)) !== null) {
          const captured = [m[1], m[2]].filter(Boolean);
          for (const cls of captured) {
            // Don't bother flagging the canonical "no-js" + "js" toggles that
            // every theme uses and that don't represent an open-state lockout.
            if (cls === 'js' || cls === 'no-js' || cls === 'loaded') continue;
            if (seenClasses.has(cls)) continue;
            seenClasses.add(cls);
            // Find the line number for the first occurrence.
            const upto = text.slice(0, m.index);
            const line = upto.split('\n').length;
            findings.push({
              file: relative(themePath, file),
              line,
              kind: 'body-class',
              cls,
              match: `document.body.classList.add('${cls}')`,
              what: `body class "${cls}" added — survives a swap, may lock scroll`,
            });
          }
        }
      }
    }
  }

  return findings;
}

function auditTheme(themePath, { useWhitelists = true } = {}) {
  // Always walk every file. Whitelists are applied as a partition AFTER
  // classification so we can report what would have been flagged in the new
  // "Suppressed by whitelists" section instead of silently dropping it.
  const walkOpts = { skipPushaFiles: false };
  const dirs = {
    sections: join(themePath, 'sections'),
    snippets: join(themePath, 'snippets'),
    assets: join(themePath, 'assets'),
    layout: join(themePath, 'layout'),
    // Block-based theme dirs. `blocks/` holds OS 2.0 theme blocks — a platform
    // capability any theme can use, not one theme's convention — and is also
    // used by the new-Liquid preview; `templates/*.liquid` carry per-page script
    // tags in every paradigm. Walking them is a coverage fix — the section-only
    // scan silently missed block scripts and inline scripts in .liquid templates.
    blocks: join(themePath, 'blocks'),
    templates: join(themePath, 'templates'),
  };
  // Warn only for the conventionally-expected dirs. `blocks/` is absent on
  // classic Dawn-shaped themes and `sections/` is absent on new-Liquid themes,
  // so a missing one of those two isn't worth a warning.
  // stderr, not stdout: `pusha audit --json` writes its payload to stdout, and a
  // warning line there makes the output unparseable for the skill/agent
  // consumers --json exists for.
  for (const name of ['snippets', 'assets', 'layout', 'templates']) {
    if (!existsSync(dirs[name])) console.error(`! ${name}/ not found at ${dirs[name]} — skipping`);
  }

  const findings = { A: [], B: [], C: [], D: [], E: [], F: [], G: [], H: [], J: [], K: [], L: [], M: [], P: [], X: [], unknown: [] };
  // Each entry: { bucket, file, line?, match?, reason? } — the would-have-been
  // finding plus why it was suppressed. `files` keyed by Pusha-self filenames;
  // `G` keyed by the file-level Pusha.on* trigger; `H` keyed by line patterns.
  const suppressed = { files: [], E: [], F: [], G: [], H: [] };

  // A — external script src in liquid files (excluding JSON type)
  // B — JSON / ld+json data scripts
  const liquidDirs = ['sections', 'snippets', 'layout', 'blocks', 'templates'].map((d) => dirs[d]);
  for (const dir of liquidDirs) {
    for (const file of walkFiles(dir, ['.liquid'], walkOpts)) {
      const text = stripLiquidComments(readFileText(file));
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (/<script[^>]+src=/i.test(ln) && !/type=["']application\//i.test(ln)) {
          findings.A.push({ file: relative(themePath, file), line: i + 1, match: ln.trim() });
        }
        if (/<script[^>]+type=["']application\/(ld\+)?json/i.test(ln)) {
          findings.B.push({ file: relative(themePath, file), line: i + 1, match: ln.trim() });
        }
      }
    }
  }

  // C / D — custom elements in assets/*.js
  for (const file of walkFiles(dirs.assets, ['.js'], walkOpts)) {
    const text = readFileText(file);
    const result = classifyCustomElement(text);
    if (!result) continue;
    const entry = { file: relative(themePath, file), shape: result.shape };
    if (result.bucket === 'C') findings.C.push(entry);
    else if (result.bucket === 'D') findings.D.push(entry);
    else findings.unknown.push(entry);
  }

  // E — procedural inline <script> in liquid (not src=, not JSON type)
  for (const dir of [dirs.sections, dirs.snippets, dirs.blocks, dirs.templates]) {
    for (const file of walkFiles(dir, ['.liquid'], walkOpts)) {
      const text = stripLiquidComments(readFileText(file));
      const lines = text.split('\n');
      // Same rationale as the G whitelist: a file that registers through the
      // runtime has already been ported, however its <script> tag reads.
      const pushaAware = useWhitelists && WHITELISTS.E.fileTest(text);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (/<script[^>]*>/i.test(ln) && !/src=/i.test(ln) && !/application\/(ld\+)?json/i.test(ln)) {
          const entry = { file: relative(themePath, file), line: i + 1, match: ln.trim() };
          if (pushaAware) suppressed.E.push({ bucket: 'E', ...entry, reason: 'file also calls window.Pusha.on*' });
          else findings.E.push(entry);
        }
      }
    }
  }

  // F — {% javascript %} blocks (F1: contains a custom element class, F2: procedural)
  for (const dir of [dirs.sections, dirs.snippets, dirs.blocks, dirs.templates]) {
    for (const file of walkFiles(dir, ['.liquid'], walkOpts)) {
      const text = stripLiquidComments(readFileText(file));
      if (!/\{%\s*javascript\s*%\}/.test(text)) continue;
      const hasClass = /class\s+\w+\s+extends\s+HTMLElement/.test(text);
      const kind = hasClass ? 'F1' : 'F2';
      const rel = relative(themePath, file);
      const body = (text.match(/\{%\s*javascript\s*%\}([\s\S]*?)\{%\s*endjavascript\s*%\}/) || [, ''])[1];
      if (kind === 'F2' && useWhitelists && WHITELISTS.F.bodyTest(body)) {
        suppressed.F.push({ bucket: 'F', file: rel, kind, match: '{% javascript %}', reason: 'body is only sectionInits/sectionDestroy registrations — already ported' });
        continue;
      }
      findings.F.push({ file: rel, kind });
    }
  }

  // G — DOMContentLoaded handlers in sections/snippets/assets/blocks/templates
  for (const dir of [dirs.sections, dirs.snippets, dirs.assets, dirs.blocks, dirs.templates]) {
    for (const file of walkFiles(dir, ['.liquid', '.js'], walkOpts)) {
      const text = stripLiquidComments(readFileText(file));
      // G whitelist: if the file also calls Pusha hooks, the DOMContentLoaded
      // handler is treated as the fallback branch of `if (window.Pusha) {...}
      // else { addEventListener('DOMContentLoaded', ...) }`. Capture the
      // finding into `suppressed.G` instead of dropping it silently.
      const gFileSuppressed = useWhitelists && WHITELISTS.G.fileTest(text);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Native: addEventListener('DOMContentLoaded', ...)
        // jQuery: $(document).ready(...) — common in pre-OS2 themes and some
        // Dawn-derived forks that still vendor jQuery.
        const isNativeReady = /addEventListener\(['"]DOMContentLoaded['"]/.test(lines[i]);
        const isJqueryReady = /\$\(\s*document\s*\)\s*\.\s*ready\s*\(/.test(lines[i]);
        if (isNativeReady || isJqueryReady) {
          const entry = {
            file: relative(themePath, file),
            line: i + 1,
            match: lines[i].trim(),
            kind: isJqueryReady ? 'jquery-ready' : 'dom-content-loaded',
          };
          if (gFileSuppressed) {
            suppressed.G.push({ bucket: 'G', ...entry, reason: 'file also calls window.Pusha.on*' });
          } else {
            findings.G.push(entry);
          }
        }
      }
    }
  }

  // H — module-level state heuristics
  for (const dir of [dirs.sections, dirs.snippets, dirs.assets, dirs.blocks, dirs.templates]) {
    for (const file of walkFiles(dir, ['.liquid', '.js'], walkOpts)) {
      const text = stripLiquidComments(readFileText(file));
      const hasCustomElement = /customElements\.define/.test(text);
      // H whitelist: drop lines that match canonical Pusha patterns
      // (sectionInits / sectionDestroy / config / bootstrap shim) before
      // counting top-level window mutations. Lines that match are captured
      // into `suppressed.H` so an agent can see what's been filtered without
      // re-running with --no-whitelist.
      const filtered = [];
      for (const ln of text.split('\n')) {
        if (!/^(window|document)\.[A-Za-z_]+\s*=/.test(ln)) continue;
        const trimmed = ln.trim();
        if (useWhitelists) {
          const match = WHITELISTS.H.patterns.find((p) => p.rule.test(ln));
          if (match) {
            suppressed.H.push({
              bucket: 'H',
              file: relative(themePath, file),
              match: trimmed,
              reason: match.why,
            });
            continue;
          }
        }
        filtered.push(ln);
      }
      const hasTopLevelWindowMutation = filtered.length > 0;
      // Require closing invocation `})()` to call it an IIFE — excludes
      // arrow-callback patterns like `requestAnimationFrame(() => { ... })`.
      const hasIife = /\}\s*\)\s*\(\s*\)\s*;?\s*$/m.test(text);

      if (hasCustomElement) {
        // Custom-element files only become H if there's *also* top-level window/document mutation.
        if (hasTopLevelWindowMutation) {
          findings.H.push({
            file: relative(themePath, file),
            reason: 'top-level window/document mutation',
            reachability: checkHReachability(themePath, file),
          });
        }
        continue;
      }
      if (hasIife) {
        findings.H.push({
          file: relative(themePath, file),
          reason: 'IIFE with no class — likely procedural state',
          reachability: checkHReachability(themePath, file),
        });
      } else if (hasTopLevelWindowMutation) {
        findings.H.push({
          file: relative(themePath, file),
          reason: 'top-level window/document mutation',
          reachability: checkHReachability(themePath, file),
        });
      }
    }
  }

  // K — portal-to-body custom elements
  findings.K = detectPortalClasses(themePath);

  // L — Liquid persistent state in the layout shell (everything outside
  // #MainContent). Per-request Liquid here freezes on first load.
  const shellFiles = resolvePersistentShellFiles(themePath);
  for (const file of shellFiles) {
    findings.L.push(...detectLiquidPersistentState(file, themePath));
  }

  // M — persistent-shell stateful UI (modals, drawers, overlays without
  // close-on-nav handling). Reuses the shell-file resolution.
  findings.M = detectShellModals(themePath, shellFiles);

  // P — partials inventory (informational). Also used to annotate L findings
  // that may self-heal via a partial refresh.
  const partialResult = detectPartials(themePath);
  findings.P = partialResult.partials;

  // Per-file remediation routing: tag each procedural finding (E/F/G/H) with its
  // location class so the report prescribes a paradigm-correct fix instead of a
  // blanket "wrap in sectionInits".
  const shellRelSet = new Set(shellFiles.map((f) => relative(themePath, f)));
  for (const f of findings.E) {
    let loc = locationClass(f.file, shellRelSet);
    if (loc === 'shell' && inlineScriptIsConfigOnly(join(themePath, f.file), f.line)) loc = 'head-config';
    f.location = loc;
  }
  for (const f of findings.F) f.location = locationClass(f.file, shellRelSet);
  for (const f of findings.G) f.location = locationClass(f.file, shellRelSet);
  for (const f of findings.H) f.location = locationClass(f.file, shellRelSet);

  // J — analytics surface. Needs shellRelSet: a marker in the persistent shell
  // is re-read on every nav, which is a different (worse) failure than a missing
  // one, so placement is part of the classification.
  const analyticsResult = detectAnalyticsSurface(themePath, shellRelSet);
  findings.J = analyticsResult.findings;
  const analyticsMarkers = analyticsResult.markers;

  // X — theme app extensions. Needs shellRelSet: the @app capability map
  // routes a section's location off group membership, same as J's markers.
  const appResult = detectAppSurfaces(themePath, shellRelSet);
  findings.X = appResult.findings;
  const appSurfaces = {
    capabilities: appResult.capabilities,
    wrapper: appResult.wrapper,
    disabledEmbeds: appResult.disabledEmbeds,
    scriptTagBlindSpot: SCRIPT_TAG_BLIND_SPOT,
  };

  // Annotate — do not downgrade — L findings whose file has partial activity.
  // Scoped to non-'auto' findings: 'auto' state is URL-derivable and re-derived
  // client-side, unrelated to partials; the dynamic state a partial refresh
  // actually heals is the cart/customer/per-page (ask/ok) kind.
  for (const f of findings.L) {
    if (f.rank !== 'auto' && partialResult.activeFiles.has(f.file)) f.partialCovered = true;
  }

  // files whitelist — partition Pusha-self findings out of every bucket into
  // suppressed.files. Runs last so all classification work is already done.
  if (useWhitelists) {
    const pushaSelfFiles = new Set(WHITELISTS.files.items);
    const isPushaSelf = (filePath) => pushaSelfFiles.has(filePath.split('/').pop());
    for (const bucket of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'L', 'M']) {
      const live = [];
      for (const finding of findings[bucket]) {
        if (isPushaSelf(finding.file)) {
          suppressed.files.push({ bucket, ...finding, reason: 'Pusha-self file (framework/runtime)' });
        } else {
          live.push(finding);
        }
      }
      findings[bucket] = live;
    }
    // Same for H/G entries that were already routed to suppressed — drop the
    // Pusha-self ones (they're covered by the files whitelist, no need to
    // double-list them).
    suppressed.G = suppressed.G.filter((s) => !isPushaSelf(s.file));
    suppressed.H = suppressed.H.filter((s) => !isPushaSelf(s.file));
  }

  const summary = {
    A: findings.A.length,
    B: findings.B.length,
    C: findings.C.length,
    D: findings.D.length,
    E: findings.E.length,
    F1: findings.F.filter((x) => x.kind === 'F1').length,
    F2: findings.F.filter((x) => x.kind === 'F2').length,
    G: findings.G.length,
    H: findings.H.length,
    K: findings.K.length,
    K_sites: findings.K.reduce((n, k) => n + k.sites.filter((s) => !s.alreadyMarked).length, 0),
    L: findings.L.length,
    L_auto: findings.L.filter((x) => x.rank === 'auto').length,
    L_ask: findings.L.filter((x) => x.rank === 'ask').length,
    L_ok: findings.L.filter((x) => x.rank === 'ok').length,
    M: findings.M.length,
    M_modals: findings.M.filter((x) => x.kind !== 'body-class').length,
    M_body_classes: findings.M.filter((x) => x.kind === 'body-class').length,
    P: findings.P.length,
    P_gaps: findings.P.filter((x) => x.dangling === 'undeclared').length,
    J: findings.J.length,
    J_gaps: findings.J.filter((x) => x.rank === 'gap').length,
    J_warns: findings.J.filter((x) => x.rank === 'warn').length,
    X: findings.X.length,
    X_at_risk: findings.X.filter((x) => x.verdict === 'at-risk').length,
    X_survives: findings.X.filter((x) => x.verdict === 'survives').length,
    X_embeds: findings.X.filter((x) => x.kind === 'app-embed').length,
    X_capabilities: appResult.capabilities.length,
    unknown: findings.unknown.length,
  };

  return { findings, summary, suppressed, analyticsMarkers, appSurfaces, whitelistsActive: useWhitelists };
}

// ─── Location routing ───────────────────────────────────────────────────────
// A procedural-JS finding's correct fix depends on WHERE it lives, not one
// blanket "wrap in sectionInits". locationClass derives that from the path plus
// the persistent-shell set (files rendered outside #MainContent).

const LOCATION_ORDER = ['section', 'block', 'template', 'shell', 'head-config', 'include', 'asset', 'embed', 'script'];

function locationClass(relPath, shellRelSet) {
  if (relPath.startsWith('layout/')) return 'shell';
  if (shellRelSet.has(relPath)) return 'shell'; // snippet/section rendered in the shell
  if (relPath.startsWith('sections/')) return 'section';
  if (relPath.startsWith('blocks/')) return 'block';
  if (relPath.startsWith('templates/')) return 'template';
  if (relPath.startsWith('snippets/')) return 'include';
  if (relPath.startsWith('assets/')) return 'asset';
  return 'shell';
}

// Heuristic: an inline <script> whose body has no call-parens is inert config
// (e.g. `const Theme = { routes: {...} }`) — it runs once in the persistent
// shell and is unaffected by PJAX, so it needs no transform. Conservative:
// anything with a `(` is treated as behavioral, not config.
function inlineScriptIsConfigOnly(absFile, lineNum) {
  const lines = stripLiquidComments(readFileText(absFile)).split('\n');
  let body = '';
  let started = false;
  for (let i = lineNum - 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!started) {
      const open = ln.match(/<script[^>]*>/i);
      if (!open) { if (i === lineNum - 1) continue; break; }
      const after = ln.slice(ln.indexOf(open[0]) + open[0].length);
      // search() not indexOf() — the close tag may be cased differently
      // from the literal, same as the open tag above.
      const closeInTail = after.search(/<\/script>/i);
      if (closeInTail !== -1) { body += after.slice(0, closeInTail); break; }
      body += after; started = true; continue;
    }
    const closeOnLine = ln.search(/<\/script>/i);
    if (closeOnLine !== -1) { body += '\n' + ln.slice(0, closeOnLine); break; }
    body += '\n' + ln;
  }
  return !/\(/.test(body);
}

// Paradigm-correct remediation per (bucket, location). F2 shares E's advice
// (both are procedural bodies). Buckets not keyed here fall back to BUCKET_RULES.
const REMEDIATION = {
  E: {
    section: "sectionInits['<handle>'] = (root) => {…}; scope queries to root.",
    block: 'Promote to a custom element (connected/disconnectedCallback) — blocks have no per-block init registry.',
    template: 'Move to a custom element, or an onAfterInit((c,meta)=>…) hook keyed on meta.template.',
    shell: 'Global/shell scope — run once via onFirstLoad / setupGlobal. NOT sectionInits (it never re-fires here).',
    'head-config': 'Leave as-is — inert config (no calls), runs once in the persistent shell, safe across swaps.',
    include: 'Included snippet — verify render context; wrap as a custom element (or sectionInits if always inside a section).',
    asset: 'Global asset script — move init into onFirstLoad or a custom element.',
  },
  G: {
    section: "Move the handler body into sectionInits['<handle>'](root). DOMContentLoaded does not re-fire after a swap.",
    block: "Move into the custom element's connectedCallback.",
    template: 'Move into a custom element or an onAfterInit hook.',
    shell: 'Replace with onFirstLoad (runs once). DOMContentLoaded also never re-fires after a swap.',
    include: 'Verify render context; move into a custom element or the appropriate lifecycle hook.',
    asset: 'Global asset — replace DOMContentLoaded with onFirstLoad, or move into a custom element.',
  },
  H: {
    section: 'Module-level state in a section — check reachability; move state into the sectionInits closure or a custom element.',
    block: 'Module-level state — move into the custom element instance.',
    template: 'Module-level state — move into a custom element (page-scoped).',
    shell: 'Shell module state persists across navs — usually intended, but verify it should not reset per page.',
    include: 'Verify render context; module-level closures do not replay on swap.',
    asset: 'Module-level state in a shared asset — closures do not replay on swap; refactor to instance/registry state.',
  },
};
REMEDIATION.F = REMEDIATION.E; // F2 is a procedural {% javascript %} body — same routing as E.

REMEDIATION.X = {
  section: 'App block inside the swap container — its init JS ran on the old document and does not re-run. MEASURED 2026-09-11 against a purpose-built extension across 4 soft navigations (pusha-probe, run 0): exactly two shapes recover, and both do it with NO configuration and NO double-init. (1) An app block authored as a CUSTOM ELEMENT re-mounts for free via connectedCallback. (2) An app block that LISTENS FOR shopify:page:view — the Standard Storefront Events vocabulary at api/storefront-events-and-actions, which Pusha re-dispatches on every swap — rebinds the fresh node every time. Everything else went inert, and the loading shape made no difference: schema-attribute JS in <head>, an inline <script> in block markup, an in-markup <script src>, and a type=module script all failed identically. So re-executing the scripts in the swapped markup is NOT a general remedy — for the canonical case the JS is not in the markup at all, it is a <script async> the platform injects into <head>. If you own the app, the fix is to listen for shopify:page:view or author the block as a custom element; both are documented and supported. If you do NOT own the app, you cannot wrap code you did not write: opt the surrounding nav out with data-no-transition, or treat the page as ineligible for instant navigation. Two experimental theme-side fallbacks exist for non-cooperating apps and both ship OFF — window.theme.config.appCompat.sectionEvents dispatches shopify:section:un/load (an undocumented use of theme-editor events), and appCompat.reexecuteExtensionScripts re-runs cdn.shopify.com/extensions/ bundles at the risk of double-binding. Measure before enabling either. NOTE: the theme editor cannot answer any of this — it performs a full page reload on every theme app extension change, so every app reads as recoverable there. Verify on the storefront across a real swap. What is NOT yet measured is how many installed third-party apps have adopted shopify:page:view; the mechanism is proven, the adoption rate is not.',
  shell: 'App block in a section group — renders outside the swap container and is never removed, so its init runs once and keeps running. This is the recommended app placement. Verify only that it holds no references into the swapped region.',
  embed: 'App embed — injected before </head> / </body>, outside the swap container, so it survives. But an embed holding references INTO the swapped region goes stale silently, and no signal exists to repair it. Verify by hand on a swapped page.',
  script: 'Script Tag API — runtime-injected, not in theme files, invisible to a static audit. It initializes once and is silent after page one. Verify in a live session (or with Shopify API context, if present); a static report can only name this as a blind spot.',
};

// ─── Bucket P: partials ─────────────────────────────────────────────────────
// {% partial 'name' %} + @shopify/partial-rendering — new-Liquid's named,
// server-rendered, client-refreshed regions (the islands substrate). The audit
// inventories declarations + consumers and flags the string-naming contract.

function detectPartials(themePath) {
  const declRe = /\{%-?\s*partial\s+['"]([\w-]+)['"]/g;
  const dataPartialsRe = /data-partials=["']([^"']+)["']/g;
  const partialAttrRe = /(?<!data-)\bpartial=["']([\w-]+)["']/g;
  const declared = new Map(); // name -> [{file,line}]
  const consumed = new Map();
  const activeFiles = new Set();
  const push = (map, name, site) => { (map.get(name) ?? map.set(name, []).get(name)).push(site); };

  for (const dir of ['templates', 'layout', 'blocks', 'snippets', 'sections']) {
    for (const file of walkFiles(join(themePath, dir), ['.liquid'])) {
      const rel = relative(themePath, file);
      const lines = stripLiquidComments(readFileText(file)).split('\n');
      lines.forEach((ln, i) => {
        let m;
        declRe.lastIndex = 0;
        while ((m = declRe.exec(ln))) { push(declared, m[1], { file: rel, line: i + 1 }); activeFiles.add(rel); }
        dataPartialsRe.lastIndex = 0;
        while ((m = dataPartialsRe.exec(ln))) {
          for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
            push(consumed, name, { file: rel, line: i + 1 }); activeFiles.add(rel);
          }
        }
        partialAttrRe.lastIndex = 0;
        while ((m = partialAttrRe.exec(ln))) { push(consumed, m[1], { file: rel, line: i + 1 }); activeFiles.add(rel); }
      });
    }
  }

  const names = [...new Set([...declared.keys(), ...consumed.keys()])].sort();
  const partials = names.map((name) => {
    const declaredAt = declared.get(name) ?? [];
    const consumers = consumed.get(name) ?? [];
    // 'undeclared' is a real gap (an attribute references a partial no
    // {% partial %} declares). 'no-attr-consumer' is only informational — v1
    // detects attribute consumers, not JS `partials.fetch('name')` calls, so a
    // declared partial with no attribute consumer is likely fetched in JS.
    const dangling = declaredAt.length === 0 ? 'undeclared'
      : consumers.length === 0 ? 'no-attr-consumer' : null;
    return { name, declaredAt, consumers, dangling };
  });
  return { partials, activeFiles, present: partials.length > 0 };
}

// ─── Bucket J: analytics surface ────────────────────────────────────────────
// The runtime reads page-type payloads from theme-serialized
// <script data-pusha-analytics-event> blocks and passes them to
// Shopify.analytics.publish. ⚠ Publishing under a STANDARD name is rejected by
// the platform. The prefixed custom-event copies the customEvents bridge emits
// do reach the pixel sandbox, but no third-party app pixel maps a prefixed
// name — a companion custom pixel has to forward it:
// https://shopify.dev/docs/api/web-pixels-api/emitting-data
//
// This bucket still earns its place: the payloads are hand-written Liquid that
// nothing validates at runtime, and keeping their shape correct is what makes a
// supported publish path (or a custom-pixel bridge) cheap to adopt later. But
// its findings must never be phrased as "this makes your pixels work."
// Coverage (is the event there at all), conformance (is it well-formed),
// placement (is it inside the swap container), plus raw pixels — which under
// Pusha are the ones most likely to still work, since a theme can re-fire them.

const MARKER_RE = /<script([^>]*\bdata-pusha-analytics-event\b[^>]*)>([\s\S]*?)<\/script>/gi;

// Page-type events Shopify auto-fires on a native load and nothing re-fires on a
// swap. `probes` are path prefixes: coverage is asserted only when the theme
// actually has that page, so a partial theme isn't told it's missing a cart event.
const PAGE_TYPE_EVENTS = [
  { event: 'product_viewed', requires: 'productVariant', probes: ['templates/product', 'sections/main-product'] },
  { event: 'collection_viewed', requires: 'collection', probes: ['templates/collection', 'sections/main-collection'] },
  { event: 'search_submitted', requires: 'searchResult', probes: ['templates/search', 'sections/main-search'] },
  { event: 'cart_viewed', requires: 'cart', probes: ['templates/cart', 'sections/main-cart'] },
];

const RAW_PIXEL_PATTERNS = [
  { re: /\bgtag\s*\(/, what: 'direct gtag.js call' },
  { re: /\bfbq\s*\(/, what: 'Meta pixel fbq()' },
  { re: /\bdataLayer\s*\.\s*push\s*\(/, what: 'GTM dataLayer.push()' },
  { re: /\bttq\s*\.\s*(?:track|page)\s*\(/, what: 'TikTok pixel ttq' },
];

// A real payload is not valid JSON — `"amount": {{ price | divided_by: 100.0 }}`
// is a bare Liquid tag in value position. Strip {% %} and swap {{ }} for `1`,
// which parses both bare (number) and quoted (string). Shape survives; values
// are irrelevant because J validates structure, not content.
function liquidJsonProbe(body) {
  return body.replace(/\{%[\s\S]*?%\}/g, '').replace(/\{\{[\s\S]*?\}\}/g, '1');
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function detectAnalyticsSurface(themePath, shellRelSet) {
  const findings = [];
  const markers = [];
  const seenEvents = new Set();

  // Page presence spans .json templates too (classic OS 2.0), so the coverage
  // probe can't reuse the .liquid-only marker walk.
  const pageFiles = new Set();
  for (const dir of ['templates', 'sections']) {
    for (const file of walkFiles(join(themePath, dir), ['.liquid', '.json'])) {
      pageFiles.add(relative(themePath, file));
    }
  }

  for (const dir of ['templates', 'layout', 'blocks', 'snippets', 'sections']) {
    for (const file of walkFiles(join(themePath, dir), ['.liquid'])) {
      const rel = relative(themePath, file);
      const text = stripLiquidComments(readFileText(file));
      const location = locationClass(rel, shellRelSet);

      MARKER_RE.lastIndex = 0;
      let m;
      while ((m = MARKER_RE.exec(text))) {
        const [, attrs, body] = m;
        const site = { file: rel, line: lineAt(text, m.index), location };

        // The runtime finds the script by attribute regardless of type, but the
        // BROWSER parses a type-less <script> as JavaScript and throws on the
        // JSON body. Page-breaking, not merely a data bug.
        if (!/type\s*=\s*["']application\/json["']/i.test(attrs)) {
          findings.push({ kind: 'conformance', rank: 'gap', ...site,
            what: 'missing type="application/json" — the browser executes the body as JavaScript' });
        }

        let parsed = null;
        try {
          parsed = JSON.parse(liquidJsonProbe(body));
        } catch {
          findings.push({ kind: 'conformance', rank: 'gap', ...site,
            what: 'payload is not parseable JSON — the runtime warns and skips the event' });
        }

        // Read the name from the RAW body so a Liquid-computed name is visible
        // as such instead of collapsing into the probe token.
        const rawName = body.match(/"name"\s*:\s*"([^"]*)"/)?.[1];
        if (rawName != null && /\{\{|\{%/.test(rawName)) {
          findings.push({ kind: 'conformance', rank: 'warn', ...site,
            what: 'event name is Liquid-computed — cannot verify statically' });
          continue;
        }
        if (!rawName) {
          if (parsed) {
            findings.push({ kind: 'conformance', rank: 'gap', ...site,
              what: 'payload has no "name" — the runtime skips events without one' });
          }
          continue;
        }

        seenEvents.add(rawName);
        markers.push({ ...site, event: rawName });
        const spec = PAGE_TYPE_EVENTS.find((p) => p.event === rawName);
        if (rawName === 'page_viewed') {
          findings.push({ kind: 'conformance', rank: 'warn', ...site,
            what: 'Pusha already publishes page_viewed on every swap — a theme-supplied one double-counts' });
        } else if (!spec) {
          findings.push({ kind: 'conformance', rank: 'warn', ...site,
            what: `"${rawName}" is not a known page-type standard event — verify against the Web Pixels standard events` });
        } else if (parsed && !(parsed.data && Object.prototype.hasOwnProperty.call(parsed.data, spec.requires))) {
          findings.push({ kind: 'conformance', rank: 'gap', ...site,
            what: `${rawName} payload is missing required data.${spec.requires}` });
        }
        if (location === 'shell') {
          findings.push({ kind: 'placement', rank: 'gap', ...site,
            what: `marker in the persistent shell — re-read on every nav, so ${rawName} republishes one page's payload forever` });
        }
      }

      // Raw pixels — direct installs that bypass Customer Events entirely.
      // These need a manual refire hook. Do NOT advise migrating them into
      // Customer Events: that channel is unreachable on a swap, so migrating a
      // working raw pixel breaks it.
      text.split('\n').forEach((ln, i) => {
        for (const p of RAW_PIXEL_PATTERNS) {
          if (p.re.test(ln)) {
            findings.push({ kind: 'raw-pixel', rank: 'warn', file: rel, line: i + 1, location,
              what: `${p.what} — fires once per document, so it needs a manual refire from onAfterInit` });
          }
        }
      });
    }
  }

  for (const spec of PAGE_TYPE_EVENTS) {
    const hasPage = [...pageFiles].some((f) => spec.probes.some((prefix) => f.startsWith(prefix)));
    if (hasPage && !seenEvents.has(spec.event)) {
      findings.push({ kind: 'coverage', rank: 'gap', file: '(theme)', line: null, location: null,
        event: spec.event,
        what: `no ${spec.event} marker — the page exists but nothing re-publishes the event on a swap` });
    }
  }

  const byFileLine = (a, b) => (a.file || '').localeCompare(b.file || '') || (a.line ?? 0) - (b.line ?? 0);
  findings.sort(byFileLine);
  markers.sort(byFileLine);
  return { findings, markers };
}

// ─── Bucket X: theme app extensions ─────────────────────────────────────────
// Two reports. X-surface: every `{ "type": "@app" }` declaration in a
// {% schema %}, split by container membership — valid with zero apps
// installed, and the half that never expires. X-placed: the recursive walk of
// every blocks tree in templates/*.json and sections/*.json, plus
// config/settings_data.json -> current.blocks for app embeds — what is
// actually installed, right now.
//
// shopify://apps/{app-handle}/blocks/{block-handle}/{extension-uuid}
// JSON.parse decodes the escaped `shopify:\/\/apps\/` encoding transparently, so
// this only ever sees plain slashes. NEVER text-match a file for this prefix.
const APP_TYPE_RE = /^shopify:\/\/apps\/([^/]+)\/blocks\/([^/]+)(?:\/([^/]+))?/;

function parseAppBlockType(type) {
  if (typeof type !== 'string' || !type) return null;
  const m = APP_TYPE_RE.exec(type);
  if (!m) return null;
  return { appHandle: m[1], blockHandle: m[2], uuid: m[3] ?? null };
}

// Walk a `blocks` container (object map or array) and every nested `blocks`
// under it. No depth limit — Horizon templates reach depth 3 with zero apps
// installed, and a flat walk returns nothing there while looking healthy.
// `trail` accumulates the block-key address; `onApp(app, trailCopy)` fires per
// app node, with `trailCopy` holding every key from the top of this tree down
// to (and including) the app node itself.
function walkBlockTree(blocks, trail, onApp) {
  if (!blocks || typeof blocks !== 'object') return;
  const entries = Array.isArray(blocks)
    ? blocks.map((node, i) => [String(i), node])
    : Object.entries(blocks);
  for (const [key, node] of entries) {
    if (!node || typeof node !== 'object') continue;
    const nextTrail = trail.concat(key);
    const app = parseAppBlockType(node.type);
    if (app) onApp(app, nextTrail);
    if (node.blocks) walkBlockTree(node.blocks, nextTrail, onApp);
  }
}

const SCHEMA_RE = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/;

const SCRIPT_TAG_BLIND_SPOT = {
  location: 'script',
  verdict: 'opaque',
  what: 'Script Tag API — runtime-injected, invisible to a static audit.',
};

function detectAppSurfaces(themePath, shellRelSet) {
  // kind -> `${appHandle}/${blockHandle}` -> { appHandle, blockHandle, placements }
  const placementsByKind = { 'app-block': new Map(), 'app-embed': new Map() };
  let disabledEmbeds = 0;

  const addPlacement = (kind, app, location, address) => {
    const key = `${app.appHandle}/${app.blockHandle}`;
    const byKey = placementsByKind[kind];
    if (!byKey.has(key)) byKey.set(key, { appHandle: app.appHandle, blockHandle: app.blockHandle, placements: [] });
    byKey.get(key).placements.push({ file: address.file, address: address.text, location });
  };

  // Location: the file the placement lives in decides, not the host section's
  // type — a section type used both in a group and a template is in
  // shellRelSet, which would wrongly mark the template placement as surviving.
  const walkPlacementFile = (parsed, rel, location) => {
    if (!parsed || typeof parsed.sections !== 'object' || parsed.sections === null || Array.isArray(parsed.sections)) return;
    for (const [sectionId, instance] of Object.entries(parsed.sections)) {
      if (!instance || typeof instance !== 'object') continue;
      walkBlockTree(instance.blocks, [], (app, trail) => {
        const blockPath = trail.map((k) => `block ${k}`).join(' → ');
        const text = `${rel} → section ${sectionId} (type: ${instance.type}) → ${blockPath}`;
        addPlacement('app-block', app, location, { file: rel, text });
      });
    }
  };

  // X-placed — app blocks. templates/*.json (walkFiles recurses, so
  // templates/customers/*.json is covered) → 'section'.
  for (const file of walkFiles(join(themePath, 'templates'), ['.json'])) {
    const rel = relative(themePath, file);
    walkPlacementFile(parseThemeJson(readFileText(file)), rel, 'section');
  }

  // Every .json directly under sections/ (section groups) → 'shell'.
  const sectionsDir = join(themePath, 'sections');
  if (existsSync(sectionsDir)) {
    for (const entry of readdirSync(sectionsDir)) {
      if (!entry.endsWith('.json')) continue;
      const file = join(sectionsDir, entry);
      const rel = relative(themePath, file);
      walkPlacementFile(parseThemeJson(readFileText(file)), rel, 'shell');
    }
  }

  // X-placed — app embeds. config/settings_data.json -> current.blocks,
  // filtered to disabled !== true. `current` may be a string (unconfigured
  // theme storing a preset name) — guard the type before reading .blocks.
  const settingsText = readFileText(join(themePath, 'config/settings_data.json'));
  const settingsParsed = parseThemeJson(settingsText);
  const current = settingsParsed && settingsParsed.current;
  const currentBlocks = current && typeof current === 'object' && !Array.isArray(current) ? current.blocks : null;
  if (currentBlocks && typeof currentBlocks === 'object' && !Array.isArray(currentBlocks)) {
    for (const [key, entry] of Object.entries(currentBlocks)) {
      if (!entry || typeof entry !== 'object') continue;
      const app = parseAppBlockType(entry.type);
      if (!app) continue;
      if (entry.disabled === true) { disabledEmbeds++; continue; }
      const text = `config/settings_data.json → current.blocks.${key}`;
      addPlacement('app-embed', app, 'embed', { file: 'config/settings_data.json', text });
    }
  }

  // Dedupe is already done by keying placementsByKind above. Finalize each
  // finding's verdict as the worst-case location among its placements.
  const findings = [];
  for (const [kind, byKey] of Object.entries(placementsByKind)) {
    for (const { appHandle, blockHandle, placements } of byKey.values()) {
      placements.sort((a, b) => a.file.localeCompare(b.file) || a.address.localeCompare(b.address));
      const location = kind === 'app-embed' ? 'embed' : (placements.some((p) => p.location === 'section') ? 'section' : 'shell');
      const verdict = location === 'section' ? 'at-risk' : location === 'shell' ? 'survives' : 'survives-verify';
      findings.push({ kind, appHandle, blockHandle, location, verdict, placements });
    }
  }
  findings.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'app-block' ? -1 : 1)
    || a.appHandle.localeCompare(b.appHandle)
    || a.blockHandle.localeCompare(b.blockHandle));

  // X-surface — the @app capability map. For every .liquid under sections/
  // and blocks/: extract the {% schema %} body, check schema.blocks for an
  // "@app" entry. Ignore presets.
  const capabilities = [];
  const scanCapabilities = (dir) => {
    for (const file of walkFiles(join(themePath, dir), ['.liquid'])) {
      const rel = relative(themePath, file);
      const m = SCHEMA_RE.exec(readFileText(file));
      if (!m) continue;
      const schema = parseThemeJson(m[1]);
      if (!schema || !Array.isArray(schema.blocks)) continue;
      if (!schema.blocks.some((b) => b && b.type === '@app')) continue;

      // Priority order — first match wins.
      let location;
      if (schema.enabled_on && Array.isArray(schema.enabled_on.groups) && schema.enabled_on.groups.length > 0) {
        location = 'shell'; // renders only in section groups
      } else if (shellRelSet.has(rel)) {
        location = 'shell'; // actually referenced by a group JSON
      } else if (schema.disabled_on && Array.isArray(schema.disabled_on.groups) && schema.disabled_on.groups.length > 0) {
        location = 'section'; // fenced out of the shell — can only be in the swapped container
      } else {
        location = locationClass(rel, shellRelSet); // 'section' for sections/*.liquid, 'block' for blocks/*.liquid
      }

      const note = location === 'section' ? 'at-risk if used — renders inside the swap container'
        : location === 'shell' ? 'survives — renders in a section group, outside the swap container'
        : "depends on host section — a theme block inherits its host's location";
      capabilities.push({ file: rel, location, note });
    }
  };
  scanCapabilities('sections');
  scanCapabilities('blocks');
  capabilities.sort((a, b) => a.file.localeCompare(b.file));

  // Wrapper resolution (three steps, both candidates theme-owned). The
  // wrapper file normally also declares @app in its own schema, so it appears
  // both as the wrapper line and as a [section] capability entry — intended,
  // not a double-count.
  let wrapper;
  if (existsSync(join(themePath, 'sections/apps.liquid'))) {
    wrapper = { kind: 'apps.liquid', file: 'sections/apps.liquid' };
  } else if (existsSync(join(themePath, 'sections/_blocks.liquid'))) {
    wrapper = { kind: '_blocks.liquid', file: 'sections/_blocks.liquid' };
  } else {
    wrapper = { kind: 'platform-fallback', file: null };
  }

  return { findings, capabilities, wrapper, disabledEmbeds };
}

const BUCKET_RULES = {
  A: 'Safe. External <script src> tags are re-loaded by Pusha\'s syncHeadScripts on every nav.',
  B: 'Safe. JSON data blocks are non-executable.',
  C: 'Safe (verify). Custom elements with disconnectedCallback clean up automatically.',
  D: 'Needs cleanup — an observer, interval, animation or window-level listener outlives the DOM it references. Best fix: promote to a custom element and tear down in disconnectedCallback, which the browser calls for you. If the markup cannot become a custom element, give the section a data-section-type root and register window.theme.sectionDestroy[handle] = (root) => {...}; Pusha calls it with the node still connected, immediately before the container is replaced.',
  E: 'Procedural inline script that must re-run on each swap. The correct fix depends on where it lives — see "Fix by location" below.',
  F: 'F1 (custom element class) is already safe. F2 (procedural {% javascript %}) must re-run per swap — fix by location, see below.',
  G: 'DOMContentLoaded does not re-fire after a swap. The replacement depends on where the handler lives — see "Fix by location" below.',
  H: 'Human review. Module-level state and IIFEs hold closures that don\'t replay on swap. Check reachability — dead code can be deleted; live code needs refactor.',
  K: 'Portal-to-body custom element. Survives a swap because connectedCallback moves it outside the swap container. Add `data-pusha-cleanup` to every render site so Pusha removes it before each nav.',
  L: 'Per-request Liquid in the layout shell (layout/theme.liquid, section groups, transitively-rendered snippets) freezes on first load. Sub-letters mirror the request-scoped taxonomy: A=URL/template, B=customer, C=cart, D=locale, E=per-page object, F=personalization, G=time, H=app-injected. Rank: auto=URL-derivable in JS, ask=user decides (full-reload boundary or section refetch), ok=already handled by Pusha or theme convention.',
  M: 'Persistent-shell stateful UI — modals/drawers/overlays that lived outside #MainContent and were authored assuming a full reload would dismiss them. Three remediation options: (1) add `data-pusha-close-on-nav` to the root (Pusha strips `[open]` / sets `aria-expanded="false"` / removes body classes listed in `data-pusha-body-class-on-open`); (2) implement a `closeOnNav()` method on the custom element; (3) call `Pusha.onBeforeLeave(() => this.close())` manually. Cart drawers and persistent widgets simply omit the marker — opt-in is the safe default.',
  J: 'Analytics surface. NOTE: Pusha reaches the pixel sandbox only through PREFIXED CUSTOM events — the customEvents bridge publishes pusha:page_viewed plus prefixed copies of the page-type payloads, and those are delivered to custom pixels and app pixels. What is fenced is publishing under STANDARD names, which the storefront API rejects, so a standard page_viewed never arrives on a swap. Delivery is not consumption: a third-party app pixel subscribed to the standard vocabulary has no mapping for a prefixed name, so reviving it still needs a companion custom pixel that forwards the event (docs/analytics-companion-pixel.md, README "Analytics & tracking"). This bucket checks the theme-serialized <script type="application/json" data-pusha-analytics-event> blocks anyway, because they are hand-written Liquid that nothing validates at runtime and keeping their shape right is what makes a supported publish path cheap to adopt later. Four kinds: coverage (a product/collection/search/cart page with no marker), conformance (unparseable JSON, a missing type attribute the browser then executes as JS, or a payload missing its required data key), placement (a marker in the persistent shell is re-read on every nav and would republish one page\'s payload forever), and raw-pixel (gtag/fbq/dataLayer calls installed directly in the theme — refire them manually from onAfterInit; do NOT migrate them into Customer Events, which would move a working pixel onto the unreachable channel).',
  P: 'Informational — {% partial %} + @shopify/partial-rendering regions (new-Liquid\'s islands substrate). The inventory maps each partial to its consumers. The partial name is a load-bearing string contract (renaming a declaration breaks every consumer), and Pusha must coordinate its container swap with the theme\'s partials.apply() so a nav mid-refresh has defined ordering.',
  X: 'Theme app extensions. Informational + advisory — an app\'s code cannot be mechanically transformed, so X inventories app surfaces and assigns each a swap-safety verdict routed by location. Two reports: X-surface lists every { "type": "@app" } declaration in a {% schema %}, split by container membership — a risk map that stays valid when the merchant installs something tomorrow, and it works with zero apps installed. X-placed recursively walks the blocks tree of every templates/*.json and sections/*.json plus config/settings_data.json -> current.blocks, and reports what is actually installed. Detection parses JSON and reads `type`: a text match misses the escaped `shopify:\\/\\/apps\\/` encoding Shopify writes into some template files, and would report the flagship product template as app-free. Verdicts: at-risk (app block inside the swap container), survives (app block in a section group), survives-verify (app embed — outside the container, but references into the swapped region go stale with no repair signal), opaque (Script Tag API — invisible statically). App embeds with disabled: true are ignored.',
};

function printAuditText(themePath, { findings, summary, suppressed, analyticsMarkers, appSurfaces, skillFreshness, whitelistsActive }) {
  const NL = '\n';
  let out = '';
  out += `# pusha audit${NL}`;
  out += `theme: ${themePath}${NL}`;
  out += `date:  ${new Date().toISOString()}${NL}`;
  out += `whitelists: ${whitelistsActive ? 'on (default — pass --no-whitelist to disable)' : 'OFF (raw findings)'}${NL}${NL}`;

  const section = (title, rule, items, formatter) => {
    out += `## ${title}${NL}`;
    out += `  ${rule}${NL}`;
    if (items.length === 0) {
      out += `  (none)${NL}${NL}`;
      return;
    }
    for (const item of items) out += `  ${formatter(item)}${NL}`;
    out += NL;
  };

  // Like section(), but tags each finding with its location class and prints a
  // "Fix by location" legend covering only the locations that appear. `needsFix`
  // selects which items drive the legend (F1 items are already safe).
  const routedSection = (title, bucket, items, formatter, needsFix = () => true) => {
    out += `## ${title}${NL}`;
    out += `  ${BUCKET_RULES[bucket]}${NL}`;
    if (items.length === 0) { out += `  (none)${NL}${NL}`; return; }
    const locs = new Set();
    for (const item of items) {
      const loc = item.location || 'shell';
      if (needsFix(item)) locs.add(loc);
      out += `  ${formatter(item)}  [${loc}]${NL}`;
    }
    const rem = REMEDIATION[bucket] || {};
    const present = LOCATION_ORDER.filter((l) => locs.has(l) && rem[l]);
    if (present.length) {
      out += `  Fix by location:${NL}`;
      for (const loc of present) out += `    · ${loc.padEnd(12)}→ ${rem[loc]}${NL}`;
    }
    out += NL;
  };

  section('A. External <script src> — safe', BUCKET_RULES.A, findings.A,
    (i) => `${i.file}:${i.line}: ${i.match}`);
  section('B. JSON data <script type="application/(ld+)?json"> — safe', BUCKET_RULES.B, findings.B,
    (i) => `${i.file}:${i.line}: ${i.match}`);
  section('C. Custom elements — safe (verify)', BUCKET_RULES.C, findings.C,
    (i) => `${i.file}  [${i.shape}]`);
  section('D. Custom elements — needs cleanup', BUCKET_RULES.D, findings.D,
    (i) => `${i.file}  [${i.shape}]`);
  routedSection('E. Procedural inline <script> — wrap by location', 'E', findings.E,
    (i) => `${i.file}:${i.line}: ${i.match}`);
  routedSection('F. {% javascript %} blocks — F1 safe, F2 wrap by location', 'F', findings.F,
    (i) => `${i.kind}: ${i.file}`, (i) => i.kind === 'F2');
  routedSection('G. DOMContentLoaded handlers — replace by location', 'G', findings.G,
    (i) => `${i.file}:${i.line}: ${i.match}`);
  routedSection('H. Module-level state — hard, human review', 'H', findings.H,
    (i) => `${i.file}  [${i.reason}]${i.reachability ? ` (${i.reachability})` : ''}`);

  // K renders with two sub-levels: the class + its render sites.
  out += `## K. Portal-to-body custom elements — add data-pusha-cleanup${NL}`;
  out += `  ${BUCKET_RULES.K}${NL}`;
  if (findings.K.length === 0) {
    out += `  (none)${NL}${NL}`;
  } else {
    for (const k of findings.K) {
      const inherit = k.via ? ` (inherits portal from ${k.via})` : ' (direct portal)';
      out += `  <${k.tag}>  defined in ${k.definedIn}  [class ${k.className}${inherit}]${NL}`;
      if (k.sites.length === 0) {
        out += `    (no render sites found)${NL}`;
      } else {
        for (const s of k.sites) {
          const flag = s.alreadyMarked ? '✓ already marked' : '+ add data-pusha-cleanup';
          out += `    ${flag}  ${s.file}:${s.line}: ${s.snippet}${NL}`;
        }
      }
    }
    out += NL;
  }

  if (findings.unknown.length) {
    out += `## ? — unrecognized custom element shape${NL}`;
    for (const i of findings.unknown) out += `  ${i.file}  [${i.shape}]${NL}`;
    out += NL;
  }

  // L renders grouped by sub-letter, each finding tagged with rank.
  out += `## L. Liquid persistent state — request-scoped Liquid in the layout shell${NL}`;
  out += `  ${BUCKET_RULES.L}${NL}`;
  if (findings.L.length === 0) {
    out += `  (none)${NL}${NL}`;
  } else {
    const grouped = {};
    for (const f of findings.L) {
      (grouped[f.sub] ??= []).push(f);
    }
    for (const sub of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
      if (!grouped[sub]) continue;
      for (const f of grouped[sub]) {
        const partialNote = f.partialCovered ? ' [verify: may self-heal via partial refresh]' : '';
        out += `  ${f.file}:${f.line}: [L-${sub} ${f.rank}] ${f.what}${partialNote}${NL}`;
        out += `      ${f.match}${NL}`;
      }
    }
    out += NL;
  }

  // M — persistent-shell stateful UI (modals/drawers/overlays + body-class
  // lockouts). Findings are "ask" — each requires a per-element decision.
  out += `## M. Persistent-shell stateful UI — close-on-nav opt-in${NL}`;
  out += `  ${BUCKET_RULES.M}${NL}`;
  if (findings.M.length === 0) {
    out += `  (none)${NL}${NL}`;
  } else {
    const modals = findings.M.filter((x) => x.kind !== 'body-class');
    const bodyClasses = findings.M.filter((x) => x.kind === 'body-class');
    if (modals.length) {
      out += `  Stateful elements in persistent shell (add data-pusha-close-on-nav, or implement closeOnNav()):${NL}`;
      for (const f of modals) {
        out += `    ${f.file}:${f.line}: [M ${f.kind}] ${f.what}${NL}`;
        out += `        ${f.match}${NL}`;
      }
    }
    if (bodyClasses.length) {
      out += `  Body-class mutations (track these on the modal root via data-pusha-body-class-on-open="..."):${NL}`;
      for (const f of bodyClasses) {
        out += `    ${f.file}:${f.line}: [M body-class] ${f.what}${NL}`;
      }
    }
    out += NL;
  }

  // J — analytics surface. Inventory of serialized page-type events, then the
  // ranked findings (gaps first — those are silent data loss).
  out += `## J. Analytics surface${NL}`;
  out += `  ${BUCKET_RULES.J}${NL}`;
  const markers = analyticsMarkers ?? [];
  if (markers.length === 0 && findings.J.length === 0) {
    out += `  (none)${NL}${NL}`;
  } else {
    if (markers.length) {
      out += `  Serialized events:${NL}`;
      for (const mk of markers) {
        out += `    ${mk.file}:${mk.line}: ${mk.event}  [${mk.location}]${NL}`;
      }
    }
    const gaps = findings.J.filter((f) => f.rank === 'gap');
    const warns = findings.J.filter((f) => f.rank === 'warn');
    for (const [label, list] of [['gap', gaps], ['warn', warns]]) {
      if (!list.length) continue;
      out += `  ${label === 'gap' ? 'Gaps — silent data loss or corruption:' : 'Advisory:'}${NL}`;
      for (const f of list) {
        const where = f.line ? `${f.file}:${f.line}` : f.file;
        out += `    ${where}: [J-${f.kind}] ${f.what}${NL}`;
      }
    }
    if (gaps.length) {
      out += `  A missing or malformed marker never throws — the event simply stops reaching Meta/GA4/TikTok/Klaviyo.${NL}`;
      out += `  Validate on a published theme with live pixels; a preview environment won't show the loss.${NL}`;
    }
    out += NL;
  }

  // P — partials inventory (informational). Declarations mapped to consumers.
  out += `## P. Partials — server-rendered refresh regions (informational)${NL}`;
  out += `  ${BUCKET_RULES.P}${NL}`;
  if (findings.P.length === 0) {
    out += `  (none)${NL}${NL}`;
  } else {
    for (const p of findings.P) {
      const decl = p.declaredAt.map((d) => `${d.file}:${d.line}`).join(', ') || '—';
      const cons = p.consumers.map((c) => `${c.file}:${c.line}`).join(', ') || '—';
      const flag = p.dangling === 'undeclared' ? '  [!! consumed but not declared — typo or missing {% partial %}?]'
        : p.dangling === 'no-attr-consumer' ? '  [i no data-partials consumer — may be fetched in JS]'
        : '';
      out += `  '${p.name}'${flag}${NL}`;
      out += `      declared: ${decl}${NL}`;
      out += `      consumed: ${cons}${NL}`;
    }
    out += `  The partial name is a string contract — renaming a declaration breaks every consumer.${NL}`;
    out += `  Dual-swap: Pusha's container swap and the theme's partials.apply() both mutate the DOM; a nav${NL}`;
    out += `  during an in-flight partial refresh has no defined ordering — coordinate in the runtime.${NL}${NL}`;
  }

  // X — theme app extensions. Grouped by verdict, never a flat list: a reader
  // must never mistake a surviving embed for a breakage. Never entirely
  // "(none)" — the blind-spot footer always prints, and a suppressed
  // disabled-embed count is always surfaced, never silent.
  out += `## X. Theme app extensions — app blocks, embeds, and the Script Tag blind spot${NL}`;
  out += `  ${BUCKET_RULES.X}${NL}`;
  const wrapper = appSurfaces.wrapper;
  const wrapperLine = wrapper.kind === 'platform-fallback'
    ? 'platform-generated fallback (no sections/apps.liquid or sections/_blocks.liquid)'
    : `${wrapper.file}  (theme-owned — top-level app blocks render through it)`;
  out += `  App wrapper: ${wrapperLine}${NL}`;

  out += `  X-surface — where app blocks can land (@app schema declarations; valid with zero apps installed):${NL}`;
  if (appSurfaces.capabilities.length === 0) {
    out += `    (none)${NL}`;
  } else {
    for (const c of appSurfaces.capabilities) out += `    ${c.file.padEnd(36)}[${c.location}]    ${c.note}${NL}`;
  }

  out += `  X-placed — apps actually installed:${NL}`;
  const xAtRisk = findings.X.filter((f) => f.verdict === 'at-risk');
  const xSurvives = findings.X.filter((f) => f.verdict === 'survives');
  const xSurvivesVerify = findings.X.filter((f) => f.verdict === 'survives-verify');
  const xPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  if (xAtRisk.length === 0 && xSurvives.length === 0 && xSurvivesVerify.length === 0) {
    out += `    (none)${NL}`;
  } else {
    const printAppBlockGroup = (label, items, note) => {
      if (!items.length) return;
      out += `    ${label} (${xPlural(items.length, 'app block', 'app blocks')}) — ${note}${NL}`;
      for (const f of items) {
        out += `      ${f.appHandle} · ${f.blockHandle}  [${f.location}]${NL}`;
        for (const p of f.placements) {
          const tag = p.location === f.location ? '' : `  [${p.location} — this placement survives]`;
          out += `        ${p.address}${tag}${NL}`;
        }
      }
    };
    printAppBlockGroup('AT-RISK', xAtRisk, 'inside the swap container; init JS ran on the old document and does not re-run:');
    printAppBlockGroup('SURVIVES', xSurvives, 'renders in a section group, outside the swap container; init runs once and keeps running:');
    if (xSurvivesVerify.length) {
      out += `    SURVIVES, VERIFY (${xPlural(xSurvivesVerify.length, 'embed', 'embeds')}) — outside the container, so they survive; but JS holding references INTO the swapped region goes stale silently, and no signal exists to repair it:${NL}`;
      for (const f of xSurvivesVerify) {
        const p = f.placements[0];
        out += `      ${`${f.appHandle} · ${f.blockHandle}`.padEnd(42)}${p.address}${NL}`;
      }
    }
  }
  if (appSurfaces.disabledEmbeds > 0) {
    out += `    ${xPlural(appSurfaces.disabledEmbeds, 'disabled embed', 'disabled embeds')} not reported.${NL}`;
  }

  const xLocsPresent = new Set(findings.X.map((f) => f.location));
  const xLocsOrder = LOCATION_ORDER.filter((l) => xLocsPresent.has(l) && REMEDIATION.X[l]);
  if (xLocsOrder.length) {
    out += `  Verdict → posture:${NL}`;
    for (const loc of xLocsOrder) out += `    · ${loc.padEnd(12)}→ ${REMEDIATION.X[loc]}${NL}`;
  }

  out += `  Blind spot — Script Tag API: apps can inject <script> at runtime. Those tags are not in any theme file,${NL}`;
  out += `  so this audit cannot see them and their absence above is not evidence of absence. They initialize once${NL}`;
  out += `  and go silent after page one. Verify in a live session.${NL}${NL}`;

  out += `## Summary${NL}`;
  out += `  A external src refs:           ${summary.A}${NL}`;
  out += `  B JSON / ld+json data blocks:  ${summary.B}${NL}`;
  out += `  C/D custom elements:           ${summary.C + summary.D}  (safe: ${summary.C}, cleanup-candidate: ${summary.D})${NL}`;
  out += `  E procedural inline scripts:   ${summary.E}${NL}`;
  out += `  F {% javascript %} blocks:     ${summary.F1 + summary.F2}  (F1 safe: ${summary.F1}, F2 wrap: ${summary.F2})${NL}`;
  out += `  G DOMContentLoaded handlers:   ${summary.G}${NL}`;
  out += `  H module-level state:          ${summary.H}${NL}`;
  out += `  K portal-to-body classes:      ${summary.K}  (${summary.K_sites} render site(s) need data-pusha-cleanup)${NL}`;
  out += `  L Liquid persistent state:     ${summary.L}  (auto: ${summary.L_auto}, ask: ${summary.L_ask}, ok: ${summary.L_ok})${NL}`;
  out += `  M persistent-shell stateful UI: ${summary.M}  (modals: ${summary.M_modals}, body-class lockouts: ${summary.M_body_classes})${NL}`;
  out += `  J analytics surface:           ${summary.J}  (gaps: ${summary.J_gaps}, advisory: ${summary.J_warns})${NL}`;
  out += `  P partials:                    ${summary.P}${summary.P_gaps ? `  (${summary.P_gaps} consumed-but-undeclared — likely a naming-contract gap)` : ''}${NL}`;
  out += `${'  X theme app extensions:'.padEnd(33)}${summary.X}  (at-risk: ${summary.X_at_risk}, survives: ${summary.X_survives}, embeds survives-verify: ${summary.X_embeds}; @app sites: ${summary.X_capabilities})${NL}`;
  if (summary.unknown) out += `  ? unknown shape:               ${summary.unknown}${NL}`;
  out += NL;

  out += `## Suppressed by whitelists${NL}`;
  if (!whitelistsActive) {
    out += `  (whitelists are off — nothing was suppressed in this run)${NL}${NL}`;
  } else if (!suppressed || (suppressed.files.length === 0 && suppressed.E.length === 0 && suppressed.F.length === 0 && suppressed.G.length === 0 && suppressed.H.length === 0)) {
    out += `  (none — no findings matched a whitelist in this run)${NL}${NL}`;
  } else {
    out += `  These findings were classified by the audit but excluded by an active whitelist.${NL}`;
    out += `  Re-run with --no-whitelist to surface them in their original buckets.${NL}${NL}`;

    out += `  files — Pusha-self files (framework config / runtime code)${NL}`;
    if (suppressed.files.length === 0) {
      out += `    (no matches in this run)${NL}`;
    } else {
      // group by file → bucket counts for a compact listing
      const byFile = new Map();
      for (const s of suppressed.files) {
        const key = s.file;
        const counts = byFile.get(key) ?? {};
        counts[s.bucket] = (counts[s.bucket] ?? 0) + 1;
        byFile.set(key, counts);
      }
      for (const [file, counts] of byFile) {
        const parts = Object.entries(counts).map(([b, n]) => `${b} (${n})`).join(', ');
        out += `    ${file} → ${parts}${NL}`;
      }
    }
    out += NL;

    out += `  E — inline <script> in a file that also calls window.Pusha.on*${NL}`;
    if (suppressed.E.length === 0) {
      out += `    (no matches in this run)${NL}`;
    } else {
      for (const s of suppressed.E) {
        out += `    ${s.file}:${s.line}: ${s.match}${NL}`;
      }
    }
    out += NL;

    out += `  F — {% javascript %} body is only sectionInits/sectionDestroy registrations (already ported)${NL}`;
    if (suppressed.F.length === 0) {
      out += `    (no matches in this run)${NL}`;
    } else {
      for (const s of suppressed.F) {
        out += `    ${s.file}: ${s.match}${NL}`;
      }
    }
    out += NL;

    out += `  G — DOMContentLoaded handler in a file that also calls window.Pusha.on*${NL}`;
    if (suppressed.G.length === 0) {
      out += `    (no matches in this run)${NL}`;
    } else {
      for (const s of suppressed.G) {
        out += `    ${s.file}:${s.line}: ${s.match}${NL}`;
      }
    }
    out += NL;

    out += `  H — canonical Pusha top-level mutation (sectionInits / sectionDestroy / config / bootstrap)${NL}`;
    if (suppressed.H.length === 0) {
      out += `    (no matches in this run)${NL}`;
    } else {
      for (const s of suppressed.H) {
        out += `    ${s.file}: ${s.match}    [${s.reason}]${NL}`;
      }
    }
    out += NL;
  }

  out += `## Active whitelists${NL}`;
  if (!whitelistsActive) {
    out += `  (none — running with --no-whitelist; output above is raw)${NL}${NL}`;
  } else {
    out += `  files — ${WHITELISTS.files.description}${NL}`;
    out += `    skips: ${WHITELISTS.files.items.join(', ')}${NL}`;
    out += `  H — ${WHITELISTS.H.description}${NL}`;
    for (const p of WHITELISTS.H.patterns) out += `    drop /${p.rule.source}/  (${p.why})${NL}`;
    out += `  E — ${WHITELISTS.E.description}${NL}`;
    out += `    skip a file's E findings if it also calls window.Pusha.on*${NL}`;
    out += `  F — ${WHITELISTS.F.description}${NL}`;
    out += `    skip an F2 whose {% javascript %} body is only sectionInits/sectionDestroy registrations${NL}`;
    out += `  G — ${WHITELISTS.G.description}${NL}`;
    out += `    skip a file's G findings if it also calls window.Pusha.on*${NL}`;
    out += `  Pass --no-whitelist to disable all of the above and see raw findings.${NL}${NL}`;
  }

  out += `## Next steps${NL}`;
  out += `  This report is written to be worked by a coding agent. In --json every finding${NL}`;
  out += `  carries a stable \`id\` and an \`action\`, and \`queue\` lists the work in order.${NL}`;
  out += `  Install the rules it applies with: pusha skill --claude${NL}${NL}`;
  // Derived from the same tables the JSON `queue` uses, so the text report and
  // the machine contract cannot drift apart.
  const tally = {};
  for (const [bucket, list] of Object.entries(findings)) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (!f.action || f.action === 'none') continue;
      (tally[f.action] ??= {})[bucket] = ((tally[f.action] ?? {})[bucket] ?? 0) + 1;
    }
  }
  const working = ACTION_WORK_ORDER.filter((a) => a !== 'none' && tally[a]);
  if (working.length === 0) {
    out += `  Nothing to do — no finding in this theme carries an action.${NL}${NL}`;
  } else {
    for (const action of working) {
      const perBucket = tally[action];
      const total = Object.values(perBucket).reduce((n, v) => n + v, 0);
      const breakdown = BUCKET_WORK_ORDER.filter((b) => perBucket[b])
        .map((b) => `${b}x${perBucket[b]}`)
        .join('  ');
      out += `    ${action.padEnd(9)} ${String(total).padStart(4)}   ${breakdown}${NL}`;
      out += `              ${' '.repeat(4)}   ${AUDIT_ACTIONS[action]}${NL}`;
    }
    out += NL;
    out += `    pusha audit --json --action transform   # the mechanical queue, in order${NL}`;
    out += `    pusha audit --json --action decide      # the calls that are yours to make${NL}${NL}`;
  }
  out += `  Transformation contracts by location (every E/F2/G/H finding carries a [location] tag):${NL}`;
  out += `    section     — data-section-type="<handle>" on the root; window.theme.sectionInits[handle] = (root) => {…};${NL}`;
  out += `                  rewrite document.query* → root.query*; guard listeners with data-initialized.${NL}`;
  out += `    block       — promote to a custom element (connected/disconnectedCallback); the browser re-mounts it.${NL}`;
  out += `    template    — a custom element, or an onAfterInit((c, meta) => …) hook keyed on meta.template.${NL}`;
  out += `    shell       — runs once and persists across navs; use onFirstLoad / setupGlobal, never sectionInits.${NL}`;
  out += `    head-config — inert config (no call expressions); leave as-is, it is safe across swaps.${NL}${NL}`;
  out += `  A and B need no action. C is safe but verify external refs are tracked.${NL}`;
  out += `  Re-run with --json for structured output a tool can consume directly.${NL}${NL}`;

  out += `## Skill freshness${NL}`;
  out += `  CLI is @mimeticthemes/pusha@${PACKAGE_VERSION}.${NL}`;
  if (!skillFreshness || skillFreshness.length === 0) {
    out += `  No installed skill files found at standard paths (.claude/skills/pusha/, .cursor/rules/pusha.md, .aider-conventions.md).${NL}`;
    out += `  Run \`pusha skill --claude\` (or --cursor / --aider) to install one.${NL}${NL}`;
  } else {
    for (const s of skillFreshness) {
      const scope = s.scope === 'global' ? ' (global)' : '';
      const versionText = s.installedVersion ?? '(no version marker)';
      if (s.current) {
        out += `  ✓ ${s.path}${scope} — ${versionText}${NL}`;
      } else {
        out += `  ! ${s.path}${scope} — ${versionText}, run \`pusha skill --${s.agent}${s.scope === 'global' ? ' --global' : ''}\` to refresh${NL}`;
      }
    }
    out += NL;
  }

  out += `## Where to find more${NL}`;
  out += `  PATTERNS.md — full transformation patterns, edge cases, decision trees${NL}`;
  out += `  SKILL.md    — end-to-end porter procedure (audit → delegate → diff → review)${NL}${NL}`;
  out += `  After \`npm install github:mimetic-themes/pusha\`:${NL}`;
  out += `    node_modules/@mimeticthemes/pusha/skill/{SKILL.md, PATTERNS.md}${NL}${NL}`;
  out += `  Or via this CLI:${NL}`;
  out += `    pusha audit --full                  (append PATTERNS.md to this report)${NL}`;
  out += `    pusha skill --print                 (dump both to stdout)${NL}`;
  out += `    pusha skill --claude                (→ .claude/skills/pusha/)${NL}`;
  out += `    pusha skill --cursor                (→ .cursor/rules/pusha.md)${NL}`;
  out += `    pusha skill --aider                 (→ .aider-conventions.md)${NL}`;
  out += `    add --global to install into ~/ instead of project-local${NL}`;

  return out;
}

// ─── agent contract ──────────────────────────────────────────────────────────
// The audit's consumer is a coding agent, not a person reading a report. Three
// things make that work: a stable id per finding (so progress survives the edits
// the agent itself makes), an `action` telling it whether to act or escalate,
// and a `queue` so the ordering lives here rather than being re-derived.
//
// Bump on any change to finding fields, action values, or queue semantics.
const AUDIT_SCHEMA_VERSION = 1;

const AUDIT_ACTIONS = {
  transform: 'Apply the documented fix. Mechanical — the rule is in remediationByLocation or bucketRules.',
  decide: 'Do not guess. Surface to the supervising human with the surrounding code and the options.',
  verify: 'Cannot be settled from source. Check at runtime on a real storefront and report what you saw.',
  none: 'Informational. Already safe, or not yours to change. Do not edit.',
};

// Buckets an agent must never rewrite, and why — restated per-finding as
// action:none so a filtered query still carries the warning.
const DO_NOT_TRANSFORM = {
  A: 'already safe — syncHeadScripts re-loads these',
  B: 'already safe — JSON data blocks are not executable',
  C: 'already safe — custom elements re-mount themselves',
  P: 'inventory of a platform substrate, not a defect list',
  X: "app code you do not own; it cannot be mechanically transformed",
};

// Work order. Mechanical buckets first: they are cheap, low-risk, and shrink the
// report fastest, which keeps a long port legible to the human watching it.
const BUCKET_WORK_ORDER = ['K', 'F', 'E', 'G', 'M', 'L', 'D', 'H', 'J', 'X', 'C', 'P', 'A', 'B'];
const ACTION_WORK_ORDER = ['transform', 'decide', 'verify', 'none'];

function actionFor(bucket, f) {
  // `head-config` is inert configuration in the persistent shell — the
  // remediation table says leave it alone, so it must not enter the queue.
  const routed = f.location === 'head-config' ? 'none' : 'transform';
  switch (bucket) {
    case 'A': case 'B': case 'C': case 'P': return 'none';
    case 'E': case 'G': return routed;
    case 'F': return f.kind === 'F1' ? 'none' : routed;
    // K is satisfied per render site. A theme that already carries
    // data-pusha-cleanup everywhere has nothing to do, and must not head the
    // queue with a task that is finished.
    case 'K':
      return Array.isArray(f.sites) && f.sites.some((site) => !site.alreadyMarked)
        ? 'transform'
        : 'none';
    // Two valid answers (disconnectedCallback vs promote to a custom element)
    // and the choice changes the component's public shape. Human picks.
    case 'D': return 'decide';
    case 'H': return 'decide';
    // Re-firing a pixel means knowing which events that store actually needs.
    case 'J': return 'decide';
    case 'L': return f.rank === 'auto' ? 'transform' : f.rank === 'ask' ? 'decide' : 'none';
    // A custom modal may already own its close behaviour; details/body-class are
    // a single attribute.
    case 'M': return f.kind === 'custom-modal' ? 'decide' : 'transform';
    case 'X': return f.verdict === 'at-risk' ? 'decide' : 'verify';
    default: return 'decide';
  }
}

// Identity that survives the agent's own edits. Line numbers move the moment a
// file is rewritten, so they are excluded; everything else is normalised and
// hashed. Repeats within one bucket+file get a suffix so two identical snippets
// stay addressable.
function assignFindingIds(findings) {
  const seen = new Map();
  for (const [bucket, list] of Object.entries(findings)) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      const stable = {};
      for (const k of Object.keys(f).sort()) {
        if (k === 'line' || k === 'id' || k === 'action') continue;
        const v = f[k];
        stable[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
      }
      const base = createHash('sha1')
        .update(bucket + '\u0000' + JSON.stringify(stable))
        .digest('hex')
        .slice(0, 12);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      f.id = n === 0 ? base : `${base}-${n}`;
      f.action = actionFor(bucket, f);
    }
  }
}

// Not every finding is file-shaped: K is keyed by custom-element class and
// carries its render sites in `sites`.
function findingPath(f) {
  return String(f.file ?? f.definedIn ?? '');
}

function findingTouches(f, needle) {
  if (findingPath(f).includes(needle)) return true;
  return Array.isArray(f.sites) && f.sites.some((site) => String(site.file ?? '').includes(needle));
}

function buildQueue(findings) {
  const flat = [];
  for (const [bucket, list] of Object.entries(findings)) {
    if (!Array.isArray(list)) continue;
    for (const f of list) flat.push({ bucket, f });
  }
  flat.sort((a, b) => {
    const byAction = ACTION_WORK_ORDER.indexOf(a.f.action) - ACTION_WORK_ORDER.indexOf(b.f.action);
    if (byAction) return byAction;
    const byBucket = BUCKET_WORK_ORDER.indexOf(a.bucket) - BUCKET_WORK_ORDER.indexOf(b.bucket);
    if (byBucket) return byBucket;
    const byFile = findingPath(a.f).localeCompare(findingPath(b.f));
    if (byFile) return byFile;
    return (a.f.line ?? 0) - (b.f.line ?? 0);
  });
  // Only work belongs in the queue. action:none findings stay in `findings`
  // for context but must never read as a task.
  return flat.filter(({ f }) => f.action !== 'none').map(({ f }) => f.id);
}

// Reads `--flag value` and `--flag=value`, and reports which argv entries it
// consumed so they are not mistaken for the theme path.
function readFlagValue(args, name) {
  const consumed = new Set();
  let value = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) {
      value = args[i + 1] ?? null;
      consumed.add(i);
      if (value !== null && !value.startsWith('--')) consumed.add(i + 1);
      else value = null;
    } else if (a.startsWith(`${name}=`)) {
      value = a.slice(name.length + 1);
      consumed.add(i);
    }
  }
  return { value, consumed };
}

async function runAudit(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(AUDIT_USAGE);
    return;
  }

  const json = args.includes('--json');
  const full = args.includes('--full');
  const useWhitelists = !args.includes('--no-whitelist');

  const bucketArg = readFlagValue(args, '--bucket');
  const actionArg = readFlagValue(args, '--action');
  const fileArg = readFlagValue(args, '--file');
  const consumed = new Set([...bucketArg.consumed, ...actionArg.consumed, ...fileArg.consumed]);
  const positional = args.filter((a, i) => !a.startsWith('--') && !consumed.has(i));
  const themePath = resolve(positional[0] ?? process.cwd());

  const filter = {
    buckets: bucketArg.value ? bucketArg.value.split(',').map((b) => b.trim().toUpperCase()).filter(Boolean) : null,
    actions: actionArg.value ? actionArg.value.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean) : null,
    file: fileArg.value || null,
  };
  const filtering = Boolean(filter.buckets || filter.actions || filter.file);

  // Filters reshape the payload into a work slice; the text report's counts and
  // legends assume the whole theme. Rather than print a report whose summary
  // disagrees with its body, say so.
  if (filtering && !json) {
    log.err('--bucket, --action and --file only apply to --json output.');
    log.warn('re-run with --json, or drop the filter to get the full text report');
    process.exit(1);
  }
  for (const a of filter.actions ?? []) {
    if (!(a in AUDIT_ACTIONS)) {
      log.err(`unknown --action "${a}".`);
      log.warn(`expected one of: ${Object.keys(AUDIT_ACTIONS).join(', ')}`);
      process.exit(1);
    }
  }

  if (!detectShopifyTheme(themePath)) {
    log.err(`${themePath} doesn't look like a Shopify theme.`);
    log.warn(`expected one of: layout/theme.liquid, sections/, config/settings_schema.json`);
    process.exit(1);
  }

  const result = auditTheme(themePath, { useWhitelists });
  result.skillFreshness = getSkillFreshness(themePath);
  assignFindingIds(result.findings);

  if (json && filtering) {
    const slice = [];
    for (const [bucket, list] of Object.entries(result.findings)) {
      if (!Array.isArray(list)) continue;
      if (filter.buckets && !filter.buckets.includes(bucket)) continue;
      for (const f of list) {
        if (filter.actions && !filter.actions.includes(f.action)) continue;
        if (filter.file && !findingTouches(f, filter.file)) continue;
        slice.push({ bucket, ...f });
      }
    }
    const order = buildQueue(result.findings);
    slice.sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    });
    const buckets = [...new Set(slice.map((f) => f.bucket))];
    const pick = (table) => Object.fromEntries(buckets.filter((b) => b in table).map((b) => [b, table[b]]));
    process.stdout.write(JSON.stringify({
      schemaVersion: AUDIT_SCHEMA_VERSION,
      theme: themePath,
      date: new Date().toISOString(),
      cliVersion: PACKAGE_VERSION,
      filter,
      count: slice.length,
      actions: AUDIT_ACTIONS,
      findings: slice,
      bucketRules: pick(BUCKET_RULES),
      remediationByLocation: pick(REMEDIATION),
    }, null, 2) + '\n');
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      schemaVersion: AUDIT_SCHEMA_VERSION,
      theme: themePath,
      date: new Date().toISOString(),
      cliVersion: PACKAGE_VERSION,
      actions: AUDIT_ACTIONS,
      doNotTransform: DO_NOT_TRANSFORM,
      queue: buildQueue(result.findings),
      findings: result.findings,
      summary: result.summary,
      suppressed: result.suppressed,
      analyticsMarkers: result.analyticsMarkers,
      appSurfaces: result.appSurfaces,
      skillFreshness: result.skillFreshness,
      bucketRules: BUCKET_RULES,
      remediationByLocation: REMEDIATION,
      whitelistsActive: useWhitelists,
      whitelists: {
        files: { description: WHITELISTS.files.description, items: WHITELISTS.files.items },
        H: { description: WHITELISTS.H.description, patterns: WHITELISTS.H.patterns.map((p) => ({ rule: p.rule.source, why: p.why })) },
        E: { description: WHITELISTS.E.description },
        F: { description: WHITELISTS.F.description },
        G: { description: WHITELISTS.G.description },
      },
    }, null, 2) + '\n');
    return;
  }

  process.stdout.write(printAuditText(themePath, result));

  if (full) {
    process.stdout.write(`\n\n---\n\n# Appendix: PATTERNS.md\n\n`);
    process.stdout.write(readSkillFileOrWarn(PATTERNS_MD_PATH, 'PATTERNS.md'));
  }
}

// ─── skill command ───────────────────────────────────────────────────────────

// Map CLI flag → canonical agent name. Each flag is a one-shot install switch.
const AGENT_FLAGS = {
  '--claude': 'claude-code',
  '--claude-code': 'claude-code',
  '--cursor': 'cursor',
  '--aider': 'aider',
};

// Scan known install paths for an installed Pusha skill and report whether
// each is current vs the running CLI's package version. Stateless — reads a
// marker comment (`<!-- @pusha-skill-version: X.Y.Z -->`) that the install
// step injected into every file it wrote. Returns the entries that exist.
function getSkillFreshness(themePath) {
  const candidates = [];
  for (const base of [themePath, homedir()]) {
    const scope = base === themePath ? 'project' : 'global';
    candidates.push(
      { agent: 'claude', scope, path: join(base, '.claude', 'skills', 'pusha', 'SKILL.md') },
      { agent: 'cursor', scope, path: join(base, '.cursor', 'rules', 'pusha.md') },
      { agent: 'aider', scope, path: join(base, '.aider-conventions.md') },
    );
  }
  const out = [];
  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    let installedVersion = null;
    try {
      const head = readFileSync(c.path, 'utf8').slice(0, 4096);
      const m = head.match(VERSION_MARKER_RE);
      installedVersion = m ? m[1] : null;
    } catch {
      continue;
    }
    out.push({
      agent: c.agent,
      scope: c.scope,
      path: c.path,
      installedVersion,
      current: installedVersion === PACKAGE_VERSION,
    });
  }
  return out;
}

function readSkillFileOrWarn(path, label) {
  if (!existsSync(path)) {
    return `<!-- ${label} not found at ${path}. The skill files weren't shipped with this install — try a newer @mimeticthemes/pusha, or read them on GitHub: https://github.com/mimetic-themes/pusha/tree/main/skill -->\n`;
  }
  return readFileSync(path, 'utf8');
}

function loadSkillBundle() {
  const skill = readSkillFileOrWarn(SKILL_MD_PATH, 'SKILL.md');
  const patterns = readSkillFileOrWarn(PATTERNS_MD_PATH, 'PATTERNS.md');
  return `${versionMarker()}\n${skill}\n\n---\n\n# PATTERNS.md\n\n${patterns}`;
}

// Read a skill source file and prepend the version marker. Used for the
// Claude Code (directory) install where each file is written separately and
// needs its own marker so the audit's freshness check can read it.
function readSkillFileWithMarker(path, label) {
  const content = readSkillFileOrWarn(path, label);
  return `${versionMarker()}\n${content}`;
}

function targetForAgent(agent, { isGlobal }) {
  const base = isGlobal ? homedir() : process.cwd();
  switch (agent) {
    case 'claude-code':
      return {
        kind: 'directory',
        dir: join(base, '.claude', 'skills', 'pusha'),
        entries: [
          { dest: 'SKILL.md', src: SKILL_MD_PATH },
          { dest: 'PATTERNS.md', src: PATTERNS_MD_PATH },
        ],
      };
    case 'cursor':
      return {
        kind: 'single',
        path: join(base, '.cursor', 'rules', 'pusha.md'),
        content: loadSkillBundle(),
      };
    case 'aider':
      return {
        kind: 'single',
        path: join(base, '.aider-conventions.md'),
        content: loadSkillBundle(),
        appendIfExists: true,
      };
    default:
      return null;
  }
}

async function writeIfNeeded(destAbs, content, { force }) {
  if (existsSync(destAbs)) {
    const existing = readFileSync(destAbs, 'utf8');
    if (existing === content) {
      log.same(`${destAbs} (already up to date)`);
      return false;
    }
    if (!force) {
      const ok = await ask(`  ${destAbs} exists with different content. Overwrite?`);
      if (!ok) {
        log.warn(`skipped ${destAbs}`);
        return false;
      }
    }
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, content);
  log.add(destAbs);
  return true;
}

async function appendOrCreate(destAbs, content, { force, separator }) {
  if (existsSync(destAbs)) {
    const existing = readFileSync(destAbs, 'utf8');
    if (existing.includes('<!-- pusha skill — start -->')) {
      log.same(`${destAbs} (pusha section already present)`);
      if (!force) return false;
    }
    if (!force) {
      const ok = await ask(`  ${destAbs} exists. Append the Pusha skill block?`, { defaultYes: true });
      if (!ok) {
        log.warn(`skipped ${destAbs}`);
        return false;
      }
    }
    const wrapped = `${existing.endsWith('\n') ? existing : existing + '\n'}\n${separator}\n${content}\n`;
    writeFileSync(destAbs, wrapped);
    log.add(`${destAbs} (appended)`);
    return true;
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, `${separator}\n${content}\n`);
  log.add(destAbs);
  return true;
}

async function installSkillFor(agent, { isGlobal, force }) {
  const target = targetForAgent(agent, { isGlobal });
  if (!target) {
    log.err(`No install target known for agent: ${agent}`);
    return;
  }
  if (target.kind === 'directory') {
    for (const entry of target.entries) {
      const content = readSkillFileWithMarker(entry.src, entry.dest);
      await writeIfNeeded(join(target.dir, entry.dest), content, { force });
    }
    log.ok(`installed for ${agent} at ${target.dir}`);
    return;
  }
  if (target.kind === 'single') {
    if (target.appendIfExists) {
      const separator = '\n<!-- pusha skill — start -->\n';
      const footer = '\n<!-- pusha skill — end -->\n';
      await appendOrCreate(target.path, target.content + footer, { force, separator });
    } else {
      await writeIfNeeded(target.path, target.content, { force });
    }
    log.ok(`installed for ${agent} at ${target.path}`);
  }
}

async function runSkill(args) {
  if (args.includes('--print')) {
    process.stdout.write(loadSkillBundle());
    return;
  }

  const agents = [];
  const seen = new Set();
  for (const arg of args) {
    const agent = AGENT_FLAGS[arg];
    if (agent && !seen.has(agent)) {
      agents.push(agent);
      seen.add(agent);
    }
  }

  if (agents.length === 0) {
    console.log(`pusha skill — print or install the pusha agent skill.

Examples:
  pusha skill --print              # dump SKILL.md + PATTERNS.md to stdout
  pusha skill --claude             # → .claude/skills/pusha/{SKILL.md,PATTERNS.md}
  pusha skill --cursor             # → .cursor/rules/pusha.md
  pusha skill --aider              # → .aider-conventions.md (appended)
  pusha skill --claude --cursor    # multiple agents in one shot
  pusha skill --claude --global    # install into ~/ instead of project-local

Modifiers:
  --global   write to ~/ instead of $PWD
  --force    overwrite existing files without prompting
`);
    return;
  }

  const isGlobal = args.includes('--global');
  const force = args.includes('--force');
  for (const agent of agents) {
    await installSkillFor(agent, { isGlobal, force });
  }
}

// Concise freshness footer for `pusha --help` — only shown when at least one
// installed skill is detected at the standard paths. Help should be clean for
// first-time users; the freshness nag belongs in `pusha audit`.
function printHelpFreshness() {
  const freshness = getSkillFreshness(process.cwd());
  if (freshness.length === 0) return;
  console.log(`Installed skills (project-local):`);
  for (const s of freshness) {
    const scope = s.scope === 'global' ? ' [global]' : '';
    const v = s.installedVersion ?? '(no version marker)';
    if (s.current) {
      console.log(`  ✓ ${s.agent}${scope} — ${v}`);
    } else {
      console.log(`  ! ${s.agent}${scope} — ${v} (run \`pusha skill --${s.agent}${s.scope === 'global' ? ' --global' : ''}\` to refresh)`);
    }
  }
}

// ─── dispatch ───────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'init':
    await runInit(rest);
    break;
  case 'audit':
    await runAudit(rest);
    break;
  case 'skill':
    await runSkill(rest);
    break;
  case '--version':
  case '-V':
    console.log(`@mimeticthemes/pusha ${PACKAGE_VERSION}`);
    break;
  case undefined:
  case '--help':
  case '-h':
  case 'help':
    console.log(HELP);
    printHelpFreshness();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error(HELP);
    process.exit(1);
}
