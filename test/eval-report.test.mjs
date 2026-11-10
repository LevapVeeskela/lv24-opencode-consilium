import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFixtureCoverage } from '../scripts/eval-report.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/eval-report.mjs', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('../eval/fixtures/', import.meta.url));

function expectation(claimIncludes, extra = {}) {
  return { claimIncludes, ...extra };
}

function fixtureResult({
  name,
  caught = 0,
  missed = [],
  falsePositives = [],
  latencyMs,
  cost,
  error
}) {
  const catchRate = caught + missed.length === 0 ? 0 : caught / (caught + missed.length);
  const falsePositiveRate =
    caught + falsePositives.length === 0
      ? 0
      : falsePositives.length / (caught + falsePositives.length);

  const result = {
    name,
    task: `Review ${name}`,
    expected: {
      mustFind: Array.from({ length: caught + missed.length }, (_, index) =>
        expectation(`target ${index}`)
      ),
      mustNotFind: falsePositives.map(match => match.expected)
    },
    findings: [],
    caught: Array.from({ length: caught }, (_, index) => ({
      expected: expectation(`target ${index}`),
      finding: null
    })),
    missed,
    falsePositives,
    catchRate,
    falsePositiveRate,
    latencyMs
  };
  if (cost !== undefined) result.cost = cost;
  if (error !== undefined) result.error = error;
  return result;
}

function sampleSingle() {
  return {
    fixtures: [
      fixtureResult({
        name: '01-caught',
        caught: 1,
        latencyMs: 10,
        cost: 0.1
      }),
      fixtureResult({
        name: '02-missed',
        missed: [expectation('path traversal')],
        latencyMs: 30,
        cost: 0.3
      }),
      fixtureResult({
        name: '03-noisy',
        caught: 1,
        falsePositives: [
          {
            expected: expectation('benign false alarm'),
            finding: null
          }
        ],
        latencyMs: 20,
        cost: 0.2
      }),
      fixtureResult({
        name: '04-runner-error',
        missed: [expectation('swallows the payment error')],
        latencyMs: 40,
        error: 'runner crashed'
      })
    ],
    totalFixtures: 4,
    caught: 2,
    missed: 2,
    falsePositives: 1,
    catchRate: 0.5,
    falsePositiveRate: 1 / 3,
    p50LatencyMs: 25,
    totalCost: 0.6,
    errors: [{ fixture: '04-runner-error', message: 'runner crashed' }]
  };
}

function sampleDebate() {
  return {
    fixtures: [
      fixtureResult({
        name: '01-caught',
        caught: 1,
        latencyMs: 20,
        cost: 0.2
      }),
      fixtureResult({
        name: '02-missed',
        caught: 1,
        latencyMs: 30,
        cost: 0.4
      }),
      fixtureResult({
        name: '03-noisy',
        caught: 1,
        falsePositives: [
          {
            expected: expectation('benign false alarm'),
            finding: null
          }
        ],
        latencyMs: 50,
        cost: 0.3
      }),
      fixtureResult({
        name: '04-runner-error',
        caught: 1,
        latencyMs: 40,
        cost: 0.5
      })
    ],
    totalFixtures: 4,
    caught: 4,
    missed: 0,
    falsePositives: 1,
    catchRate: 1,
    falsePositiveRate: 0.2,
    p50LatencyMs: 35,
    totalCost: 1.4,
    errors: []
  };
}

function sampleComparison() {
  const single = sampleSingle();
  const debate = sampleDebate();
  return {
    single,
    debate,
    delta: {
      catchRate: debate.catchRate - single.catchRate,
      falsePositiveRate: debate.falsePositiveRate - single.falsePositiveRate,
      p50LatencyMs: debate.p50LatencyMs - single.p50LatencyMs,
      totalCost: debate.totalCost - single.totalCost
    }
  };
}

function makeTemp(t) {
  const directory = mkdtempSync(join(tmpdir(), 'consilium-eval-report-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(directory, name, value) {
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8'
  });
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('--help prints the command contract', () => {
  const result = runCli(['--help']);
  assertSuccess(result);
  assert.match(result.stdout, /--single <file>/);
  assert.match(result.stdout, /--compare <file>/);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /--out <file>/);
});

test('fixture coverage: repository corpus has twenty-two fixtures', () => {
  const coverage = collectFixtureCoverage(FIXTURES_DIR);
  assert.equal(coverage.length, 22);
  assert.ok(coverage.every(fixture => fixture.mustFind >= 1));
  assert.ok(coverage.every(fixture => fixture.mustNotFind >= 1));
  assert.ok(coverage.some(fixture => fixture.name === '01-authz-idor'));
  assert.ok(coverage.some(fixture => fixture.name === '22-error-swallowing-async'));
});

