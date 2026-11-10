import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchFindings, matchesExpected } from '../dist/domain/eval/matcher.js';
import {
  formatEvalSummary,
  loadEvalFixtures,
  runEvalSuite
} from '../dist/application/eval.js';

function finding(overrides = {}) {
  return {
    fingerprint: 'f_aaaaaaaa',
    severity: 'high',
    category: 'security',
    claim: 'The project lookup does not filter by owner',
    sources: [],
    contested: false,
    rejectedBy: [],
    ...overrides
  };
}

function expectation(overrides = {}) {
  return { claimIncludes: 'does not filter by owner', ...overrides };
}

function makeTemp() {
  return mkdtempSync(join(tmpdir(), 'consilium-eval-'));
}

function cleanup(directory) {
  rmSync(directory, { recursive: true, force: true });
}

function writeFixture(root, name, expected, options = {}) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'task.md'), options.task ?? `Review ${name}\n`, 'utf8');
  if (options.diff !== undefined) {
    writeFileSync(join(directory, 'changes.diff'), options.diff, 'utf8');
  }
  writeFileSync(
    join(directory, 'expected.json'),
    `${JSON.stringify(expected, null, 2)}\n`,
    'utf8'
  );
  return directory;
}

function sampleFixtures(root) {
  writeFixture(
    root,
    '01-caught',
    {
      mustFind: [
        {
          claimIncludes: 'sql injection',
          file: 'src/db/search.ts',
          category: 'security',
          minSeverity: 'high'
        }
      ],
      mustNotFind: [{ claimIncludes: 'query result should be cached' }]
    },
    { diff: '--- a/src/db/search.ts\n+++ b/src/db/search.ts\n' }
  );
  writeFixture(root, '02-missed', {
    mustFind: [
      {
        claimIncludes: 'path traversal',
        file: 'src/files/download.ts',
        category: 'security',
        minSeverity: 'high'
      }
    ],
    mustNotFind: []
  });
  writeFixture(root, '03-noisy', {
    mustFind: [
      {
        claimIncludes: 'race condition',
        file: 'src/account/withdraw.ts',
        category: 'concurrency',
        minSeverity: 'high'
      }
    ],
    mustNotFind: [{ claimIncludes: 'benign false alarm' }]
  });
  writeFixture(root, '04-runner-error', {
    mustFind: [
      {
        claimIncludes: 'swallows the payment error',
        file: 'src/payments/capture.ts',
        category: 'reliability',
        minSeverity: 'high'
      }
    ],
    mustNotFind: []
  });
}

async function runSampleSuite(root) {
  return runEvalSuite({
    fixturesDir: root,
    runner: async fixture => {
      if (fixture.name === '01-caught') {
        return {
          findings: [
            finding({
              claim: 'SQL injection in the search query',
              file: 'src/db/search.ts',
              category: 'security',
              severity: 'critical'
            })
          ],
          latencyMs: 10,
          cost: 0.1
        };
      }
      if (fixture.name === '02-missed') {
        return {
          findings: [
            finding({
              claim: 'Style issue in the download handler',
              file: 'src/files/download.ts',
              category: 'security',
              severity: 'high'
            })
          ],
          latencyMs: 30,
          cost: 0.3
        };
      }
      if (fixture.name === '03-noisy') {
        return {
          findings: [
            finding({
              claim: 'A race condition allows concurrent withdrawals to overdraw',
              file: 'src/account/withdraw.ts',
              category: 'concurrency',
              severity: 'high'
            }),
            finding({
              claim: 'This is a benign false alarm',
              file: 'src/account/withdraw.ts',
              category: 'concurrency',
              severity: 'low'
            })
          ],
          latencyMs: 20,
          cost: 0.2
        };
      }
      return { findings: [], latencyMs: 40, error: 'runner crashed' };
    }
  });
}

test('matchFindings: claim normalization, file, category and severity', () => {
  const expected = {
    mustFind: [
      expectation({
        claimIncludes: 'does not filter by OWNER!',
        file: 'src/api/projects.ts',
        category: 'Security',
        minSeverity: 'high'
      })
    ],
    mustNotFind: []
  };
  const result = matchFindings(
    [
      finding({
        claim: '  The project lookup   does NOT filter by owner  ',
        file: 'src\\api\\projects.ts',
        category: 'security',
        severity: 'high'
      })
    ],
    expected
  );

  assert.equal(result.caught.length, 1);
  assert.equal(result.missed.length, 0);
  assert.equal(result.falsePositives.length, 0);
  assert.equal(result.catchRate, 1);
  assert.equal(result.falsePositiveRate, 0);
  assert.equal(result.caught[0].expected.claimIncludes, 'does not filter by OWNER!');
});

