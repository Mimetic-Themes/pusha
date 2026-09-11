// The audit's consumer is a coding agent, not a person reading a report. These
// tests pin the contract that makes that work: a stable id, an action telling
// the agent whether to act or escalate, an ordered queue, and filters that cut
// the payload to one worker's slice.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'pusha.js');
const fixturesDir = join(here, 'fixtures');

const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

function audit(path: string, ...flags: string[]): any {
  return JSON.parse(execFileSync('node', [cli, 'audit', path, '--json', ...flags], { encoding: 'utf8' }));
}

const ACTIONS = ['transform', 'decide', 'verify', 'none'];

test('every finding carries an id and a known action', () => {
  for (const name of fixtures) {
    const j = audit(join(fixturesDir, name));
    assert.equal(j.schemaVersion, 1, `${name}: schemaVersion`);
    for (const [bucket, list] of Object.entries<any[]>(j.findings)) {
      for (const f of list) {
        assert.match(f.id ?? '', /^[0-9a-f]{12}(-\d+)?$/, `${name} ${bucket}: id shape`);
        assert.ok(ACTIONS.includes(f.action), `${name} ${bucket}: action "${f.action}"`);
      }
    }
  }
});

test('ids are unique, and survive the edits an agent makes', () => {
  const fixture = join(fixturesDir, 'os2-sections');
  const before = audit(fixture);
  const ids = Object.values<any[]>(before.findings).flat().map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique within a run');

  // Copy the fixture and push every line down. Line numbers all change; nothing
  // else does. An agent mid-port does exactly this on its first edit.
  const tmp = mkdtempSync(join(tmpdir(), 'pusha-shift-'));
  const copy = join(tmp, 'theme');
  cpSync(fixture, copy, { recursive: true });
  const layout = join(copy, 'layout', 'theme.liquid');
  writeFileSync(layout, '{% comment %}shifted{% endcomment %}\n' + readFileSync(layout, 'utf8'));

  const after = audit(copy);
  const idsIn = (j: any, file: string) =>
    Object.values<any[]>(j.findings).flat().filter((f) => f.file === file).map((f) => f.id).sort();

  const beforeLayout = idsIn(before, 'layout/theme.liquid');
  assert.ok(beforeLayout.length > 0, 'fixture has layout findings to compare');
  assert.deepEqual(idsIn(after, 'layout/theme.liquid'), beforeLayout, 'ids unchanged by a line shift');
});

test('the queue is ordered work only — never an action:none finding', () => {
  for (const name of fixtures) {
    const j = audit(join(fixturesDir, name));
    const byId = new Map<string, any>(
      Object.entries<any[]>(j.findings).flatMap(([bucket, l]) => l.map((f) => [f.id, { bucket, ...f }])),
    );
    assert.equal(new Set(j.queue).size, j.queue.length, `${name}: no duplicate queue entries`);
    let sawNonTransform = false;
    for (const id of j.queue) {
      const f = byId.get(id);
      assert.ok(f, `${name}: queue id ${id} resolves to a finding`);
      assert.notEqual(f.action, 'none', `${name}: ${f.bucket} action:none must not be queued`);
      if (f.action !== 'transform') sawNonTransform = true;
      else assert.equal(sawNonTransform, false, `${name}: transform work comes first`);
    }
  }
});

test('buckets an agent must not rewrite are never marked transform', () => {
  for (const name of fixtures) {
    const j = audit(join(fixturesDir, name));
    for (const bucket of Object.keys(j.doNotTransform)) {
      for (const f of j.findings[bucket] ?? []) {
        assert.notEqual(f.action, 'transform', `${name}: ${bucket} must never be transform`);
      }
    }
  }
});