test('generates a full report from single and comparison JSON', t => {
  const directory = makeTemp(t);
  const singlePath = writeJson(directory, 'eval-single.json', sampleSingle());
  const comparePath = writeJson(directory, 'eval-compare.json', sampleComparison());
  const outPath = join(directory, 'eval-results.md');

  const result = runCli([
    '--single',
    singlePath,
    '--compare',
    comparePath,
    '--out',
    outPath,
    '--date',
    '2026-11-10',
    '--commit',
    'abc1234',
    '--version',
    '1.12.0'
  ]);
  assertSuccess(result);

  const text = readFileSync(outPath, 'utf8');
  assert.match(text, /^# Evaluation results/m);
  assert.match(text, /\| Date \| 2026-11-10 \|/);
  assert.match(text, /\| Commit \| abc1234 \|/);
  assert.match(text, /\| Consilium version \| 1\.12\.0 \|/);

  assert.match(text, /node bin\/cli\.js eval --json > eval-single\.json/);
  assert.match(text, /node bin\/cli\.js eval --compare-rounds --json > eval-compare\.json/);
  assert.match(text, /node scripts\/eval-report\.mjs --single/);

  // Aggregate single / debate / delta table.
  assert.match(text, /50\.0% \(2\/4\)/);
  assert.match(text, /33\.3% \(1\/3\)/);
  assert.match(text, /100\.0% \(4\/4\)/);
  assert.match(text, /20\.0% \(1\/5\)/);
  assert.match(text, /25 ms/);
  assert.match(text, /35 ms/);
  assert.match(text, /\$0\.6000/);
  assert.match(text, /\$1\.4000/);
  assert.match(text, /\+50\.0 pp/);
  assert.match(text, /-13\.3 pp/);
  assert.match(text, /\+10 ms/);
  assert.match(text, /\+[$]0\.8000/);

  // Per-fixture rows for both runs.
  const caughtRow = '| `01-caught` | 1 | 0 | 0 |';
  const missedRow = '| `02-missed` | 0 | 1 | 0 |';
  const errorRow = '| `04-runner-error` | 0 | 1 | 0 | 0.0% | 0.0% | 40 ms | — | runner crashed |';
  assert.equal(text.split(caughtRow).length - 1, 2, 'caught fixture appears in both tables');
  assert.ok(text.includes(missedRow));
  assert.ok(text.includes(errorRow));

  // Missed findings, false positives and errors sections.
  assert.match(text, /## Missed findings/);
  assert.match(text, /path traversal/);
  assert.match(text, /swallows the payment error/);
  assert.match(text, /## False positives/);
  assert.match(text, /benign false alarm/);
  assert.match(text, /## Errors/);
  assert.match(text, /runner crashed/);
  assert.match(text, /### Single pass/);
  assert.match(text, /### Debate \(2 rounds\)/);

  // Coverage comes from the on-disk corpus, not from the input JSON.
  assert.match(text, /contains 22 fixtures/);
  assert.ok(text.includes('| `01-authz-idor` | 1 | 1 |'));
  assert.match(text, /real `consilium eval` run/);
  assert.match(text, /No values are estimated or hand-written/);
});

test('works outside the repository root and still finds the fixture corpus', t => {
  const directory = makeTemp(t);
  const singlePath = writeJson(directory, 'eval-single.json', sampleSingle());
  const outPath = join(directory, 'report.md');

  const result = runCli(
    [
      '--single',
      singlePath,
      '--out',
      outPath,
      '--date',
      '2026-11-10',
      '--commit',
      'abc1234',
      '--version',
      '1.12.0'
    ],
    { cwd: directory }
  );
  assertSuccess(result);

  const text = readFileSync(outPath, 'utf8');
  assert.match(text, /contains 22 fixtures/);
});

test('generates a single-run report without debate columns', t => {
  const directory = makeTemp(t);
  const singlePath = writeJson(directory, 'eval-single.json', sampleSingle());
  const outPath = join(directory, 'single.md');

  const result = runCli([
    '--single',
    singlePath,
    '--out',
    outPath,
    '--date',
    '2026-11-10',
    '--commit',
    'abc1234',
    '--version',
    '1.12.0'
  ]);
  assertSuccess(result);

  const text = readFileSync(outPath, 'utf8');
  assert.match(text, /\| Metric \| Single pass \|/);
  assert.doesNotMatch(text, /Debate \(2 rounds\)/);
  assert.doesNotMatch(text, /Delta/);
  assert.match(text, /50\.0% \(2\/4\)/);
  assert.match(text, /## Per-fixture results/);
  assert.match(text, /## Missed findings/);
  assert.match(text, /## False positives/);
  assert.match(text, /## Errors/);
  assert.match(text, /contains 22 fixtures/);
  assert.doesNotMatch(text, /node bin\/cli\.js eval --compare-rounds/);
});

test('--compare alone uses the embedded single and debate runs', t => {
  const directory = makeTemp(t);
  const comparePath = writeJson(directory, 'eval-compare.json', sampleComparison());
  const outPath = join(directory, 'compare.md');

  const result = runCli([
    '--compare',
    comparePath,
    '--out',
    outPath,
    '--date',
    '2026-11-10',
    '--commit',
    'abc1234',
    '--version',
    '1.12.0'
  ]);
  assertSuccess(result);

  const text = readFileSync(outPath, 'utf8');
  assert.match(text, /\| Comparison input \|/);
  assert.doesNotMatch(text, /\| Single input \|/);
  assert.match(text, /50\.0% \(2\/4\)/);
  assert.match(text, /100\.0% \(4\/4\)/);
  assert.match(text, /\+50\.0 pp/);
  assert.match(text, /node bin\/cli\.js eval --compare-rounds --json/);
  assert.doesNotMatch(text, /node bin\/cli\.js eval --json >/);
});

test('--check validates and writes nothing', t => {
  const directory = makeTemp(t);
  const singlePath = writeJson(directory, 'eval-single.json', sampleSingle());
  const comparePath = writeJson(directory, 'eval-compare.json', sampleComparison());
  const outPath = join(directory, 'check.md');

  const result = runCli([
    '--check',
    '--single',
    singlePath,
    '--compare',
    comparePath,
    '--out',
    outPath
  ]);
  assertSuccess(result);
  assert.equal(existsSync(outPath), false);
  assert.match(result.stdout, /OK Single pass: 4 fixtures/);
  assert.match(result.stdout, /OK Debate \(2 rounds\): 4 fixtures/);
  assert.match(result.stdout, /OK delta \(debate - single\)/);
  assert.match(result.stdout, /OK fixture coverage: 22 fixtures/);
  assert.match(result.stdout, /Would write:/);

  // An existing file is also left untouched.
  writeFileSync(outPath, 'keep me\n', 'utf8');
  const again = runCli(['--check', '--single', singlePath, '--out', outPath]);
  assertSuccess(again);
  assert.equal(readFileSync(outPath, 'utf8'), 'keep me\n');
});

test('invalid single JSON exits non-zero and does not write', t => {
  const directory = makeTemp(t);
  const invalid = sampleSingle();
  delete invalid.catchRate;
  const singlePath = writeJson(directory, 'invalid-single.json', invalid);
  const outPath = join(directory, 'report.md');

  const result = runCli(['--single', singlePath, '--out', outPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /catchRate/);
  assert.equal(existsSync(outPath), false);
});

test('invalid comparison JSON exits non-zero and does not overwrite', t => {
  const directory = makeTemp(t);
  const invalid = sampleComparison();
  delete invalid.delta;
  const comparePath = writeJson(directory, 'invalid-compare.json', invalid);
  const outPath = join(directory, 'report.md');
  writeFileSync(outPath, 'sentinel\n', 'utf8');

  const result = runCli(['--compare', comparePath, '--out', outPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /delta/);
  assert.equal(readFileSync(outPath, 'utf8'), 'sentinel\n');
});

test('inconsistent totalFixtures exits non-zero', t => {
  const directory = makeTemp(t);
  const invalid = sampleSingle();
  invalid.totalFixtures = 99;
  const singlePath = writeJson(directory, 'invalid-total.json', invalid);
  const outPath = join(directory, 'report.md');

  const result = runCli(['--single', singlePath, '--out', outPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /totalFixtures/);
  assert.equal(existsSync(outPath), false);
});

test('malformed JSON exits non-zero with a clear error', t => {
  const directory = makeTemp(t);
  const singlePath = join(directory, 'broken.json');
  writeFileSync(singlePath, '{ broken', 'utf8');
  const outPath = join(directory, 'report.md');

  const result = runCli(['--single', singlePath, '--out', outPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid JSON/);
  assert.equal(existsSync(outPath), false);
});

test('missing inputs is a usage error and writes nothing', t => {
  const directory = makeTemp(t);
  const outPath = join(directory, 'report.md');

  const result = runCli(['--out', outPath]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /provide --single/);
  assert.equal(existsSync(outPath), false);
});

test('--out writes the complete file and leaves no temporary files', t => {
  const directory = makeTemp(t);
  const singlePath = writeJson(directory, 'eval-single.json', sampleSingle());
  const outputDirectory = join(directory, 'nested', 'out');
  mkdirSync(outputDirectory, { recursive: true });
  const outPath = join(outputDirectory, 'eval-results.md');

  const result = runCli([
    '--single',
    singlePath,
    '--out',
    outPath,
    '--date',
    '2026-11-10',
    '--commit',
    'abc1234',
    '--version',
    '1.12.0'
  ]);
  assertSuccess(result);

  const text = readFileSync(outPath, 'utf8');
  assert.ok(text.length > 500);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(readdirSync(outputDirectory), ['eval-results.md']);
});
