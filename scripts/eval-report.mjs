#!/usr/bin/env node

/**
 * @file Generates docs/eval-results.md from real `consilium eval` JSON output.
 *
 * The script is dependency-free. It reads the JSON produced by
 * `consilium eval --json` and/or `consilium eval --compare-rounds --json`,
 * validates its shape and renders markdown. It never invents metrics: an
 * invalid input aborts before anything is written.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_OUT = 'docs/eval-results.md';
const DEFAULT_FIXTURES = join(REPO_ROOT, 'eval', 'fixtures');
const SINGLE_LABEL = 'Single pass';
const DEBATE_LABEL = 'Debate (2 rounds)';

const USAGE = `Usage: node scripts/eval-report.mjs [options]

Reads JSON produced by the eval command and writes a markdown report.
At least one input is required.

Options:
  --single <file>      JSON from \`consilium eval --json\`
  --compare <file>     JSON from \`consilium eval --compare-rounds --json\`
  --out <file>         Output markdown (default: ${DEFAULT_OUT})
  --check              Validate inputs, print a summary and write nothing
  --date <YYYY-MM-DD>  Report date (default: today, UTC)
  --commit <sha>       Commit metadata (default: git short HEAD when available)
  --version <version>  Consilium version (default: package.json version)
  --fixtures <dir>     Fixture corpus for the coverage table
                       (default: <repository>/eval/fixtures)
  -h, --help           Show this help

Examples:
  node scripts/eval-report.mjs --compare eval-compare.json
  node scripts/eval-report.mjs --single eval-single.json --out docs/eval-results.md
  node scripts/eval-report.mjs --check --compare eval-compare.json
`;

/** CLI error with an explicit process exit code. */
class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses `--name value` and `--name=value` arguments. Boolean flags are
 * `--check`, `--help` and `-h`.
 */
export function parseArgs(argv) {
  const options = { check: false, help: false };
  const valueFlags = new Set([
    'single',
    'compare',
    'out',
    'date',
    'commit',
    'version',
    'fixtures'
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    const match = /^--([a-z]+)(?:=(.*))?$/.exec(argument);
    if (match === null) {
      throw new CliError(`unknown argument: ${argument}`, 2);
    }
    const name = match[1];
    if (!valueFlags.has(name)) {
      throw new CliError(`unknown option: --${name}`, 2);
    }

    let value = match[2];
    if (value === undefined) {
      index += 1;
      value = argv[index];
      if (value === undefined || value.startsWith('--')) {
        throw new CliError(`--${name} requires a value`, 2);
      }
    }
    if (value.length === 0) {
      throw new CliError(`--${name} requires a non-empty value`, 2);
    }
    if (options[name] !== undefined) {
      throw new CliError(`--${name} was provided more than once`, 2);
    }
    options[name] = value;
  }

  return options;
}

// ---------------------------------------------------------------------------
// JSON shape validation
// ---------------------------------------------------------------------------

function requireObject(value, path) {
  if (!isRecord(value)) {
    throw new CliError(`${path}: expected a JSON object`);
  }
  return value;
}

function requireArray(value, path) {
  if (!Array.isArray(value)) {
    throw new CliError(`${path}: expected an array`);
  }
  return value;
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CliError(`${path}: expected a non-empty string`);
  }
  return value;
}