test('inert head config and custom-element {% javascript %} are not work', () => {
  for (const name of fixtures) {
    const j = audit(join(fixturesDir, name));
    for (const f of [...(j.findings.E ?? []), ...(j.findings.G ?? []), ...(j.findings.F ?? [])]) {
      if (f.location === 'head-config') assert.equal(f.action, 'none', `${name}: head-config is inert`);
      if (f.kind === 'F1') assert.equal(f.action, 'none', `${name}: F1 already defines a custom element`);
    }
    // L's own ranking drives its action, so the 116-finding headline collapses
    // into the part an agent can actually act on.
    for (const f of j.findings.L ?? []) {
      const expected = f.rank === 'auto' ? 'transform' : f.rank === 'ask' ? 'decide' : 'none';
      assert.equal(f.action, expected, `${name}: L rank ${f.rank}`);
    }
  }
});

test('filters cut the payload to one slice and keep the matching rules', () => {
  const fixture = join(fixturesDir, 'os2-sections');
  const full = audit(fixture);
  const sliced = audit(fixture, '--action', 'transform');

  assert.ok(Array.isArray(sliced.findings), 'a filtered response is a flat array');
  assert.equal(sliced.count, sliced.findings.length);
  for (const f of sliced.findings) assert.equal(f.action, 'transform');

  const expected = Object.values<any[]>(full.findings).flat().filter((f) => f.action === 'transform').length;
  assert.equal(sliced.count, expected, 'same set as filtering the full payload by hand');

  // The preamble a worker does not need is gone; the rules for what it got stay.
  for (const key of ['whitelists', 'appSurfaces', 'analyticsMarkers', 'skillFreshness', 'summary']) {
    assert.equal(key in sliced, false, `filtered payload drops ${key}`);
  }
  for (const bucket of new Set<string>(sliced.findings.map((f: any) => String(f.bucket)))) {
    assert.ok(bucket in sliced.bucketRules, `keeps the rule for bucket ${bucket}`);
  }
  assert.equal('--bucket' in sliced, false);
  assert.deepEqual(sliced.filter.actions, ['transform']);
});

test('--bucket and --file narrow further, and combine', () => {
  const fixture = join(fixturesDir, 'os2-sections');
  const all = audit(fixture);
  const inSections = audit(fixture, '--file', 'sections/');
  assert.ok(inSections.count > 0, 'fixture has findings under sections/');
  for (const f of inSections.findings) {
    const touches = String(f.file ?? f.definedIn ?? '').includes('sections/')
      || (f.sites ?? []).some((s: any) => String(s.file ?? '').includes('sections/'));
    assert.ok(touches, `${f.bucket} ${f.id} actually lives under sections/`);
  }
  assert.ok(inSections.count < Object.values<any[]>(all.findings).flat().length, 'narrower than everything');

  const buckets = audit(fixture, '--bucket', 'E,G');
  for (const f of buckets.findings) assert.ok(['E', 'G'].includes(f.bucket));
});

test('filters refuse to run against the text report rather than lie about counts', () => {
  const fixture = join(fixturesDir, 'os2-sections');
  assert.throws(
    () => execFileSync('node', [cli, 'audit', fixture, '--action', 'transform'], { encoding: 'utf8', stdio: 'pipe' }),
    (err: any) => err.status === 1 && /only apply to --json/.test(String(err.stderr)),
  );
  assert.throws(
    () => execFileSync('node', [cli, 'audit', fixture, '--json', '--action', 'nope'], { encoding: 'utf8', stdio: 'pipe' }),
    (err: any) => err.status === 1 && /unknown --action/.test(String(err.stderr)),
  );
});

test('audit --help explains the contract without needing a theme', () => {
  const out = execFileSync('node', [cli, 'audit', '--help'], { encoding: 'utf8', cwd: tmpdir() });
  for (const needle of ['transform', 'decide', 'verify', 'none', 'queue', '--bucket', '--action', '--file']) {
    assert.match(out, new RegExp(needle.replace(/[-[\]{}()*+?.\\^$|]/g, '\\$&')), `help documents ${needle}`);
  }
});

