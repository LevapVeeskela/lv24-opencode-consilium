/**
 * @fileoverview Команды history и stats: история артефактов и сводная статистика.
 * @module lv24-opencode-consilium/cli/commands/history
 */

import { join, resolve } from 'node:path';
import type { CLIOptions } from '../../../domain/types.js';
import {
  formatHistoryTable,
  formatStats,
  loadHistory,
  renderStatsHtml,
  summarizeHistory,
  type HistoryLoadResult
} from '../../../application/history.js';
import { writeFileAtomic } from '../../../shared/fs.js';
import { errorMessage } from '../../../shared/errors.js';
import { EXIT_CODES, UsageError } from '../args.js';

/** Зависимости команд history/stats, подменяемые в тестах. */
export interface HistoryCommandDependencies {
  /** Рабочая директория проекта (по умолчанию process.cwd()). */
  cwd?: string;
  /** Загрузчик истории (по умолчанию читает .consilium/runs). */
  loadHistory?: (options: { dir: string; limit?: number }) => HistoryLoadResult;
}

/** Каталог артефактов: --artifacts-dir, строка --artifacts или .consilium/runs. */
function historyDir(options: CLIOptions, cwd: string): string {
  const configured =
    options.artifactsDir ??
    (typeof options.artifacts === 'string' ? options.artifacts : undefined);
  return resolve(cwd, configured ?? join('.consilium', 'runs'));
}

function assertNoPositionals(command: 'history' | 'stats', options: CLIOptions): void {
  const extra = options.task.trim();
  if (extra.length > 0) {
    throw new UsageError(`Команда ${command} не принимает позиционные аргументы: ${extra}`);
  }
}

function printWarnings(options: CLIOptions, warnings: readonly string[]): void {
  if (options.silent) return;
  for (const warning of warnings) {
    console.error(`⚠️ ${warning}`);
  }
}

function readEntries(
  options: CLIOptions,
  dependencies: HistoryCommandDependencies
): HistoryLoadResult {
  const cwd = dependencies.cwd ?? process.cwd();
  const loader = dependencies.loadHistory ?? loadHistory;
  const loaded = loader({
    dir: historyDir(options, cwd),
    limit: options.limit
  });
  printWarnings(options, loaded.warnings);
  return loaded;
}

/** Выполняет `consilium history [--limit N] [--json]`. */
export async function commandHistory(
  options: CLIOptions,
  dependencies: HistoryCommandDependencies = {}
): Promise<number> {
  assertNoPositionals('history', options);
  const loaded = readEntries(options, dependencies);

  if (options.json) {
    console.log(JSON.stringify(loaded.entries, null, 2));
    return EXIT_CODES.success;
  }

  console.log(formatHistoryTable(loaded.entries));
  return EXIT_CODES.success;
}

/** Выполняет `consilium stats [--json] [--html <файл>]`. */
export async function commandStats(
  options: CLIOptions,
  dependencies: HistoryCommandDependencies = {}
): Promise<number> {
  assertNoPositionals('stats', options);
  const cwd = dependencies.cwd ?? process.cwd();
  const loader = dependencies.loadHistory ?? loadHistory;
  const loaded = loader({ dir: historyDir(options, cwd) });
  printWarnings(options, loaded.warnings);

  const summary = summarizeHistory(loaded.entries);

  // --json имеет приоритет: HTML не пишется, даже если передан --html.
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return EXIT_CODES.success;
  }

  const htmlTarget = options.statsHtml;
  if (htmlTarget !== undefined) {
    if (htmlTarget.trim().length === 0) {
      throw new UsageError('Флаг --html требует непустой путь к файлу');
    }
    const target = resolve(cwd, htmlTarget);
    try {
      writeFileAtomic(target, renderStatsHtml(summary));
    } catch (error) {
      throw new UsageError(`Не удалось записать HTML-отчёт: ${errorMessage(error)}`);
    }
    console.log(target);
    return EXIT_CODES.success;
  }

  console.log(formatStats(summary));
  return EXIT_CODES.success;
}