function requireNumber(value, path, options = {}) {
  if (!isFiniteNumber(value)) {
    throw new CliError(`${path}: expected a finite number`);
  }
  if (options.integer === true && !Number.isInteger(value)) {
    throw new CliError(`${path}: expected an integer`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new CliError(`${path}: must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new CliError(`${path}: must be <= ${options.max}`);
  }
  return value;
}

function validateFixtureResult(value, path) {
  const fixture = requireObject(value, path);
  requireString(fixture.name, `${path}.name`);

  requireArray(fixture.caught, `${path}.caught`);
  const missed = requireArray(fixture.missed, `${path}.missed`);
  const falsePositives = requireArray(
    fixture.falsePositives,
    `${path}.falsePositives`
  );

  missed.forEach((target, index) => {
    requireObject(target, `${path}.missed[${index}]`);
  });
  falsePositives.forEach((match, index) => {
    const item = requireObject(match, `${path}.falsePositives[${index}]`);
    requireObject(item.expected, `${path}.falsePositives[${index}].expected`);
  });

  requireNumber(fixture.catchRate, `${path}.catchRate`, { min: 0, max: 1 });
  requireNumber(fixture.falsePositiveRate, `${path}.falsePositiveRate`, {
    min: 0,
    max: 1
  });
  requireNumber(fixture.latencyMs, `${path}.latencyMs`, { min: 0 });
  if (fixture.cost !== undefined) {
    requireNumber(fixture.cost, `${path}.cost`, { min: 0 });
  }
  if (fixture.error !== undefined) {
    requireString(fixture.error, `${path}.error`);
  }
}

/** Validates an `EvalSummary` object produced by `consilium eval --json`. */
export function validateSummary(value, label) {
  const summary = requireObject(value, label);
  const fixtures = requireArray(summary.fixtures, `${label}.fixtures`);
  fixtures.forEach((fixture, index) => {
    validateFixtureResult(fixture, `${label}.fixtures[${index}]`);
  });

  const totalFixtures = requireNumber(summary.totalFixtures, `${label}.totalFixtures`, {
    integer: true,
    min: 0
  });
  if (totalFixtures !== fixtures.length) {
    throw new CliError(
      `${label}.totalFixtures is ${totalFixtures}, but fixtures has ${fixtures.length} entries`
    );
  }

  for (const field of ['caught', 'missed', 'falsePositives']) {
    requireNumber(summary[field], `${label}.${field}`, { integer: true, min: 0 });
  }
  requireNumber(summary.catchRate, `${label}.catchRate`, { min: 0, max: 1 });
  requireNumber(summary.falsePositiveRate, `${label}.falsePositiveRate`, {
    min: 0,
    max: 1
  });
  requireNumber(summary.p50LatencyMs, `${label}.p50LatencyMs`, { min: 0 });
  requireNumber(summary.totalCost, `${label}.totalCost`, { min: 0 });

  const errors = requireArray(summary.errors, `${label}.errors`);
  errors.forEach((entry, index) => {
    const item = requireObject(entry, `${label}.errors[${index}]`);
    requireString(item.fixture, `${label}.errors[${index}].fixture`);
    requireString(item.message, `${label}.errors[${index}].message`);
  });

  return summary;
}

/** Validates an `EvalComparison` object from `--compare-rounds --json`. */
export function validateComparison(value, label) {
  const comparison = requireObject(value, label);
  validateSummary(comparison.single, `${label}.single`);
  validateSummary(comparison.debate, `${label}.debate`);

  const delta = requireObject(comparison.delta, `${label}.delta`);
  for (const field of ['catchRate', 'falsePositiveRate', 'p50LatencyMs', 'totalCost']) {
    requireNumber(delta[field], `${label}.delta.${field}`);
  }

  return comparison;
}

function readJsonFile(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CliError(`${label}: cannot read ${path}: ${errorMessage(error)}`);
  }

  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new CliError(`${label}: invalid JSON in ${path}: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture coverage
// ---------------------------------------------------------------------------

/**
 * Reads fixture directories and their `expected.json` files. The report uses
 * the on-disk count so a stale run cannot claim coverage it did not have.
 */
export function collectFixtureCoverage(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new CliError(
      `fixtures: cannot read ${directory}: ${errorMessage(error)}`
    );
  }

  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort(compareText)
    .map(name => {
      const expectedPath = join(directory, name, 'expected.json');
      const expected = readJsonFile(expectedPath, `fixtures/${name}`);
      const value = requireObject(expected, expectedPath);
      const mustFind = requireArray(value.mustFind, `${expectedPath}.mustFind`);
      const rawMustNotFind = value.mustNotFind ?? [];
      if (!Array.isArray(rawMustNotFind)) {
        throw new CliError(`${expectedPath}.mustNotFind: expected an array`);
      }
      return {
        name,
        mustFind: mustFind.length,
        mustNotFind: rawMustNotFind.length
      };
    });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRate(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatRateWithCounts(value, numerator, denominator) {
  return `${formatRate(value)} (${numerator}/${denominator})`;
}

function formatNumber(value) {
  return Number(value.toFixed(2)).toString();
}

function formatCost(value) {
  return value === undefined ? '—' : `$${value.toFixed(4)}`;
}

function formatRateDelta(value) {
  const points = Number((value * 100).toFixed(1));
  return `${points > 0 ? '+' : ''}${points.toFixed(1)} pp`;
}

function formatLatencyDelta(value) {
  const rounded = Number(value.toFixed(2));
  return `${rounded > 0 ? '+' : ''}${formatNumber(rounded)} ms`;
}

function formatCostDelta(value) {
  const rounded = Number(value.toFixed(4));
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return `${sign}$${Math.abs(rounded).toFixed(4)}`;
}

function cell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function inlineCode(value) {
  return `\`${cell(value).replace(/`/g, '\\`')}\``;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function describeExpected(target) {
  if (!isRecord(target)) return '—';
  const rawClaims = target.claimIncludes;
  const claims = Array.isArray(rawClaims)
    ? rawClaims
    : typeof rawClaims === 'string'
      ? [rawClaims]
      : [];
  const claimText = claims
    .filter(claim => typeof claim === 'string' && claim.trim().length > 0)
    .map(claim => claim.trim())
    .join(' | ');
  if (claimText.length > 0) return claimText;

  const parts = [];
  if (typeof target.file === 'string' && target.file.length > 0) {
    parts.push(target.file);
  }
  if (typeof target.category === 'string' && target.category.length > 0) {
    parts.push(target.category);
  }
  if (typeof target.minSeverity === 'string' && target.minSeverity.length > 0) {
    parts.push(`>= ${target.minSeverity}`);
  }
  return parts.length > 0 ? parts.join(' ') : '—';
}

function computeDelta(single, debate) {
  return {
    catchRate: debate.catchRate - single.catchRate,
    falsePositiveRate: debate.falsePositiveRate - single.falsePositiveRate,
    p50LatencyMs: debate.p50LatencyMs - single.p50LatencyMs,
    totalCost: debate.totalCost - single.totalCost
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderMetadataRows({ single, debate, inputPaths, metadata, coverage }) {
  const rows = [
    ['Date', metadata.date],
    ['Commit', metadata.commit],
    ['Consilium version', metadata.version]
  ];

  const counts = [];
  if (single !== undefined) counts.push(`${single.totalFixtures} (single)`);
  if (debate !== undefined) counts.push(`${debate.totalFixtures} (debate)`);
  rows.push(['Fixtures in run', counts.join(' / ')]);
  rows.push([
    'Fixture corpus',
    `${coverage.length} fixtures in ${inlineCode(metadata.fixturesLabel)}`
  ]);

  if (inputPaths.single !== undefined) {
    rows.push(['Single input', inlineCode(inputPaths.single)]);
  }
  if (inputPaths.compare !== undefined) {
    rows.push(['Comparison input', inlineCode(inputPaths.compare)]);
  }

  return rows
    .map(([field, value]) => {
      const rendered = value === 'not provided' ? 'not provided' : cell(value);
      return `| ${field} | ${rendered} |`;
    })
    .join('\n');
}

function renderCommands({ inputPaths, options }) {
  const lines = ['## Reproduction', '', '```bash', '# from a checkout'];

  if (inputPaths.single !== undefined) {
    lines.push('node bin/cli.js eval --json > eval-single.json');
  }
  if (inputPaths.compare !== undefined) {
    lines.push('node bin/cli.js eval --compare-rounds --json > eval-compare.json');
  }

  const reportParts = ['node scripts/eval-report.mjs'];
  if (inputPaths.single !== undefined) {
    reportParts.push(`--single ${shellQuote(inputPaths.single)}`);
  }
  if (inputPaths.compare !== undefined) {
    reportParts.push(`--compare ${shellQuote(inputPaths.compare)}`);
  }
  reportParts.push(`--out ${shellQuote(options.out ?? DEFAULT_OUT)}`);
  for (const flag of ['date', 'commit', 'version', 'fixtures']) {
    if (options[flag] !== undefined) {
      reportParts.push(`--${flag} ${shellQuote(options[flag])}`);
    }
  }
  lines.push(reportParts.join(' '));
  lines.push('```', '');

  if (inputPaths.single !== undefined && inputPaths.compare !== undefined) {
    lines.push(
      'The single and comparison inputs were supplied separately; confirm they',
      'were produced from the same fixtures, models and provider settings.',
      ''
    );
  } else if (inputPaths.compare !== undefined) {
    lines.push(
      'The comparison JSON contains both the single and the debate run, so one',
      '`--compare-rounds` invocation is enough for the full table.',
      ''
    );
  }

  lines.push(
    'The installed package uses `consilium eval` instead of `node bin/cli.js eval`.',
    '`consilium eval --json` does not record model or provider ids; keep the',
    'configured expert/model set next to this report.',
    ''
  );

  return lines.join('\n');
}

function renderAggregate({ single, debate, delta }) {
  const lines = ['## Aggregate metrics', ''];
  if (single === undefined) return lines.join('\n');

  if (debate === undefined || delta === null) {
    lines.push(
      '| Metric | Single pass |',
      '| --- | ---: |',
      `| Catch rate | ${formatRateWithCounts(
        single.catchRate,
        single.caught,
        single.caught + single.missed
      )} |`,
      `| False-positive rate | ${formatRateWithCounts(
        single.falsePositiveRate,
        single.falsePositives,
        single.caught + single.falsePositives
      )} |`,
      `| p50 latency | ${formatNumber(single.p50LatencyMs)} ms |`,
      `| Total cost | ${formatCost(single.totalCost)} |`,
      ''
    );
    return lines.join('\n');
  }

  lines.push(
    '| Metric | Single pass | Debate (2 rounds) | Delta (debate − single) |',
    '| --- | ---: | ---: | ---: |',
    `| Catch rate | ${formatRateWithCounts(
      single.catchRate,
      single.caught,
      single.caught + single.missed
    )} | ${formatRateWithCounts(
      debate.catchRate,
      debate.caught,
      debate.caught + debate.missed
    )} | ${formatRateDelta(delta.catchRate)} |`,
    `| False-positive rate | ${formatRateWithCounts(
      single.falsePositiveRate,
      single.falsePositives,
      single.caught + single.falsePositives
    )} | ${formatRateWithCounts(
      debate.falsePositiveRate,
      debate.falsePositives,
      debate.caught + debate.falsePositives
    )} | ${formatRateDelta(delta.falsePositiveRate)} |`,
    `| p50 latency | ${formatNumber(single.p50LatencyMs)} ms | ` +
      `${formatNumber(debate.p50LatencyMs)} ms | ${formatLatencyDelta(
        delta.p50LatencyMs
      )} |`,
    `| Total cost | ${formatCost(single.totalCost)} | ${formatCost(
      debate.totalCost
    )} | ${formatCostDelta(delta.totalCost)} |`,
    ''
  );
  return lines.join('\n');
}

function renderFixtureTable(summary) {
  const lines = [
    '| Fixture | Caught | Missed | False positives | Catch rate | FP rate | Latency | Cost | Error |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for (const fixture of summary.fixtures) {
    lines.push(
      `| ${inlineCode(fixture.name)} | ${fixture.caught.length} | ` +
        `${fixture.missed.length} | ${fixture.falsePositives.length} | ` +
        `${formatRate(fixture.catchRate)} | ${formatRate(fixture.falsePositiveRate)} | ` +
        `${formatNumber(fixture.latencyMs)} ms | ${formatCost(fixture.cost)} | ` +
        `${fixture.error === undefined ? '—' : cell(fixture.error)} |`
    );
  }
  return lines.join('\n');
}

function renderPerFixture({ single, debate }) {
  const lines = ['## Per-fixture results', ''];
  const runs = [];
  if (single !== undefined) runs.push({ label: SINGLE_LABEL, summary: single });
  if (debate !== undefined) runs.push({ label: DEBATE_LABEL, summary: debate });

  runs.forEach((run, index) => {
    if (index > 0) lines.push('');
    lines.push(`### ${run.label}`, '', renderFixtureTable(run.summary));
  });
  lines.push('');
  return lines.join('\n');
}

function renderIssueSection(title, runs, collectItems) {
  const lines = [`## ${title}`, ''];
  runs.forEach((run, runIndex) => {
    if (runIndex > 0) lines.push('');
    if (runs.length > 1) {
      lines.push(`### ${run.label}`, '');
    }
    const items = collectItems(run.summary);
    if (items.length === 0) {
      lines.push('None.');
    } else {
      lines.push(...items);
    }
  });
  lines.push('');
  return lines.join('\n');
}

function renderCoverage({ coverage, metadata, single, debate }) {
  const lines = [
    '## Fixture coverage',
    '',
    `The on-disk corpus in ${inlineCode(metadata.fixturesLabel)} contains ` +
      `${coverage.length} fixtures.`
  ];

  const runCounts = [single?.totalFixtures, debate?.totalFixtures].filter(
    value => value !== undefined
  );
  if (runCounts.length > 0) {
    const unique = [...new Set(runCounts)];
    lines.push(
      unique.length === 1
        ? `The run JSON covers ${unique[0]} fixtures.`
        : `The run JSON covers ${unique.join(' / ')} fixtures.`
    );
  }

  lines.push(
    '',
    '| Fixture | Must find | Must not find |',
    '| --- | ---: | ---: |'
  );
  for (const fixture of coverage) {
    lines.push(
      `| ${inlineCode(fixture.name)} | ${fixture.mustFind} | ${fixture.mustNotFind} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderNotes({ inputPaths }) {
  const lines = [
    '## Notes',
    '',
    '- All numbers in this report come from the JSON files listed above, produced by a',
    '  real `consilium eval` run. No values are estimated or hand-written.',
    '- The eval JSON does not include model or provider ids; record the configured',
    '  expert/model set before publishing this report.',
    '- Do not compare runs with different fixtures, models or provider settings.'
  ];
  if (inputPaths.single !== undefined && inputPaths.compare !== undefined) {
    lines.push(
      '- `--single` and `--compare` were supplied separately; verify that both inputs',
      '  were produced from the same corpus and model set.'
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Renders the full markdown report. All values are taken from validated
 * summaries; the caller is responsible for validation.
 */
export function renderReport({
  single,
  debate,
  delta,
  inputPaths,
  metadata,
  coverage,
  options = {}
}) {
  const lines = [
    '# Evaluation results',
    '',
    '> Generated from real `consilium eval` JSON output. Every metric below is',
    '> copied from the input files; the generator never estimates or fills in numbers.',
    '',
    '| Field | Value |',
    '| --- | --- |',
    renderMetadataRows({ single, debate, inputPaths, metadata, coverage }),
    ''
  ];

  lines.push(renderCommands({ inputPaths, options }));
  lines.push(renderAggregate({ single, debate, delta }));

  const runs = [];
  if (single !== undefined) runs.push({ label: SINGLE_LABEL, summary: single });
  if (debate !== undefined) runs.push({ label: DEBATE_LABEL, summary: debate });

  lines.push(renderPerFixture({ single, debate }));
  lines.push(
    renderIssueSection('Missed findings', runs, summary =>
      summary.fixtures.flatMap(fixture =>
        fixture.missed.map(
          target =>
            `- **${inlineCode(fixture.name)}**: ${cell(describeExpected(target))}`
        )
      )
    )
  );
  lines.push(
    renderIssueSection('False positives', runs, summary =>
      summary.fixtures.flatMap(fixture =>
        fixture.falsePositives.map(
          match =>
            `- **${inlineCode(fixture.name)}**: ${cell(describeExpected(match.expected))}`
        )
      )
    )
  );
  lines.push(
    renderIssueSection('Errors', runs, summary =>
      summary.errors.map(
        error => `- **${inlineCode(error.fixture)}**: ${cell(error.message)}`
      )
    )
  );
  lines.push(renderCoverage({ coverage, metadata, single, debate }));
  lines.push(renderNotes({ inputPaths }));

  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

function detectCommit() {
  try {
    const value = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    }).trim();
    return value.length > 0 ? value : 'not provided';
  } catch {
    return 'not provided';
  }
}

function detectVersion() {
  try {
    const value = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
    ).version;
    return typeof value === 'string' && value.length > 0 ? value : 'not provided';
  } catch {
    return 'not provided';
  }
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CliError('--date must use YYYY-MM-DD', 2);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new CliError(`--date is not a real calendar date: ${value}`, 2);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeFileAtomic(target, content) {
  const directory = dirname(target);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new CliError(`cannot create ${directory}: ${errorMessage(error)}`);
  }

  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    writeFileSync(temporary, content, 'utf8');
    try {
      renameSync(temporary, target);
    } catch (error) {
      const code = error?.code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
      // Windows may refuse to replace an existing file with rename().
      rmSync(target, { force: true });
      renameSync(temporary, target);
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new CliError(`cannot write ${target}: ${errorMessage(error)}`);
  }
}

function compactSummary(summary) {
  return (
    `${summary.totalFixtures} fixtures, ` +
    `catch ${formatRateWithCounts(
      summary.catchRate,
      summary.caught,
      summary.caught + summary.missed
    )}, ` +
    `FP ${formatRateWithCounts(
      summary.falsePositiveRate,
      summary.falsePositives,
      summary.caught + summary.falsePositives
    )}, ` +
    `p50 ${formatNumber(summary.p50LatencyMs)} ms, ` +
    `cost ${formatCost(summary.totalCost)}, errors ${summary.errors.length}`
  );
}

function printCheck({ single, debate, delta, coverage, metadata, outPath }) {
  if (single !== undefined) {
    console.log(`OK ${SINGLE_LABEL}: ${compactSummary(single)}`);
  }
  if (debate !== undefined) {
    console.log(`OK ${DEBATE_LABEL}: ${compactSummary(debate)}`);
  }
  if (delta !== null) {
    console.log(
      `OK delta (debate - single): catch ${formatRateDelta(
        delta.catchRate
      )}, FP ${formatRateDelta(delta.falsePositiveRate)}, ` +
        `p50 ${formatLatencyDelta(delta.p50LatencyMs)}, ` +
        `cost ${formatCostDelta(delta.totalCost)}`
    );
  }
  console.log(
    `OK fixture coverage: ${coverage.length} fixtures (${metadata.fixturesLabel})`
  );
  console.log(`Would write: ${outPath}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function execute(options) {
  if (
    options.single === undefined &&
    options.compare === undefined
  ) {
    throw new CliError(
      'provide --single <file> and/or --compare <file> (see --help)',
      2
    );
  }
  if (options.date !== undefined) validateDate(options.date);

  const singlePath =
    options.single === undefined ? undefined : resolve(process.cwd(), options.single);
  const comparePath =
    options.compare === undefined ? undefined : resolve(process.cwd(), options.compare);

  const singleInput =
    singlePath === undefined
      ? undefined
      : validateSummary(readJsonFile(singlePath, '--single'), '--single');
  const comparison =
    comparePath === undefined
      ? undefined
      : validateComparison(readJsonFile(comparePath, '--compare'), '--compare');

  let single = singleInput;
  let debate;
  let delta = null;
  if (comparison !== undefined) {
    debate = comparison.debate;
    if (singleInput !== undefined) {
      single = singleInput;
      delta = computeDelta(single, debate);
    } else {
      single = comparison.single;
      delta = comparison.delta;
    }
  }

  const fixturesDir =
    options.fixtures === undefined
      ? DEFAULT_FIXTURES
      : resolve(process.cwd(), options.fixtures);
  const coverage = collectFixtureCoverage(fixturesDir);

  const metadata = {
    date: options.date ?? today(),
    commit: options.commit ?? detectCommit(),
    version: options.version ?? detectVersion(),
    fixturesLabel:
      options.fixtures === undefined ? 'eval/fixtures' : options.fixtures
  };

  const outPath = resolve(process.cwd(), options.out ?? DEFAULT_OUT);
  const inputPaths = {
    single: options.single,
    compare: options.compare
  };

  if (options.check) {
    printCheck({ single, debate, delta, coverage, metadata, outPath });
    return 0;
  }

  const report = renderReport({
    single,
    debate,
    delta,
    inputPaths,
    metadata,
    coverage,
    options
  });
  writeFileAtomic(outPath, report);
  console.log(`Wrote ${outPath} (${report.length} bytes).`);
  return 0;
}

/** Runs the CLI and returns the process exit code. */
export function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(USAGE);
      return 0;
    }
    return execute(options);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`eval-report: ${error.message}`);
      if (error.exitCode === 2) {
        console.error('Run with --help for usage.');
      }
      return error.exitCode;
    }
    console.error(`eval-report: ${errorMessage(error)}`);
    return 1;
  }
}

function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  const normalize = path =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
