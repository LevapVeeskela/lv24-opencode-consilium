import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError } from '../dist/interfaces/cli/args.js';
import { commandEval } from '../dist/interfaces/cli/commands/eval.js';
import { printHelp } from '../dist/interfaces/cli/help.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `consilium-${prefix}-`));
}

function cleanup(directory) {
  rmSync(directory, { recursive: true, force: true });
}

function finding(overrides = {}) {
  return {
    fingerprint: 'f_aaaaaaaa',
    severity: 'high',
    category: 'security',
    claim: 'The alpha bug is real',
    sources: [],
    contested: false,
    rejectedBy: [],
    ...overrides
  };
}

function writeFixture(root, name, expected) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'task.md'), `Review ${name}\n`, 'utf8');
  writeFileSync(
    join(directory, 'expected.json'),
    `${JSON.stringify(expected, null, 2)}\n`,
    'utf8'
  );
  return directory;
}

function captureLogs(t) {
  const logs = [];
  t.mock.method(console, 'log', (...args) => {
    logs.push(args.join(' '));
  });
  return logs;
}

function closeTo(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message ?? 'value'}: ${actual} != ${expected}`
  );
}

function makeComparisonFixtures(root) {
  writeFixture(root, '01-caught', {
    mustFind: [{ claimIncludes: 'alpha bug' }],
    mustNotFind: []
  });
  writeFixture(root, '02-improved', {
    mustFind: [{ claimIncludes: 'beta bug' }],
    mustNotFind: []
  });
  writeFixture(root, '03-missed', {
    mustFind: [{ claimIncludes: 'gamma bug' }],
    mustNotFind: []
  });
}

function comparisonRunner(calls) {
  return async (fixture, options) => {
    calls.push({ name: fixture.name, rounds: options.rounds });
    const debated = options.rounds === 2;
    if (fixture.name === '01-caught') {
      return {
        findings: [finding({ claim: 'The alpha bug is real' })],
        latencyMs: 10,
        cost: debated ? 0.2 : 0.1
      };
    }
    if (fixture.name === '02-improved' && debated) {
      return {
        findings: [finding({ claim: 'The beta bug is real' })],
        latencyMs: 20,
        cost: 0.2
      };
    }
    return { findings: [], latencyMs: 30, cost: 0.1 };
  };
}

test('parseArgs: eval --rounds and --compare-rounds are mutually exclusive', () => {
  const compare = parseArgs(['eval', '--compare-rounds']);
  assert.equal(compare.command, 'eval');
  assert.equal(compare.compareRounds, true);
  assert.equal(compare.rounds, undefined);

  assert.equal(parseArgs(['eval', '--rounds', '1']).rounds, 1);
  assert.equal(parseArgs(['eval', '--rounds', '2']).rounds, 2);

  assert.throws(
    () => parseArgs(['eval', '--compare-rounds', '--rounds', '1']),
    UsageError
  );
  assert.throws(
    () => parseArgs(['eval', '--rounds', '2', '--compare-rounds']),
    /взаимоисключающие/
  );
  assert.throws(() => parseArgs(['eval', '--rounds', '3']), /1 или 2/);
});

test('help: eval documents --compare-rounds and --rounds', t => {
  const logs = captureLogs(t);
  printHelp();
  const text = logs.join('\n');

  assert.match(text, /--compare-rounds/);
  assert.match(text, /consilium eval[\s\S]*--rounds <1\|2>/);
  assert.match(text, /--max-cost в compare-режиме ограничивает сумму обоих прогонов/);
});

test('commandEval --compare-rounds: runs both round values and prints the delta table', async t => {
  const root = tempDir('eval-compare-text');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  makeComparisonFixtures(fixtures);

  const logs = captureLogs(t);
  const calls = [];
  const code = await commandEval(
    { task: '', command: 'eval', fixtures: 'fixtures', compareRounds: true },
    { cwd: root, runner: comparisonRunner(calls) }
  );

  assert.equal(code, 0);
  assert.deepEqual(
    calls.map(call => call.name),
    ['01-caught', '02-improved', '03-missed', '01-caught', '02-improved', '03-missed']
  );
  assert.deepEqual(
    calls.map(call => call.rounds),
    [1, 1, 1, 2, 2, 2]
  );

  const output = logs.join('\n');
  assert.match(output, /^# Consilium eval comparison/m);
  assert.match(output, /^\| metric \| single \| debate \| delta \|$/m);
  assert.match(output, /\| Catch rate \| 33\.3% \| 66\.7% \| \+33\.3 pp \|/);
  assert.match(output, /^Single \(rounds=1\): fixtures 3, catch 33\.3% \(1\/3\)/m);
  assert.match(output, /^Debate \(rounds=2\): fixtures 3, catch 66\.7% \(2\/3\)/m);
});

test('commandEval --compare-rounds --json: outputs single, debate and delta', async t => {
  const root = tempDir('eval-compare-json');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  makeComparisonFixtures(fixtures);

  const logs = captureLogs(t);
  const calls = [];
  const code = await commandEval(
    {
      task: '',
      command: 'eval',
      fixtures: 'fixtures',
      compareRounds: true,
      json: true
    },
    { cwd: root, runner: comparisonRunner(calls) }
  );

  assert.equal(code, 0);
  assert.equal(calls.length, 6);
  const parsed = JSON.parse(logs.join('\n'));
  assert.deepEqual(Object.keys(parsed), ['single', 'debate', 'delta']);
  assert.equal(parsed.single.totalFixtures, 3);
  assert.equal(parsed.debate.totalFixtures, 3);
  closeTo(parsed.single.catchRate, 1 / 3, 'single catchRate');
  closeTo(parsed.debate.catchRate, 2 / 3, 'debate catchRate');
  closeTo(parsed.delta.catchRate, 1 / 3, 'delta catchRate');
  closeTo(parsed.single.totalCost, 0.3, 'single totalCost');
  closeTo(parsed.debate.totalCost, 0.5, 'debate totalCost');
  closeTo(parsed.delta.totalCost, 0.2, 'delta totalCost');
});

test('commandEval --compare-rounds: --fail-under gates the debate catch rate', async t => {
  const root = tempDir('eval-compare-gate');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFixture(fixtures, 'always', {
    mustFind: [{ claimIncludes: 'alpha bug' }],
    mustNotFind: []
  });
  writeFixture(fixtures, 'debate-only', {
    mustFind: [{ claimIncludes: 'beta bug' }],
    mustNotFind: []
  });

  captureLogs(t);
  const improving = async (fixture, options) => ({
    findings:
      fixture.name === 'always'
        ? [finding({ claim: 'The alpha bug is real' })]
        : options.rounds === 2
          ? [finding({ claim: 'The beta bug is real' })]
          : [],
    latencyMs: 5
  });
  const degrading = async (fixture, options) => ({
    findings:
      options.rounds === 1
        ? [
            finding({
              claim:
                fixture.name === 'always'
                  ? 'The alpha bug is real'
                  : 'The beta bug is real'
            })
          ]
        : [],
    latencyMs: 5
  });

  // single = 50%, debate = 100%: порог выше single, но ниже debate — успех.
  assert.equal(
    await commandEval(
      {
        task: '',
        command: 'eval',
        fixtures: 'fixtures',
        compareRounds: true,
        failUnder: 75
      },
      { cwd: root, runner: improving }
    ),
    0
  );

  // single = 100%, debate = 0%: порог проверяет именно debate — код 3.
  assert.equal(
    await commandEval(
      {
        task: '',
        command: 'eval',
        fixtures: 'fixtures',
        compareRounds: true,
        failUnder: 50
      },
      { cwd: root, runner: degrading }
    ),
    3
  );
});

test('commandEval --rounds 2: passes rounds=2 to runEvalSuite', async t => {
  const root = tempDir('eval-rounds');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFixture(fixtures, '01-alpha', {
    mustFind: [{ claimIncludes: 'alpha bug' }],
    mustNotFind: []
  });
  writeFixture(fixtures, '02-beta', {
    mustFind: [{ claimIncludes: 'beta bug' }],
    mustNotFind: []
  });

  const logs = captureLogs(t);
  const seen = [];
  const options = parseArgs(['eval', '--rounds', '2']);
  const code = await commandEval(
    { ...options, fixtures: 'fixtures' },
    {
      cwd: root,
      runner: async (fixture, runnerOptions) => {
        seen.push({ name: fixture.name, rounds: runnerOptions.rounds });
        return {
          findings: [finding({ claim: `The ${fixture.name.slice(3)} bug is real` })],
          latencyMs: 7,
          cost: 0.01
        };
      }
    }
  );

  assert.equal(code, 0);
  assert.deepEqual(seen, [
    { name: '01-alpha', rounds: 2 },
    { name: '02-beta', rounds: 2 }
  ]);
  const output = logs.join('\n');
  assert.match(output, /^# Consilium eval/m);
  assert.doesNotMatch(output, /Consilium eval comparison/);
});

test('commandEval --compare-rounds --max-cost: shared budget across both runs', async t => {
  const root = tempDir('eval-compare-budget');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFixture(fixtures, '01-first', { mustFind: [], mustNotFind: [] });
  writeFixture(fixtures, '02-second', { mustFind: [], mustNotFind: [] });

  const logs = captureLogs(t);
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { findings: [], latencyMs: 3, cost: 1 };
  };

  const textCode = await commandEval(
    {
      task: '',
      command: 'eval',
      fixtures: 'fixtures',
      compareRounds: true,
      maxCost: 0.5
    },
    { cwd: root, runner }
  );

  assert.equal(textCode, 0);
  assert.equal(calls, 1);
  const text = logs.join('\n');
  assert.match(text, /skipped/);
  assert.match(text, /02-second/);

  logs.length = 0;
  const jsonCode = await commandEval(
    {
      task: '',
      command: 'eval',
      fixtures: 'fixtures',
      compareRounds: true,
      maxCost: 0.5,
      json: true
    },
    { cwd: root, runner }
  );

  assert.equal(jsonCode, 0);
  assert.equal(calls, 2);
  const parsed = JSON.parse(logs.join('\n'));
  closeTo(parsed.single.totalCost, 1, 'single totalCost');
  closeTo(parsed.debate.totalCost, 0, 'debate totalCost');
  closeTo(parsed.delta.totalCost, -1, 'delta totalCost');
  assert.match(parsed.single.fixtures[1].error, /skipped/);
  assert.match(parsed.debate.fixtures[0].error, /skipped/);
  assert.match(parsed.debate.fixtures[1].error, /skipped/);
});

test('commandEval: --compare-rounds and --rounds are rejected together', async t => {
  const root = tempDir('eval-compare-conflict');
  t.after(() => cleanup(root));
  const fixtures = join(root, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFixture(fixtures, 'only', { mustFind: [], mustNotFind: [] });

  captureLogs(t);
  await assert.rejects(
    () =>
      commandEval(
        {
          task: '',
          command: 'eval',
          fixtures: 'fixtures',
          compareRounds: true,
          rounds: 2
        },
        { cwd: root, runner: async () => ({ findings: [], latencyMs: 1 }) }
      ),
    error => error instanceof UsageError && /взаимоисключающие/.test(error.message)
  );
});