test('matchesExpected: file, category and severity filters reject otherwise matching claims', () => {
  const base = finding({ file: 'src/api/projects.ts' });
  assert.equal(matchesExpected(base, expectation({ file: 'src/api/projects.ts' })), true);
  assert.equal(matchesExpected(base, expectation({ file: 'src/api/other.ts' })), false);
  assert.equal(matchesExpected(base, expectation({ category: 'security' })), true);
  assert.equal(matchesExpected(base, expectation({ category: 'performance' })), false);
  assert.equal(matchesExpected(base, expectation({ minSeverity: 'high' })), true);
  assert.equal(matchesExpected(base, expectation({ minSeverity: 'critical' })), false);
  assert.equal(matchesExpected(base, expectation({ claimIncludes: '   ' })), false);
});

test('matchFindings: misses and mustNotFind false positives are counted', () => {
  const result = matchFindings(
    [
      finding({ claim: 'SQL injection in search' }),
      finding({ claim: 'The query result should be cached', category: 'performance' })
    ],
    {
      mustFind: [expectation({ claimIncludes: 'sql injection' })],
      mustNotFind: [{ claimIncludes: 'query result should be cached' }]
    }
  );

  assert.equal(result.caught.length, 1);
  assert.equal(result.missed.length, 0);
  assert.equal(result.falsePositives.length, 1);
  assert.equal(result.catchRate, 1);
  assert.equal(result.falsePositiveRate, 0.5);
});

test('matchFindings: empty expectations produce zero rates', () => {
  const result = matchFindings([], { mustFind: [], mustNotFind: [] });
  assert.deepEqual(result.caught, []);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.falsePositives, []);
  assert.equal(result.catchRate, 0);
  assert.equal(result.falsePositiveRate, 0);
});

test('loadEvalFixtures: sorted directories, optional diff, BOM and CRLF normalization', t => {
  const root = makeTemp();
  t.after(() => cleanup(root));

  writeFixture(
    root,
    '02-beta',
    { mustFind: [{ claimIncludes: 'beta bug' }], mustNotFind: [] },
    { task: 'Review beta' }
  );
  writeFixture(
    root,
    '01-alpha',
    {
      mustFind: [
        { claimIncludes: 'alpha bug', file: 'src/alpha.ts', minSeverity: 'medium' }
      ],
      mustNotFind: [{ claimIncludes: 'alpha noise' }]
    },
    {
      task: '\uFEFFReview alpha\n',
      diff: '--- a/src/alpha.ts\r\n+++ b/src/alpha.ts\r\n'
    }
  );

  const fixtures = loadEvalFixtures(root);
  assert.deepEqual(fixtures.map(fixture => fixture.name), ['01-alpha', '02-beta']);
  assert.equal(fixtures[0].task, 'Review alpha');
  assert.equal(fixtures[0].diff, '--- a/src/alpha.ts\n+++ b/src/alpha.ts\n');
  assert.equal(fixtures[0].expected.mustFind[0].file, 'src/alpha.ts');
  assert.equal(fixtures[0].expected.mustFind[0].minSeverity, 'medium');
  assert.equal(fixtures[0].expected.mustNotFind[0].claimIncludes, 'alpha noise');
  assert.equal(fixtures[1].diff, undefined);
});

test('loadEvalFixtures: invalid expected.json fails with fixture context', t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  const directory = writeFixture(root, 'broken', { mustFind: [], mustNotFind: [] });
  writeFileSync(join(directory, 'expected.json'), '{ broken', 'utf8');

  assert.throws(() => loadEvalFixtures(root), /broken.*invalid expected\.json/);
});

