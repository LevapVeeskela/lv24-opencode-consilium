/**
 * @fileoverview Команда eval: прогон набора фикстур с реальным консилиумом
 * или инжектированным runner-ом.
 * @module lv24-opencode-consilium/cli/commands/eval
 */

import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import type { CLIOptions, ConsiliumConfig } from '../../../domain/types.js';
import {
  formatEvalComparison,
  formatEvalSummary,
  runEvalComparison,
  runEvalSuite,
  type EvalComparison,
  type EvalRunner,
  type EvalRunnerOutput,
  type EvalSummary
} from '../../../application/eval.js';
import { Consilium, loadConfig } from '../../../application/consilium.js';
import { EXIT_CODES, UsageError } from '../args.js';
import { applyCliOverrides } from '../overrides.js';
import { log } from '../output.js';

/** Зависимости команды eval, подменяемые в тестах */
export interface EvalCommandDependencies {
  /** Готовый runner; по умолчанию — реальный Consilium */
  runner?: EvalRunner;
  /** Рабочая директория (по умолчанию process.cwd()) */
  cwd?: string;
}

/** Каталог фикстур по умолчанию относительно cwd */
const DEFAULT_FIXTURES_DIR = 'eval/fixtures';

/**
 * Создаёт runner, который для каждой фикстуры запускает Consilium
 * с включёнными находками, без сохранения файла и артефактов.
 */
export function resolveEvalRunner(options: CLIOptions): EvalRunner {
  const loaded = loadConfig(options.config, {
    trustProjectConfig: options.config !== undefined
  });
  if (!options.silent) {
    for (const warning of loaded.warnings) {
      log(options, `⚠️ ${warning}`);
    }
  }

  const baseConfig = applyCliOverrides(loaded.config, options);
  const runnerConfig: Partial<ConsiliumConfig> = {
    ...baseConfig,
    findings: true,
    artifacts: false,
    output: { ...baseConfig.output, file: false }
  };
  // --max-cost в eval — бюджет всего набора, а не отдельного запуска.
  delete runnerConfig.maxCost;

  return async (fixture, runnerOptions) => {
    const diff = fixture.diff;
    const task = diff !== undefined && diff.trim().length > 0
      ? `${fixture.task}\n\n${diff}`
      : fixture.task;

    const consilium = new Consilium(runnerConfig);
    const result = await consilium.run(task, { rounds: runnerOptions?.rounds });

    const output: EvalRunnerOutput = {
      findings: result.metadata?.findings?.items ?? [],
      latencyMs: result.totalTime
    };
    if (typeof result.usage?.cost === 'number') {
      output.cost = result.usage.cost;
    }
    if (!result.success) {
      output.error =
        result.chair.errorMessage ??
        result.chair.errorCode ??
        'consilium run failed';
    }
    return output;
  };
}

function nonNegativeCost(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Оборачивает runner общим бюджетом: при достижении --max-cost следующие
 * фикстуры не запускаются, а возвращают ошибку `skipped`.
 */
function createBudgetRunner(
  baseRunner: EvalRunner,
  maxCost: number | undefined
): EvalRunner {
  let spent = 0;

  return async (fixture, runnerOptions) => {
    if (maxCost !== undefined && spent >= maxCost) {
      return {
        findings: [],
        latencyMs: 0,
        error:
          `skipped: превышен лимит --max-cost $${maxCost.toFixed(4)} ` +
          `(потрачено $${spent.toFixed(4)})`
      };
    }

    const output = await baseRunner(fixture, runnerOptions);
    spent += nonNegativeCost(output.cost);
    return output;
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCompactSummary(label: string, summary: EvalSummary): string {
  const expected = summary.caught + summary.missed;
  const errors = summary.errors.length > 0 ? `, errors ${summary.errors.length}` : '';
  return (
    `${label}: fixtures ${summary.totalFixtures}, ` +
    `catch ${formatPercent(summary.catchRate)} (${summary.caught}/${expected}), ` +
    `FP ${formatPercent(summary.falsePositiveRate)}, ` +
    `p50 ${Number(summary.p50LatencyMs.toFixed(2))} ms, ` +
    `cost $${summary.totalCost.toFixed(4)}${errors}`
  );
}

/** Компактная сводка одного прогона сравнения; ошибки и skipped — отдельными строками. */
function printComparisonRun(label: string, summary: EvalSummary): void {
  console.log(formatCompactSummary(label, summary));
  for (const error of summary.errors) {
    console.log(`  ${error.fixture}: ${error.message}`);
  }
}

export async function commandEval(
  options: CLIOptions,
  deps: EvalCommandDependencies | EvalRunner = {}
): Promise<number> {
  if (options.compareRounds === true && options.rounds !== undefined) {
    throw new UsageError(
      'Флаги --compare-rounds и --rounds взаимоисключающие: выберите один.'
    );
  }

  const dependencies: EvalCommandDependencies =
    typeof deps === 'function' ? { runner: deps } : deps;
  const cwd = dependencies.cwd ?? process.cwd();
  const fixturesDir = options.fixtures
    ? resolve(cwd, options.fixtures)
    : resolve(cwd, DEFAULT_FIXTURES_DIR);

  let directory = false;
  if (existsSync(fixturesDir)) {
    try {
      directory = statSync(fixturesDir).isDirectory();
    } catch {
      directory = false;
    }
  }
  if (!directory) {
    throw new UsageError(
      `Каталог eval-фикстур не найден: ${fixturesDir}. ` +
        'Создайте eval/fixtures или укажите --fixtures <dir>.'
    );
  }

  const baseRunner = dependencies.runner ?? resolveEvalRunner(options);
  const budgetRunner = createBudgetRunner(baseRunner, options.maxCost);

  if (options.compareRounds === true) {
    let comparison: EvalComparison;
    try {
      comparison = await runEvalComparison({ fixturesDir, runner: budgetRunner });
    } catch (error) {
      throw new UsageError(`Eval: ${(error as Error).message}`);
    }

    if (options.json === true) {
      console.log(JSON.stringify(comparison, null, 2));
    } else {
      console.log(formatEvalComparison(comparison).trimEnd());
      console.log('');
      printComparisonRun('Single (rounds=1)', comparison.single);
      console.log('');
      printComparisonRun('Debate (rounds=2)', comparison.debate);
    }

    // В compare-режиме порог проверяет качество дебатов, а не одиночного прогона.
    if (
      options.failUnder !== undefined &&
      comparison.debate.catchRate * 100 < options.failUnder
    ) {
      log(
        options,
        `❌ Debate catch rate ${formatPercent(comparison.debate.catchRate)} ` +
          `ниже --fail-under ${options.failUnder}%`
      );
      return EXIT_CODES.policyGate;
    }

    return EXIT_CODES.success;
  }

  let summary;
  try {
    summary = await runEvalSuite({
      fixturesDir,
      runner: budgetRunner,
      rounds: options.rounds ?? 1
    });
  } catch (error) {
    throw new UsageError(`Eval: ${(error as Error).message}`);
  }

  console.log(formatEvalSummary(summary, { json: options.json }).trimEnd());

  if (
    options.failUnder !== undefined &&
    summary.catchRate * 100 < options.failUnder
  ) {
    log(
      options,
      `❌ Catch rate ${(summary.catchRate * 100).toFixed(1)}% ` +
        `ниже --fail-under ${options.failUnder}%`
    );
    return EXIT_CODES.policyGate;
  }

  return EXIT_CODES.success;
}
