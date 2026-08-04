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
