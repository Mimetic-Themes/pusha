// Golden-snapshot tests for the deterministic audit CLI. Each fixture theme
// under test/fixtures/ is audited and its report compared byte-for-byte against
// a committed golden file, so any change to bucket logic that shifts a theme's
// output must be reviewed as a deliberate golden update rather than slipping
// through unnoticed.
//
// Fixtures deliberately span paradigms:
//   - os2-sections: classic OS 2.0 (JSON templates + sections)
//   - new-liquid:   blocks + .liquid templates + factory custom elements
//   - analytics-surface: every bucket-J defect (coverage, conformance,
//     placement, raw pixels) against one well-formed marker as the control
//   - island-candidates: every bucket-R marker defect (no data-section-id, a
//     marker in the shell, a snippet whose render sites pass no `section:`)
//     against one correctly-wired snippet island as the control, plus
//     candidates in a section and a theme block
// Together they exercise every bucket (A–P) plus the comment/doc-stripping and
// factory-classification edge cases from the block-based-coverage work.
//
// Regenerate goldens after an intentional audit change:
//   UPDATE_GOLDEN=1 npm test
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'pusha.js');
const fixturesDir = join(here, 'fixtures');
const goldenDir = join(here, 'golden');

// Drop machine- and run-specific lines so the golden is stable across machines
// and time: replace the absolute fixture path with a placeholder and strip the
// timestamp line.
function normalize(output: string, fixturePath: string): string {
  return output
    .split(fixturePath)
    .join('<FIXTURE>')
    .split('\n')
    .filter((line) => !line.startsWith('date:'))
    .join('\n');
}

const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

assert.ok(fixtures.length > 0, 'no audit fixtures found under test/fixtures/');

for (const name of fixtures) {
  test(`audit golden: ${name}`, () => {
    const fixturePath = join(fixturesDir, name);
    // Audit exits 0; capture stdout directly.
    const raw = execFileSync('node', [cli, 'audit', fixturePath], { encoding: 'utf8' });
    const actual = normalize(raw, fixturePath);
    const goldenPath = join(goldenDir, `${name}.txt`);

    if (process.env.UPDATE_GOLDEN) {
      if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true });
      writeFileSync(goldenPath, actual);
      return;
    }

    assert.ok(
      existsSync(goldenPath),
      `missing golden for "${name}" — run: UPDATE_GOLDEN=1 npm test`,
    );
    const expected = readFileSync(goldenPath, 'utf8');
    assert.equal(
      actual,
      expected,
      `audit output for "${name}" drifted from its golden. Review the diff; if intended, run: UPDATE_GOLDEN=1 npm test`,
    );
  });
}

// ─── Bucket J (analytics surface) ───────────────────────────────────────────
// The golden pins the exact report text; these pin the classification itself,
// so a regression fails with a readable message instead of a byte diff.

