/**
 * @fileoverview Запуск eval-набора: загрузка фикстур, инжектированный runner,
 * матчинг находок и сводка с catch/FP-метриками. Модели здесь не вызываются.
 * @module lv24-opencode-consilium
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { normalizeClaim } from '../domain/council/findings.js';
import type { FindingSeverity } from '../domain/council/findings.js';
import { matchFindings } from '../domain/eval/matcher.js';
import { errorMessage } from '../shared/errors.js';
import { isRecord } from '../shared/record.js';
import type {
  EvalExpectations,
  EvalFixture,
  EvalFixtureResult,
  EvalRunInput,
  EvalRunner,
  EvalSummary,
  ExpectedFinding,
  FormatEvalOptions
} from '../domain/eval/types.js';

export type {
  EvalExpectations,
  EvalFixture,
  EvalFixtureResult,
  EvalFindingMatch,
  EvalMatchResult,
  EvalRunError,
  EvalRunInput,
  EvalRunner,
  EvalRunnerOutput,
  EvalSummary,
  ExpectedFinding,
  FormatEvalOptions
} from '../domain/eval/types.js';
export { matchFindings, matchesExpected } from '../domain/eval/matcher.js';

const SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * Загружает все фикстуры из каталога. Подкаталоги сортируются по имени
 * (лексикографически, без locale), чтобы прогон был воспроизводимым.
 */
