import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatEvalComparison,
  runEvalComparison,
  runEvalSuite
} from '../dist/application/eval.js';

function finding(overrides = {}) {
  return {
    fingerprint: 'f_aaaaaaaa',
    severity: 'high',
    category: 'security',
    claim: 'A planted bug',
    sources: [],
    contested: false,
    rejectedBy: [],
    ...overrides
  };
}

function makeTemp() {
  return mkdtempSync(join(tmpdir(), 'consilium-eval-debate-'));
}

function cleanup(directory) {
  rmSync(directory, { recursive: true, force: true });
}

function writeFixture(root, name, expected, options = {}) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'task.md'), options.task ?? `Review ${name}\n`, 'utf8');
  writeFileSync(
    join(directory, 'expected.json'),
    `${JSON.stringify(expected, null, 2)}\n`,
    'utf8'
  );
  return directory;
}

function closeTo(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message ?? 'value'}: ${actual} != ${expected}`
  );
}

function roundsFixtures(root) {
  writeFixture(root, '01-alpha', {
    mustFind: [{ claimIncludes: 'alpha bug' }],
    mustNotFind: []
  });
  writeFixture(root, '02-beta', {
    mustFind: [{ claimIncludes: 'beta bug' }],
    mustNotFind: []
  });
}

function comparisonFixtures(root) {
  writeFixture(root, '01-caught', {
    mustFind: [{ claimIncludes: 'alpha bug' }],
    mustNotFind: [{ claimIncludes: 'alpha noise' }]
  });
  writeFixture(root, '02-improved', {
    mustFind: [{ claimIncludes: 'beta bug' }],
    mustNotFind: []
  });
  writeFixture(root, '03-noisy', {
    mustFind: [{ claimIncludes: 'gamma bug' }],
    mustNotFind: [{ claimIncludes: 'gamma noise' }]
  });
}

async function runComparisonSample(root) {
  const calls = [];
  const comparison = await runEvalComparison({
    fixturesDir: root,
    runner: async (fixture, options) => {
      calls.push({ name: fixture.name, rounds: options.rounds });
      const debated = options.rounds === 2;
      if (fixture.name === '01-caught') {
        return {
          findings: [finding({ claim: 'The alpha bug is real' })],
          latencyMs: debated ? 20 : 10,
          cost: debated ? 0.1 : 0.4
        };
      }
      if (fixture.name === '02-improved') {
        return {
          findings: debated ? [finding({ claim: 'The beta bug is real' })] : [],
          latencyMs: 30,
          cost: debated ? 0.1 : 0.2
        };
      }
      return {
        findings: debated
          ? [
              finding({ claim: 'The gamma bug is real' }),
              finding({ claim: 'This is gamma noise', severity: 'low' })
            ]
          : [finding({ claim: 'The gamma bug is real' })],
        latencyMs: debated ? 70 : 50,
        cost: debated ? 0.2 : 0.3
      };
    }
  });
  return { comparison, calls };
}

function emptySummary(overrides = {}) {
  return {
    fixtures: [],
    totalFixtures: 0,
    caught: 0,
    missed: 0,
    falsePositives: 0,
    catchRate: 0,
    falsePositiveRate: 0,
    p50LatencyMs: 0,
    totalCost: 0,
    errors: [],
    ...overrides
  };
}

test('runEvalSuite: rounds=2 is passed to the runner for every fixture', async t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  roundsFixtures(root);

  const seen = [];
  const summary = await runEvalSuite({
    fixturesDir: root,
    rounds: 2,
    runner: async (fixture, options) => {
      seen.push({ name: fixture.name, options });
      return { findings: [], latencyMs: 1, cost: 0 };
    }
  });

  assert.equal(summary.totalFixtures, 2);
  assert.deepEqual(
    seen.map(call => call.name),
    ['01-alpha', '02-beta']
  );
  assert.deepEqual(
    seen.map(call => call.options),
    [{ rounds: 2 }, { rounds: 2 }]
  );
});

test('runEvalSuite: rounds defaults to 1 and aggregation is unchanged', async t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  writeFixture(root, '01-alpha', {
    mustFind: [{ claimIncludes: 'alpha bug' }],
    mustNotFind: []
  });

  const seen = [];
  const summary = await runEvalSuite({
    fixturesDir: root,
    runner: async (fixture, options) => {
      seen.push(options.rounds);
      return {
        findings: [finding({ claim: 'The alpha bug is real' })],
        latencyMs: 12,
        cost: 0.25
      };
    }
  });

  assert.deepEqual(seen, [1]);
  assert.equal(summary.totalFixtures, 1);
  assert.equal(summary.caught, 1);
  assert.equal(summary.missed, 0);
  assert.equal(summary.catchRate, 1);
  assert.equal(summary.p50LatencyMs, 12);
  closeTo(summary.totalCost, 0.25, 'totalCost');
});

test('runEvalComparison: runs each fixture twice and computes absolute deltas', async t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  comparisonFixtures(root);

  const { comparison, calls } = await runComparisonSample(root);

  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls.map(call => call.rounds),
    [1, 1, 1, 2, 2, 2]
  );
  for (const name of ['01-caught', '02-improved', '03-noisy']) {
    assert.deepEqual(
      calls.filter(call => call.name === name).map(call => call.rounds),
      [1, 2],
      `${name} must run once per rounds value`
    );
  }

  const { single, debate, delta } = comparison;

  assert.deepEqual(
    single.fixtures.map(fixture => fixture.name),
    ['01-caught', '02-improved', '03-noisy']
  );
  assert.deepEqual(
    debate.fixtures.map(fixture => fixture.name),
    ['01-caught', '02-improved', '03-noisy']
  );
  assert.equal(
    single.fixtures.find(fixture => fixture.name === '02-improved').missed.length,
    1
  );
  assert.equal(
    debate.fixtures.find(fixture => fixture.name === '02-improved').caught.length,
    1
  );
  assert.equal(
    debate.fixtures.find(fixture => fixture.name === '03-noisy').falsePositives.length,
    1
  );

  assert.equal(single.caught, 2);
  assert.equal(single.missed, 1);
  assert.equal(single.falsePositives, 0);
  closeTo(single.catchRate, 2 / 3, 'single catchRate');
  assert.equal(single.falsePositiveRate, 0);
  assert.equal(single.p50LatencyMs, 30);
  closeTo(single.totalCost, 0.9, 'single totalCost');

  assert.equal(debate.caught, 3);
  assert.equal(debate.missed, 0);
  assert.equal(debate.falsePositives, 1);
  assert.equal(debate.catchRate, 1);
  assert.equal(debate.falsePositiveRate, 0.25);
  assert.equal(debate.p50LatencyMs, 30);
  closeTo(debate.totalCost, 0.4, 'debate totalCost');

  // debate - single: positive, positive, zero and negative deltas.
  closeTo(delta.catchRate, 1 / 3, 'delta catchRate');
  closeTo(delta.falsePositiveRate, 0.25, 'delta falsePositiveRate');
  assert.equal(delta.p50LatencyMs, 0);
  closeTo(delta.totalCost, -0.5, 'delta totalCost');
});

test('formatEvalComparison: table contains all four metrics and the verdict', async t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  comparisonFixtures(root);

  const { comparison } = await runComparisonSample(root);
  const text = formatEvalComparison(comparison);

  assert.match(text, /^\| metric \| single \| debate \| delta \|$/m);
  assert.match(text, /\| Catch rate \|/);
  assert.match(text, /\| FP rate \|/);
  assert.match(text, /\| p50 latency \|/);
  assert.match(text, /\| Total cost \|/);
  assert.match(text, /Verdict:.*catches more/);
  assert.match(text, /\+33\.3 pp/);
  assert.match(text, /\+25\.0 pp/);
  assert.match(text, /0 ms \|/);
  assert.match(text, /-\$0\.5000 \|/);
});

test('formatEvalComparison: verdict calls out higher debate cost', () => {
  const text = formatEvalComparison({
    single: emptySummary({ catchRate: 0.5, totalCost: 0.1 }),
    debate: emptySummary({ catchRate: 0.5, totalCost: 0.3 }),
    delta: {
      catchRate: 0,
      falsePositiveRate: 0,
      p50LatencyMs: 0,
      totalCost: 0.2
    }
  });

  assert.match(text, /Verdict:.*costs more/);
  assert.doesNotMatch(text, /catches more/);
});

test('runEvalComparison: runner errors are counted in both runs without aborting', async t => {
  const root = makeTemp();
  t.after(() => cleanup(root));
  writeFixture(root, '01-error', {
    mustFind: [{ claimIncludes: 'error bug' }],
    mustNotFind: []
  });
  writeFixture(root, '02-ok', {
    mustFind: [{ claimIncludes: 'ok bug' }],
    mustNotFind: []
  });

  let calls = 0;
  const comparison = await runEvalComparison({
    fixturesDir: root,
    runner: async fixture => {
      calls += 1;
      if (fixture.name === '01-error') throw new Error('model unavailable');
      return {
        findings: [finding({ claim: 'The ok bug is real' })],
        latencyMs: 5,
        cost: 0.01
      };
    }
  });

  assert.equal(calls, 4);
  for (const summary of [comparison.single, comparison.debate]) {
    assert.equal(summary.totalFixtures, 2);
    assert.equal(summary.caught, 1);
    assert.equal(summary.missed, 1);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].fixture, '01-error');
    assert.match(summary.errors[0].message, /model unavailable/);
    assert.equal(
      summary.fixtures.find(fixture => fixture.name === '02-ok').caught.length,
      1
    );
  }
});