function auditJson(fixture: string) {
  const raw = execFileSync('node', [cli, 'audit', join(fixturesDir, fixture), '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(raw);
}

test('bucket J classifies every analytics-surface defect', () => {
  const { findings, summary, analyticsMarkers } = auditJson('analytics-surface');
  const J = findings.J as Array<{ kind: string; what: string; file: string }>;
  const has = (kind: string, needle: string) =>
    J.some((f) => f.kind === kind && f.what.includes(needle));

  assert.ok(has('coverage', 'search_submitted'), 'uncovered page type not flagged');
  assert.ok(has('placement', 'persistent shell'), 'shell-placed marker not flagged');
  assert.ok(has('conformance', 'missing required data.collection'), 'payload shape drift not flagged');
  assert.ok(has('conformance', 'application/json'), 'type-less marker not flagged');
  assert.ok(has('conformance', 'not parseable JSON'), 'malformed payload not flagged');
  assert.ok(has('conformance', 'double-counts'), 'theme-supplied page_viewed not flagged');
  assert.ok(has('conformance', 'Liquid-computed'), 'computed event name not flagged');
  assert.ok(has('raw-pixel', 'gtag'), 'gtag call not flagged');
  assert.ok(has('raw-pixel', 'fbq'), 'fbq call not flagged');

  // A well-formed marker is an inventory line, not a finding — including the
  // bare `{{ price }}` in number position, which only parses via the Liquid probe.
  assert.ok(
    (analyticsMarkers as Array<{ event: string; location: string }>).some(
      (m) => m.event === 'product_viewed' && m.location === 'section',
    ),
    'well-formed product_viewed missing from the inventory',
  );
  assert.equal(
    J.filter((f) => f.file === 'sections/main-product.liquid').length,
    0,
    'the well-formed marker should produce no findings',
  );

  assert.equal(summary.J, J.length);
  assert.equal(summary.J_gaps + summary.J_warns, J.length);
});

test('bucket J asserts coverage only for page types the theme has', () => {
  const { findings } = auditJson('os2-sections');
  assert.equal(
    findings.J.filter((f: { kind: string }) => f.kind === 'coverage').length,
    0,
    'coverage was asserted for pages this fixture does not have',
  );
});

test('audit --json stays parseable when a theme dir is missing', () => {
  // analytics-surface has no assets/ — the "not found" notice must go to stderr,
  // or every --json consumer chokes on the first line.
  assert.doesNotThrow(() => auditJson('analytics-surface'));
});

// ─── Bucket X (theme app extensions) ────────────────────────────────────────
// The golden pins the exact report text; these pin the classification itself —
// dedupe, encoding, location routing, recursion — so a regression fails with a
// readable message instead of a byte diff. D2: the live 20-app corpus is a
// follow-up, not a merge gate — fixture coverage is the acceptance surface.

function auditText(fixture: string) {
  return execFileSync('node', [cli, 'audit', join(fixturesDir, fixture)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

type XFinding = {
  kind: string;
  appHandle: string;
  blockHandle: string;
  location: string;
  verdict: string;
  placements: Array<{ file: string; address: string; location: string }>;
};

test('bucket X detects both slash encodings for the same app block', () => {
  const { findings } = auditJson('app-blocks-classic');
  const X = findings.X as XFinding[];
  const kiwi = X.find((f) => f.appHandle === 'kiwi-size-chart-recommender' && f.blockHandle === 'kiwiSizing');
  assert.ok(kiwi, 'kiwi finding missing');
  assert.ok(kiwi!.placements.some((p) => p.file === 'templates/product.json'), 'escaped-slash placement missing');
  assert.ok(kiwi!.placements.some((p) => p.file === 'templates/index.json'), 'plain-slash placement missing');
});

test('bucket X dedupes the same (app, block) across templates into one finding', () => {
  const { findings } = auditJson('app-blocks-classic');
  const X = findings.X as XFinding[];
  const kiwiMatches = X.filter((f) => f.appHandle === 'kiwi-size-chart-recommender' && f.blockHandle === 'kiwiSizing');
  assert.equal(kiwiMatches.length, 1, 'kiwi should dedupe to a single finding');
  assert.equal(kiwiMatches[0].placements.length, 2, 'kiwi finding should carry both placements');
});

test('bucket X filters disabled embeds and surfaces the count in the text report', () => {
  const { findings, appSurfaces } = auditJson('app-blocks-classic');
  const X = findings.X as XFinding[];
  assert.ok(
    !X.some((f) => f.appHandle === 'easy-appointment-booking'),
    'disabled easy-appointment-booking embed should not appear in any finding',
  );
  assert.equal((appSurfaces as { disabledEmbeds: number }).disabledEmbeds, 1);
  assert.ok(
    auditText('app-blocks-classic').includes('1 disabled embed not reported.'),
    'the suppressed disabled-embed count must be surfaced in the text report, not silent',
  );
});

test('bucket X routes verdicts by location', () => {
  const { findings } = auditJson('app-blocks-classic');
  const X = findings.X as XFinding[];
  const byHandle = (appHandle: string) => X.find((f) => f.appHandle === appHandle);

  assert.deepEqual(
    [byHandle('commslayer')!.verdict, byHandle('commslayer')!.location],
    ['survives', 'shell'],
  );
  assert.deepEqual(
    [byHandle('zapiet')!.verdict, byHandle('zapiet')!.location],
    ['at-risk', 'section'],
  );
  assert.deepEqual(
    [byHandle('kutoku')!.verdict, byHandle('kutoku')!.location],
    ['survives-verify', 'embed'],
  );
});

test('bucket X recurses through nested theme blocks to find an app block at depth 3', () => {
  const { findings } = auditJson('app-blocks-classic');
  const X = findings.X as XFinding[];
  const judgeMe = X.find((f) => f.appHandle === 'judge-me-reviews' && f.blockHandle === 'review_widget');
  assert.ok(judgeMe, 'judge-me-reviews/review_widget finding missing');
  const address = judgeMe!.placements[0].address;
  assert.equal((address.match(/→ block /g) || []).length, 3, `expected three "→ block " segments, got: ${address}`);
});

test('bucket X reports the Script Tag blind spot on both fixtures, including zero-app', () => {
  const classic = auditJson('app-blocks-classic');
  const horizon = auditJson('app-surface-horizon');
  assert.ok(classic.appSurfaces.scriptTagBlindSpot, 'blind spot missing from app-blocks-classic --json');
  assert.ok(horizon.appSurfaces.scriptTagBlindSpot, 'blind spot missing from app-surface-horizon --json');
  assert.ok(
    auditText('app-surface-horizon').includes('Script Tag API'),
    'the zero-app theme must still report the Script Tag blind spot',
  );
});

test('bucket X-surface maps @app capabilities with zero apps installed', () => {
  const { findings, appSurfaces } = auditJson('app-surface-horizon');
  assert.equal((findings.X as XFinding[]).length, 0);
  const capabilities = appSurfaces.capabilities as Array<{ file: string; location: string }>;
  assert.equal(capabilities.length, 4);
  const byFile = (file: string) => capabilities.find((c) => c.file === file);
  assert.equal(byFile('sections/footer.liquid')?.location, 'shell');
  assert.equal(byFile('sections/main-product.liquid')?.location, 'section');
  assert.equal(byFile('blocks/_card.liquid')?.location, 'block');
  assert.equal(byFile('sections/header.liquid'), undefined, 'header.liquid declares no @app and must be absent');
});

test('bucket X resolves the app wrapper per theme', () => {
  assert.equal(auditJson('app-blocks-classic').appSurfaces.wrapper.kind, 'apps.liquid');
  assert.equal(auditJson('app-surface-horizon').appSurfaces.wrapper.kind, '_blocks.liquid');
});

test('bucket X summary invariants hold', () => {
  const { summary, findings } = auditJson('app-blocks-classic');
  assert.equal(summary.X, findings.X.length);
  assert.equal(summary.X_at_risk + summary.X_survives + summary.X_embeds, summary.X);
  assert.equal(summary.X_at_risk, 3);
  assert.equal(summary.X_survives, 1);
  assert.equal(summary.X_embeds, 2);
});

test('bucket X tallies are distinguishable in the text report (D1)', () => {
  const text = auditText('app-blocks-classic');
  assert.ok(/AT-RISK/.test(text), 'AT-RISK group header missing');
  assert.ok(/SURVIVES, VERIFY/.test(text), 'SURVIVES, VERIFY group header missing');

  const atRiskSection = text.slice(text.indexOf('AT-RISK'), text.indexOf('SURVIVES ('));
  assert.ok(
    !/kilatech-currency-converter|kutoku/.test(atRiskSection),
    'no embed handle should appear on an AT-RISK line',
  );
});

test('bucket J correction landed', () => {
  const { bucketRules } = auditJson('app-blocks-classic');
  assert.ok(!bucketRules.J.includes('cannot currently reach Web Pixels at all'));
  assert.ok(bucketRules.J.includes('PREFIXED CUSTOM events'));
});

// ─── Bucket X — additional edge cases (spec "Edge cases the implementation
// must handle" #1, #7, #8, #11/#12, #14, #15) that neither of the two primary
// fixtures exercises on its own. `app-edge-cases` packs six probes into one
// small theme: no config/ dir at all, a block container written as a JSON
// array instead of an object map, the same (app, block) placed in both a
// section-group file (shell) and a template (section) to force the
// worst-verdict-wins path across locations rather than within one, a
// malformed templates/*.json sibling, an `"@app"` entry that lives only
// inside a schema's `presets` (must be ignored), and an `enabled_on` that
// carries `templates` but no `groups` key (must not throw reading
// `.groups.length`).

test('bucket X walks an array-form blocks container, not just an object map', () => {
  const { findings } = auditJson('app-edge-cases');
  const X = findings.X as XFinding[];
  const widgetco = X.find((f) => f.appHandle === 'widgetco' && f.blockHandle === 'promo');
  assert.ok(widgetco, 'widgetco/promo finding missing — array-form blocks container was not walked');
  assert.ok(
    widgetco!.placements.some((p) => p.file === 'templates/index.json'),
    'the array-container placement (templates/index.json) is missing from the finding',
  );
});

test('bucket X worst-verdict-wins across locations, not just within one', () => {
  const { findings } = auditJson('app-edge-cases');
  const X = findings.X as XFinding[];
  const widgetco = X.find((f) => f.appHandle === 'widgetco' && f.blockHandle === 'promo');
  assert.ok(widgetco, 'widgetco/promo finding missing');
  // One placement is shell-only (sections/shell-group.json), the other is
  // section (templates/index.json) — the same (app, block) pair, so this must
  // dedupe to ONE finding whose verdict is the worst of the two, even though
  // the shell placement is also listed.
  assert.equal(widgetco!.placements.length, 2, 'both placements should be listed on the deduped finding');
  assert.equal(widgetco!.verdict, 'at-risk', 'worst-case verdict (section) must win over the shell placement');
  assert.equal(widgetco!.location, 'section');
  assert.ok(widgetco!.placements.some((p) => p.location === 'shell'), 'the surviving shell placement must still be listed');
  assert.ok(widgetco!.placements.some((p) => p.location === 'section'), 'the at-risk section placement must still be listed');
});

test('bucket X text report visually distinguishes a placement whose own location disagrees with its finding\'s rolled-up location', () => {
  // Round-1 reviewer finding: spec.md edge case #11 requires "both placements
  // listed with their own location tags" when worst-verdict-wins pulls a
  // finding's rolled-up location away from one of its placements — honored in
  // JSON (placement.location) but the text report was printing the shell
  // placement's address bare, indistinguishable from an actually-at-risk line.
  // This proves the BEHAVIOR — a placement that disagrees with its finding's
  // location is visually marked, one that agrees is not — without pinning the
  // exact wording of the marker, so a copy change doesn't false-fail this
  // while an actual regression (the marker vanishing) still goes red.
  const { findings } = auditJson('app-edge-cases');
  const X = findings.X as XFinding[];
  const widgetco = X.find((f) => f.appHandle === 'widgetco' && f.blockHandle === 'promo')!;
  assert.ok(widgetco, 'widgetco/promo finding missing');

  const agreeing = widgetco.placements.find((p) => p.location === widgetco.location);
  const disagreeing = widgetco.placements.find((p) => p.location !== widgetco.location);
  assert.ok(agreeing, 'expected one placement whose location matches the finding\'s rolled-up location (the templates/index.json section placement)');
  assert.ok(disagreeing, 'expected one placement whose location disagrees with the finding\'s rolled-up location (the worst-wins shell placement)');

  const text = auditText('app-edge-cases');
  const lines = text.split('\n');
  const agreeingLine = lines.find((l) => l.includes(agreeing!.address));
  const disagreeingLine = lines.find((l) => l.includes(disagreeing!.address));
  assert.ok(agreeingLine, 'agreeing placement address not found in the text report');
  assert.ok(disagreeingLine, 'disagreeing placement address not found in the text report');

  // Compare structurally: whatever trails the bare address on each line.
  const trailing = (line: string, address: string) => line.slice(line.indexOf(address) + address.length).trim();
  const agreeingTrail = trailing(agreeingLine!, agreeing!.address);
  const disagreeingTrail = trailing(disagreeingLine!, disagreeing!.address);

  assert.equal(agreeingTrail, '', 'a placement whose location matches its finding\'s rolled-up location should print no extra annotation');
  assert.notEqual(
    disagreeingTrail,
    '',
    'a placement whose location disagrees with its finding\'s rolled-up location must carry a distinguishing annotation in the text report — this is the exact regression round 1 caught',
  );
  // The annotation should name the placement's OWN location (here: "shell"),
  // not the finding's rolled-up location ("section") — that's what makes it
  // informative rather than decorative.
  assert.ok(
    disagreeingTrail.includes(disagreeing!.location),
    `the distinguishing annotation should name the placement's actual location ("${disagreeing!.location}"), got: "${disagreeingTrail}"`,
  );
  assert.ok(!agreeingTrail.includes(disagreeing!.location) && agreeingLine !== disagreeingLine, 'the two placement lines must be distinct');
});

test('bucket X handles a missing config/settings_data.json without crashing', () => {
  const { appSurfaces, findings } = auditJson('app-edge-cases');
  assert.equal((appSurfaces as { disabledEmbeds: number }).disabledEmbeds, 0);
  assert.ok(!(findings.X as XFinding[]).some((f) => f.kind === 'app-embed'), 'no embed findings should exist when settings_data.json is absent');
});

test('bucket X skips a malformed templates/*.json file silently instead of throwing', () => {
  // The fixture ships templates/broken.json — text that is not valid JSON, with
  // no /* */ header for parseThemeJson to strip either. auditJson() itself
  // proves no exception propagated (execFileSync would throw on a non-zero
  // exit); this also asserts the malformed file contributed no finding.
  const { findings } = auditJson('app-edge-cases');
  const X = findings.X as XFinding[];
  assert.ok(!X.some((f) => f.placements.some((p) => p.file === 'templates/broken.json')));
});

test('bucket X ignores "@app" declared only inside a schema\'s presets, not blocks', () => {
  const { appSurfaces } = auditJson('app-edge-cases');
  const capabilities = appSurfaces.capabilities as Array<{ file: string }>;
  assert.ok(
    !capabilities.some((c) => c.file === 'sections/presets-only.liquid'),
    'a preset-only "@app" must not produce a capability entry',
  );
});

test('bucket X skips a section with no {% schema %} tag without crashing', () => {
  const { appSurfaces } = auditJson('app-edge-cases');
  const capabilities = appSurfaces.capabilities as Array<{ file: string }>;
  assert.ok(!capabilities.some((c) => c.file === 'sections/no-schema.liquid'));
});

test('bucket X ignores a shopify://apps/ string that is not a block\'s "type" field (parse-based, not text-matched)', () => {
  // templates/index.json also carries a "decoy_text" block of type "text"
  // whose settings.description CONTAINS the literal string
  // "shopify://apps/decoy-app/blocks/decoy/should-be-ignored". A text-matching
  // ("grep the file for shopify://apps/") implementation would false-positive
  // on this; a correct implementation only ever reads a block node's `type`
  // key, so decoy-app must never appear anywhere in the findings.
  const { findings } = auditJson('app-edge-cases');
  const X = findings.X as XFinding[];
  assert.ok(!X.some((f) => f.appHandle === 'decoy-app'), 'a shopify://apps/ string embedded in a non-type field must not produce a finding');
  assert.equal(X.length, 1, 'only the genuine widgetco/promo finding should exist');
});

test('bucket X guards enabled_on.templates-only (no groups key) before reading .groups.length', () => {
  // sections/only-templates-key.liquid declares enabled_on: { templates: [...] }
  // with no `groups` key. Reading `.groups.length` unguarded would throw; the
  // correct behavior is to fall through to the next priority rule
  // (shellRelSet, then disabled_on, then locationClass) and land on 'section'.
  const { appSurfaces } = auditJson('app-edge-cases');
  const capabilities = appSurfaces.capabilities as Array<{ file: string; location: string }>;
  const entry = capabilities.find((c) => c.file === 'sections/only-templates-key.liquid');
  assert.ok(entry, 'enabled_on with only a templates key must not crash the scan and must still be found');
  assert.equal(entry!.location, 'section');
});