test('a finished port has an empty transform queue', () => {
  // The tool's own success criterion. Before the E/F whitelists, a correctly
  // ported section re-audited as F2 forever, so "done" was unreachable and the
  // skill's validation step told agents to keep wrapping.
  const j = audit(join(fixturesDir, 'ported-theme'));
  const work = Object.values<any[]>(j.findings).flat().filter((f) => f.action === 'transform');
  assert.deepEqual(
    work.map((f) => `${f.bucket} ${f.file ?? f.definedIn}`),
    [],
    'a ported theme must present no mechanical work',
  );

  // And the suppression is visible, not silent.
  assert.ok(j.suppressed.F.length >= 2, 'ported {% javascript %} bodies are listed as suppressed');
  assert.ok(j.suppressed.E.length >= 1, 'the Pusha-aware bridge snippet is listed as suppressed');

  // Portal sites already marked are done, not pending.
  for (const f of j.findings.K ?? []) assert.equal(f.action, 'none');
});

test('the ported-shape whitelist is strict — stray procedural code still reports', () => {
  // A body that registers AND does work on parse is not ported. Suppressing it
  // would hide a real finding, which is the failure mode whitelists invite.
  const tmp = mkdtempSync(join(tmpdir(), 'pusha-strict-'));
  const theme = join(tmp, 'theme');
  cpSync(join(fixturesDir, 'ported-theme'), theme, { recursive: true });
  const hero = join(theme, 'sections', 'hero.liquid');
  writeFileSync(
    hero,
    readFileSync(hero, 'utf8').replace(
      '{% javascript %}',
      "{% javascript %}\n  document.querySelector('.hero').classList.add('legacy');",
    ),
  );

  const j = audit(theme);
  const f2 = Object.values<any[]>(j.findings).flat().filter((f) => f.kind === 'F2');
  assert.equal(f2.length, 1, 'the tampered body is reported again');
  assert.equal(f2[0].file, 'sections/hero.liquid');
  assert.equal(f2[0].action, 'transform');
});

test('--no-whitelist surfaces everything the whitelists hid', () => {
  const clean = audit(join(fixturesDir, 'ported-theme'));
  const raw = audit(join(fixturesDir, 'ported-theme'), '--no-whitelist');
  const count = (j: any) => Object.values<any[]>(j.findings).flat().length;
  assert.ok(count(raw) > count(clean), 'raw run shows more');
  assert.equal(raw.suppressed.E.length + raw.suppressed.F.length, 0, 'nothing suppressed when off');
});

// ─── shell scope ────────────────────────────────────────────────────────────
// Which files persist across a swap decides which fix applies, so getting it
// wrong routes a shell script into sectionInits — a registry that is never
// walked outside the container, so the script simply never runs.

