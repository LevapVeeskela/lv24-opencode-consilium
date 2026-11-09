/**
 * @fileoverview Команда eval: прогон набора фикстур с реальным консилиумом
 * или инжектированным runner-ом.
 * @module lv24-opencode-consilium/cli/commands/eval
 */

import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import type { CLIOptions, ConsiliumConfig } from '../../../domain/types.js';
import {
  formatEvalSummary,
  runEvalSuite,
  type EvalRunner,
  type EvalRunnerOutput
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

  return async fixture => {
    const diff = fixture.diff;
    const task = diff !== undefined && diff.trim().length > 0
      ? `${fixture.task}\n\n${diff}`
      : fixture.task;

    const consilium = new Consilium(runnerConfig);
    const result = await consilium.run(task);

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

export async function commandEval(
  options: CLIOptions,
  deps: EvalCommandDependencies | EvalRunner = {}
): Promise<number> {
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
  const maxCost = options.maxCost;
  let spent = 0;
  let stopped = false;

  const budgetRunner: EvalRunner = async fixture => {
    if (stopped) {
      return {
        findings: [],
        latencyMs: 0,
        error:
          `skipped: превышен лимит --max-cost $${(maxCost ?? 0).toFixed(4)} ` +
          `(потрачено $${spent.toFixed(4)})`
      };
    }

    const output = await baseRunner(fixture);
    spent += nonNegativeCost(output.cost);
    if (maxCost !== undefined && spent > maxCost) {
      stopped = true;
    }
    return output;
  };

  let summary;
  try {
    summary = await runEvalSuite({ fixturesDir, runner: budgetRunner });
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