export function loadEvalFixtures(directory: string): EvalFixture[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Eval fixtures: cannot read ${directory}: ${errorMessage(error)}`);
  }

  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort(compareText)
    .map(name => loadEvalFixture(join(directory, name), name));
}

/** Загружает одну фикстуру; `name` по умолчанию — имя каталога. */
export function loadEvalFixture(directory: string, name: string = basename(directory)): EvalFixture {
  const task = readFixtureText(join(directory, 'task.md'), name, 'task.md').trim();
  if (task.length === 0) {
    throw new Error(`Eval fixture "${name}": task.md is empty`);
  }

  const expected = parseExpected(
    readFixtureJson(join(directory, 'expected.json'), name),
    name
  );

  const diffPath = join(directory, 'changes.diff');
  const diffText = existsSync(diffPath)
    ? normalizeText(readFixtureText(diffPath, name, 'changes.diff'))
    : '';
  const fixture: EvalFixture = { name, task, expected };
  if (diffText.trim().length > 0) fixture.diff = diffText;
  return fixture;
}

/**
 * Прогоняет все фикстуры через инжектированный runner и агрегирует метрики.
 * Фикстуры выполняются последовательно; ошибка runner-а не прерывает набор,
 * а попадает в `error` и учитывается как пропущенная находка.
 */
export async function runEvalSuite(input: EvalRunInput): Promise<EvalSummary> {
  const wanted =
    input.names === undefined || input.names.length === 0
      ? null
      : new Set(input.names);
  const fixtures = loadEvalFixtures(input.fixturesDir).filter(
    fixture => wanted === null || wanted.has(fixture.name)
  );
  const results: EvalFixtureResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runFixture(fixture, input.runner));
  }
  return summarize(results);
}

/** Форматирует сводку как markdown или JSON. */
export function formatEvalSummary(
  summary: EvalSummary,
  options: FormatEvalOptions = {}
): string {
  if (options.json === true) return `${JSON.stringify(summary, null, 2)}\n`;

  const totalExpected = summary.caught + summary.missed;
  const lines = [
    '# Consilium eval',
    '',
    `Fixtures: ${summary.totalFixtures} | ` +
      `Catch rate: ${formatRate(summary.catchRate)} (${summary.caught}/${totalExpected}) | ` +
      `False-positive rate: ${formatRate(summary.falsePositiveRate)} ` +
      `(${summary.falsePositives}/${summary.caught + summary.falsePositives}) | ` +
      `p50 latency: ${formatNumber(summary.p50LatencyMs)} ms | ` +
      `Total cost: $${summary.totalCost.toFixed(4)}`,
    '',
    '| Fixture | Caught | Missed | False positives | Catch rate | FP rate | Latency | Cost |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];

  for (const fixture of summary.fixtures) {
    lines.push(
      `| ${cell(fixture.name)} | ${fixture.caught.length} | ${fixture.missed.length} | ` +
        `${fixture.falsePositives.length} | ${formatRate(fixture.catchRate)} | ` +
        `${formatRate(fixture.falsePositiveRate)} | ` +
        `${formatNumber(fixture.latencyMs)} ms | ${formatCost(fixture.cost)} |`
    );
  }

  const missed = summary.fixtures.filter(fixture => fixture.missed.length > 0);
  if (missed.length > 0) {
    lines.push('', '## Missed findings');
    for (const fixture of missed) {
      for (const target of fixture.missed) {
        lines.push(`- **${cell(fixture.name)}**: ${cell(describeExpected(target))}`);
      }
    }
  }

  const noise = summary.fixtures.filter(fixture => fixture.falsePositives.length > 0);
  if (noise.length > 0) {
    lines.push('', '## False positives');
    for (const fixture of noise) {
      for (const match of fixture.falsePositives) {
        lines.push(`- **${cell(fixture.name)}**: ${cell(describeExpected(match.expected))}`);
      }
    }
  }

  if (summary.errors.length > 0) {
    lines.push('', '## Errors');
    for (const error of summary.errors) {
      lines.push(`- **${cell(error.fixture)}**: ${cell(error.message)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function runFixture(fixture: EvalFixture, runner: EvalRunner): Promise<EvalFixtureResult> {
  const startedAt = Date.now();
  try {
    const output = await runner(fixture);
    const findings = Array.isArray(output.findings) ? output.findings : [];
    const elapsed = Math.max(0, Date.now() - startedAt);
    const latencyMs = nonNegative(output.latencyMs) ?? elapsed;
    const cost = nonNegative(output.cost);
    const error =
      typeof output.error === 'string' && output.error.trim().length > 0
        ? output.error
        : undefined;
    return buildResult(fixture, findings, latencyMs, cost, error);
  } catch (error) {
    return buildResult(
      fixture,
      [],
      Math.max(0, Date.now() - startedAt),
      undefined,
      errorMessage(error)
    );
  }
}

function buildResult(
  fixture: EvalFixture,
  findings: EvalFixtureResult['findings'],
  latencyMs: number,
  cost: number | undefined,
  error: string | undefined
): EvalFixtureResult {
  const match = matchFindings(findings, fixture.expected);
  const result: EvalFixtureResult = {
    name: fixture.name,
    task: fixture.task,
    expected: fixture.expected,
    findings,
    caught: match.caught,
    missed: match.missed,
    falsePositives: match.falsePositives,
    catchRate: match.catchRate,
    falsePositiveRate: match.falsePositiveRate,
    latencyMs
  };
  if (cost !== undefined) result.cost = cost;
  if (error !== undefined) result.error = error;
  return result;
}

function summarize(results: EvalFixtureResult[]): EvalSummary {
  let caught = 0;
  let missed = 0;
  let falsePositives = 0;
  let totalCost = 0;
  const latencies: number[] = [];
  const errors: EvalSummary['errors'] = [];

  for (const result of results) {
    caught += result.caught.length;
    missed += result.missed.length;
    falsePositives += result.falsePositives.length;
    totalCost += result.cost ?? 0;
    latencies.push(result.latencyMs);
    if (result.error !== undefined) {
      errors.push({ fixture: result.name, message: result.error });
    }
  }

  return {
    fixtures: results,
    totalFixtures: results.length,
    caught,
    missed,
    falsePositives,
    catchRate: caught + missed === 0 ? 0 : caught / (caught + missed),
    falsePositiveRate:
      caught + falsePositives === 0 ? 0 : falsePositives / (caught + falsePositives),
    p50LatencyMs: median(latencies),
    totalCost,
    errors
  };
}

function parseExpected(value: unknown, name: string): EvalExpectations {
  if (!isRecord(value)) {
    throw new Error(`Eval fixture "${name}": expected.json must be an object`);
  }
  const mustFind = value['mustFind'];
  if (!Array.isArray(mustFind)) {
    throw new Error(`Eval fixture "${name}": expected.json mustFind must be an array`);
  }
  const mustNotFind = value['mustNotFind'];
  if (mustNotFind !== undefined && !Array.isArray(mustNotFind)) {
    throw new Error(`Eval fixture "${name}": expected.json mustNotFind must be an array`);
  }
  return {
    mustFind: mustFind.map((item, index) =>
      parseExpectedFinding(item, name, `mustFind[${index}]`)
    ),
    mustNotFind: (mustNotFind ?? []).map((item, index) =>
      parseExpectedFinding(item, name, `mustNotFind[${index}]`)
    )
  };
}

function parseExpectedFinding(value: unknown, name: string, field: string): ExpectedFinding {
  if (!isRecord(value)) {
    throw new Error(`Eval fixture "${name}": ${field} must be an object`);
  }

  let claimIncludes: string | string[] | undefined;
  const rawClaim = value['claimIncludes'];
  if (rawClaim !== undefined) {
    const alternatives = Array.isArray(rawClaim) ? rawClaim : [rawClaim];
    if (alternatives.length === 0) {
      throw new Error(`Eval fixture "${name}": ${field}.claimIncludes must not be empty`);
    }
    const claims = alternatives.map((item): string => {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new Error(
          `Eval fixture "${name}": ${field}.claimIncludes must contain non-empty strings`
        );
      }
      if (normalizeClaim(item).length === 0) {
        throw new Error(`Eval fixture "${name}": ${field}.claimIncludes has no searchable text`);
      }
      return item.trim();
    });
    claimIncludes = claims.length === 1 ? claims[0] : claims;
  }

  const file = optionalString(value['file'], name, `${field}.file`);
  const category = optionalString(value['category'], name, `${field}.category`);
  const minSeverity = value['minSeverity'];

  if (
    claimIncludes === undefined &&
    file === undefined &&
    category === undefined &&
    minSeverity === undefined
  ) {
    throw new Error(
      `Eval fixture "${name}": ${field} needs at least one of claimIncludes, file, category, minSeverity`
    );
  }

  const result: ExpectedFinding = {};
  if (claimIncludes !== undefined) result.claimIncludes = claimIncludes;
  if (file !== undefined) result.file = file;
  if (category !== undefined) result.category = category;
  if (minSeverity !== undefined) {
    if (typeof minSeverity !== 'string' || !(SEVERITIES as readonly string[]).includes(minSeverity)) {
      throw new Error(
        `Eval fixture "${name}": ${field}.minSeverity must be one of ${SEVERITIES.join(', ')}`
      );
    }
    result.minSeverity = minSeverity as FindingSeverity;
  }
  return result;
}

function optionalString(value: unknown, name: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Eval fixture "${name}": ${field} must be a non-empty string`);
  }
  return value.trim();
}

function readFixtureText(path: string, name: string, file: string): string {
  try {
    return normalizeText(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Eval fixture "${name}": cannot read ${file}: ${errorMessage(error)}`);
  }
}

function readFixtureJson(path: string, name: string): unknown {
  const text = readFixtureText(path, name, 'expected.json');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Eval fixture "${name}": invalid expected.json: ${errorMessage(error)}`);
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function formatCost(value: number | undefined): string {
  return value === undefined ? '—' : `$${value.toFixed(4)}`;
}

function describeExpected(target: ExpectedFinding): string {
  if (target.claimIncludes !== undefined) {
    const claims = Array.isArray(target.claimIncludes) ? target.claimIncludes : [target.claimIncludes];
    const text = claims
      .map(claim => claim.trim())
      .filter(claim => claim.length > 0)
      .join(' | ');
    if (text.length > 0) return text;
  }
  const parts: string[] = [];
  if (target.file !== undefined && target.file.length > 0) parts.push(target.file);
  if (target.minSeverity !== undefined) parts.push(`>= ${target.minSeverity}`);
  return parts.length > 0 ? parts.join(' ') : '—';
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