function scratchTheme(files: Record<string, string>): string {
  const root = join(mkdtempSync(join(tmpdir(), 'pusha-shell-')), 'theme');
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const CONTAINER = '<main id="MainContent" data-page-container data-page-type="{{ template }}">';

test('a section rendered from the layout is shell, not section scope', () => {
  // `{% section %}` was never followed, so a theme using the bare form had its
  // header classified as `section` and the audit told an agent to wrap it.
  const theme = scratchTheme({
    'layout/theme.liquid': `<body>{% section 'header' %}\n${CONTAINER}{{ content_for_layout }}</main></body>`,
    'sections/header.liquid': `<header>{% render 'menu' %}</header>`,
    'snippets/menu.liquid': `<nav></nav>\n<script>document.querySelector('nav').hidden = true;</script>`,
    'sections/hero.liquid': `<div data-section-type="hero"></div>\n<script>init();</script>`,
  });
  const j = audit(theme);
  const at = (f: string) => Object.values<any[]>(j.findings).flat().find((x) => x.file === f);
  assert.equal(at('snippets/menu.liquid')?.location, 'shell', 'reached through a layout-rendered section');
  assert.equal(at('sections/hero.liquid')?.location, 'section', 'an ordinary section is still section scope');
});

test('a snippet rendered inside the container is not shell', () => {
  // Themes place snippets inside deliberately — an identity block has to arrive
  // with the swapped content to describe the page navigated to.
  const theme = scratchTheme({
    'layout/theme.liquid':
      `<body>{% render 'header-bar' %}\n${CONTAINER}{% render 'per-page' %}{{ content_for_layout }}</main></body>`,
    'snippets/header-bar.liquid': `<div></div>\n<script>shell();</script>`,
    'snippets/per-page.liquid': `<div></div>\n<script>perPage();</script>`,
  });
  const j = audit(theme);
  const at = (f: string) => Object.values<any[]>(j.findings).flat().find((x) => x.file === f);
  assert.equal(at('snippets/header-bar.liquid')?.location, 'shell', 'outside the container');
  assert.notEqual(at('snippets/per-page.liquid')?.location, 'shell', 'inside the container is swapped');
});

test('every layout is a shell, not just theme.liquid', () => {
  const theme = scratchTheme({
    'layout/theme.liquid': `<body>${CONTAINER}{{ content_for_layout }}</main></body>`,
    'layout/password.liquid': `<body>{% render 'password-footer' %}${CONTAINER}{{ content_for_layout }}</main></body>`,
    'snippets/password-footer.liquid': `<footer></footer>\n<script>pw();</script>`,
  });
  const j = audit(theme);
  const found = Object.values<any[]>(j.findings).flat().find((x) => x.file === 'snippets/password-footer.liquid');
  assert.equal(found?.location, 'shell', 'password.liquid has a persistent shell too');
});

test('a section group rendered inside the container is not shell', () => {
  const theme = scratchTheme({
    'layout/theme.liquid': `<body>${CONTAINER}{% sections 'main-group' %}{{ content_for_layout }}</main></body>`,
    'sections/main-group.json': JSON.stringify({ sections: { m: { type: 'promo' } }, order: ['m'] }),
    'sections/promo.liquid': `<div data-section-type="promo"></div>\n<script>promo();</script>`,
  });
  const j = audit(theme);
  const found = Object.values<any[]>(j.findings).flat().find((x) => x.file === 'sections/promo.liquid');
  assert.notEqual(found?.location, 'shell', 'a group inside the container is swapped like any page content');
});

// ─── manifest ───────────────────────────────────────────────────────────────
// Stable ids only pay off if something reads the record of what was judged.

test('a manifest settles findings and drops them from the queue', () => {
  const theme = join(mkdtempSync(join(tmpdir(), 'pusha-manifest-')), 'theme');
  cpSync(join(fixturesDir, 'os2-sections'), theme, { recursive: true });

  const before = audit(theme);
  assert.equal(before.manifest.present, false);
  const settling: string[] = before.queue.slice(0, 2);
  assert.ok(settling.length === 2, 'fixture has work to settle');

  mkdirSync(join(theme, '.pusha'), { recursive: true });
  writeFileSync(
    join(theme, '.pusha', 'MANIFEST.md'),
    ['# Port manifest', '', ...settling.map((id) => `- \`${id}\` transformed — done`), ''].join('\n'),
  );

  const after = audit(theme);
  assert.equal(after.manifest.present, true);
  assert.equal(after.manifest.recorded, 2);
  assert.equal(after.manifest.settled, 2);
  assert.equal(after.queue.length, before.queue.length - 2);
  for (const id of settling) assert.equal(after.queue.includes(id as string), false, `${id} left the queue`);

  // Settled work keeps its classification but is never handed to a worker.
  const byId = new Map<string, any>(Object.values<any[]>(after.findings).flat().map((f) => [f.id, f]));
  for (const id of settling) assert.equal(byId.get(id)?.settled, 'transformed');
  const sliced = audit(theme, '--action', 'transform');
  for (const id of settling) assert.equal(sliced.findings.some((f: any) => f.id === id), false);

  // And it stays auditable.
  const raw = audit(theme, '--ignore-manifest');
  assert.equal(raw.manifest.honored, false);
  assert.equal(raw.queue.length, before.queue.length);
});

test('the manifest accepts any line carrying an id and an outcome', () => {
  const theme = join(mkdtempSync(join(tmpdir(), 'pusha-manifest2-')), 'theme');
  cpSync(join(fixturesDir, 'os2-sections'), theme, { recursive: true });
  const [a, b, c] = audit(theme).queue as string[];

  mkdirSync(join(theme, '.pusha'), { recursive: true });
  writeFileSync(
    join(theme, '.pusha', 'MANIFEST.md'),
    [
      '| id | outcome |',
      `| ${a} | transformed |`,
      `* ${b} — skipped: Liquid tokens inside the javascript tag`,
      `${c} deferred (asked the merchant, awaiting answer)`,
      'a line with no id at all',
      '- `deadbeefcafe` transformed — an id from another theme',
    ].join('\n'),
  );

  const j = audit(theme);
  assert.equal(j.manifest.recorded, 4, 'four ids parsed, including the unmatched one');
  assert.equal(j.manifest.settled, 3, 'three matched findings in this theme');
  for (const id of [a, b, c]) assert.equal(j.queue.includes(id), false);
});

// ─── whitelists that verify rather than assume ──────────────────────────────

test('a port with the right shape but the wrong wiring is reported, not suppressed', () => {
  // The failure a whitelist invites: markup that reads as finished and is
  // silently dead. Worse than an untouched file.
  const theme = join(mkdtempSync(join(tmpdir(), 'pusha-suspect-')), 'theme');
  cpSync(join(fixturesDir, 'ported-theme'), theme, { recursive: true });
  const hero = join(theme, 'sections', 'hero.liquid');
  writeFileSync(hero, readFileSync(hero, 'utf8').replace("sectionInits['hero']", "sectionInits['heroo']"));

  const j = audit(theme);
  const found = Object.values<any[]>(j.findings).flat().find((f) => f.file === 'sections/hero.liquid');
  assert.ok(found, 'not suppressed');
  assert.ok(Array.isArray(found.suspect) && found.suspect.length, 'carries the inconsistency');
  assert.match(found.suspect.join(' '), /can never fire/);
  assert.equal(found.action, 'decide', 're-running the wrapper would not fix this');
  assert.ok(j.queue.includes(found.id), 'and it is queued');
  assert.equal(j.suppressed.F.some((x: any) => x.file === 'sections/hero.liquid'), false);
});

test('sectionDestroy without a matching sectionInits is caught', () => {
  const theme = join(mkdtempSync(join(tmpdir(), 'pusha-destroy-')), 'theme');
  cpSync(join(fixturesDir, 'ported-theme'), theme, { recursive: true });
  const ticker = join(theme, 'sections', 'ticker.liquid');
  writeFileSync(ticker, readFileSync(ticker, 'utf8').replace("sectionDestroy['ticker']", "sectionDestroy['tickr']"));

  const j = audit(theme);
  const found = Object.values<any[]>(j.findings).flat().find((f) => f.file === 'sections/ticker.liquid');
  assert.match(found?.suspect?.join(' ') ?? '', /sectionDestroy\['tickr'\] has no matching sectionInits/);
});

test('the H bridge whitelist is narrow — only the IIFE, only shell, only Pusha-aware', () => {
  const clean = audit(join(fixturesDir, 'ported-theme'));
  assert.equal(clean.queue.length, 0, 'a finished port presents no work at all');
  assert.ok(
    clean.suppressed.H.some((x: any) => /bridge shape/.test(x.reason)),
    'the bridge IIFE is suppressed, and listed',
  );

  // A top-level mutation in the same file is a different shape and still reports.
  const theme = join(mkdtempSync(join(tmpdir(), 'pusha-h-')), 'theme');
  cpSync(join(fixturesDir, 'ported-theme'), theme, { recursive: true });
  const snippet = join(theme, 'snippets', 'header-search.liquid');
  writeFileSync(snippet, readFileSync(snippet, 'utf8').replace('<script>', '<script>\nwindow.myThemeState = { open: false };'));

  const j = audit(theme);
  assert.ok(
    (j.findings.H ?? []).some((f: any) => /top-level window\/document mutation/.test(f.reason)),
    'a real module-state finding in a Pusha-aware shell file still reports',
  );
  assert.equal(
    j.suppressed.H.some((x: any) => /bridge shape/.test(x.reason)),
    false,
    'and the bridge whitelist declines to fire for that file',
  );
});