test('loadEvalFixtures: repository corpus contains exactly twenty-two valid fixtures', () => {
  const directory = fileURLToPath(new URL('../eval/fixtures/', import.meta.url));
  const fixtures = loadEvalFixtures(directory);
  assert.equal(fixtures.length, 22);
  const names = fixtures.map(fixture => fixture.name);
  assert.equal(new Set(names).size, names.length, 'fixture names must be unique');
  for (const fixture of fixtures) {
    assert.ok(fixture.task.length > 0, `${fixture.name} has no task`);
    assert.ok(fixture.expected.mustFind.length >= 1, `${fixture.name} has no mustFind`);
    assert.ok(fixture.expected.mustNotFind.length >= 1, `${fixture.name} has no mustNotFind`);
    assert.ok((fixture.diff ?? '').length > 0, `${fixture.name} has no diff`);
    for (const expected of fixture.expected.mustFind) {
      assert.ok(
        expected.claimIncludes !== undefined ||
          expected.file !== undefined ||
          expected.category !== undefined ||
          expected.minSeverity !== undefined,
        `${fixture.name} has an empty mustFind entry`
      );
    }
  }
});

test('runEvalSuite: aggregate metrics and per-fixture detail', async t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  sampleFixtures(root);

  const summary = await runSampleSuite(root);

  assert.equal(summary.totalFixtures, 4);
  assert.deepEqual(summary.fixtures.map(fixture => fixture.name), [
    '01-caught',
    '02-missed',
    '03-noisy',
    '04-runner-error'
  ]);
  assert.equal(summary.caught, 2);
  assert.equal(summary.missed, 2);
  assert.equal(summary.falsePositives, 1);
  assert.equal(summary.catchRate, 0.5);
  assert.equal(summary.falsePositiveRate, 1 / 3);
  assert.equal(summary.p50LatencyMs, 25);
  assert.ok(Math.abs(summary.totalCost - 0.6) < 1e-9);
  assert.deepEqual(summary.errors, [{ fixture: '04-runner-error', message: 'runner crashed' }]);

  const caught = summary.fixtures.find(fixture => fixture.name === '01-caught');
  assert.equal(caught.caught.length, 1);
  assert.equal(caught.missed.length, 0);
  assert.equal(caught.catchRate, 1);

  const noisy = summary.fixtures.find(fixture => fixture.name === '03-noisy');
  assert.equal(noisy.falsePositives.length, 1);
  assert.equal(noisy.falsePositiveRate, 0.5);

  const errored = summary.fixtures.find(fixture => fixture.name === '04-runner-error');
  assert.equal(errored.error, 'runner crashed');
  assert.equal(errored.missed.length, 1);
  assert.equal(errored.catchRate, 0);
});

test('runEvalSuite: thrown runner errors do not abort the suite', async t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  writeFixture(root, 'throws', {
    mustFind: [{ claimIncludes: 'planted bug' }],
    mustNotFind: []
  });

  const summary = await runEvalSuite({
    fixturesDir: root,
    runner: async () => {
      throw new Error('model unavailable');
    }
  });

  assert.equal(summary.totalFixtures, 1);
  assert.equal(summary.caught, 0);
  assert.equal(summary.missed, 1);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0].message, /model unavailable/);
});

test('formatEvalSummary: JSON is parseable and preserves aggregate metrics', async t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  sampleFixtures(root);

  const summary = await runSampleSuite(root);
  const parsed = JSON.parse(formatEvalSummary(summary, { json: true }));
  assert.equal(parsed.totalFixtures, 4);
  assert.equal(parsed.catchRate, 0.5);
  assert.equal(parsed.falsePositiveRate, 1 / 3);
  assert.equal(parsed.p50LatencyMs, 25);
  assert.ok(Math.abs(parsed.totalCost - 0.6) < 1e-9);
  assert.equal(parsed.errors[0].fixture, '04-runner-error');
});

test('formatEvalSummary: markdown includes aggregate, fixtures, misses and errors', async t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  sampleFixtures(root);

  const summary = await runSampleSuite(root);
  const text = formatEvalSummary(summary);

  assert.match(text, /^# Consilium eval/m);
  assert.match(text, /Catch rate: 50\.0%/);
  assert.match(text, /False-positive rate: 33\.3%/);
  assert.match(text, /p50 latency: 25 ms/);
  assert.match(text, /01-caught/);
  assert.match(text, /## Missed findings/);
  assert.match(text, /path traversal/);
  assert.match(text, /## False positives/);
  assert.match(text, /benign false alarm/);
  assert.match(text, /## Errors/);
  assert.match(text, /runner crashed/);
});
