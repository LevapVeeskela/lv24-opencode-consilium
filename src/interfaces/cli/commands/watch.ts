/**
 * @fileoverview Команда watch: перезапуск консилиума при изменениях в проекте
 * @module lv24-opencode-consilium/cli/commands/watch
 */

import { relative, resolve } from 'path';
import type { CLIOptions } from '../../../domain/types.js';
import { Consilium, loadConfig } from '../../../application/consilium.js';
import { getGitDiff, formatDiffForPrompt } from '../../../infrastructure/git.js';
import { createProjectWatcher } from '../../../infrastructure/watch.js';
import { resolveArtifactRoot } from '../../../infrastructure/artifacts/store.js';
import { UsageError } from '../args.js';
import { applyCliOverrides } from '../overrides.js';
import { readTaskFromFile } from '../task.js';
import { printDryRun, printResult, printSummary, writeRunReport } from '../output.js';

/**
 * Watch-режим: перезапускает консилиум при изменениях в проекте.
 */
export async function commandWatch(options: CLIOptions): Promise<number> {
  if (options.replay !== undefined) {
    throw new UsageError('watch не поддерживает --replay');
  }
  if (options.diffRuns !== undefined) {
    throw new UsageError('watch не поддерживает --diff-runs');
  }
  if (options.taskFile === '-') {
    throw new UsageError('watch не читает задачу из stdin (-)');
  }

  const loaded = loadConfig(options.config);
  if (!options.silent) {
    for (const warning of loaded.warnings) {
      console.error(`⚠️ ${warning}`);
    }
  }
  const config = applyCliOverrides(loaded.config, options);
  const cwd = config.cwd ?? process.cwd();
  const task =
    options.task.trim().length > 0 ? options.task.trim() : 'Сделай ревью текущих изменений';
  const debounceMs = config.debounceMs ?? 400;

  const ignore: string[] = [];
  const addIgnore = (value: string | undefined): void => {
    if (value === undefined || value.trim().length === 0) return;
    const target = resolve(cwd, value);
    const rel = relative(cwd, target);
    if (rel.length > 0 && !rel.startsWith('..')) {
      ignore.push(rel.replace(/\\/g, '/'));
    }
  };
  addIgnore(options.output ?? (typeof config.output.file === 'string' ? config.output.file : undefined));
  addIgnore(options.reportFile ?? config.reportFile);
  if (config.artifacts !== undefined && config.artifacts !== false) {
    try {
      addIgnore(resolveArtifactRoot({ artifacts: config.artifacts, cwd }));
    } catch {
      // Некорректный каталог артефактов отловит сам запуск
    }
  }

  if (!options.silent) {
    console.error(`👀 watch: ${cwd} (debounce ${debounceMs} мс), Ctrl+C — выход`);
    if (ignore.length > 0) console.error(`   игнорирую выводы: ${ignore.join(', ')}`);
  }

  let running = false;
  let closed = false;
  let suppressUntil = 0;
  let active: Consilium | undefined;

  const runOnce = async (): Promise<void> => {
    if (running || closed) {
      return;
    }
    running = true;
    try {
      let baseTask = task;
      if (options.taskFile !== undefined) {
        const fromFile = await readTaskFromFile(options.taskFile);
        if (fromFile.trim().length > 0) baseTask = fromFile.trim();
      }

      let fullTask = baseTask;
      try {
        const diff = await getGitDiff({
          cwd,
          staged: options.diffStaged,
          base: options.diffBase
        });
        if (diff.filesChanged > 0) {
          fullTask = `${baseTask}\n\n${formatDiffForPrompt(diff)}`;
        }
      } catch {
        // Вне git-репозитория работаем с задачей как есть
      }

      if (options.dryRun) {
        printDryRun(fullTask, config);
        return;
      }

      if (!options.silent) console.error('\n🔄 Запуск консилиума...');
      active = new Consilium(config);
      const result = await active.run(fullTask);
      const reportPrinted = writeRunReport(result, config, options);
      if (!reportPrinted) printResult(result, options);
      printSummary(result, options);
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
    } finally {
      active = undefined;
      running = false;
      // Гасим события от собственных записей (report/-o/redirect), которые
      // fs.watch может доставить уже после завершения прогона.
      suppressUntil = Date.now() + Math.max(1000, debounceMs + 300);
    }
  };

  let watcher: { close(): void };
  try {
    watcher = createProjectWatcher({
      cwd,
      debounceMs,
      ignore,
      onTrigger: () => {
        // Не ставим в очередь: иначе перенаправленный в проект stdout/stderr
        // запускает новый прогон после каждого завершения (бесконечный цикл).
        if (closed || running || Date.now() < suppressUntil) return;
        void runOnce();
      }
    });
  } catch (error) {
    console.error(`❌ Не удалось запустить watch: ${(error as Error).message}`);
    return 1;
  }

  await runOnce();

  await new Promise<void>(resolve => {
    const shutdown = (): void => {
      closed = true;
      active?.cancel();
      watcher.close();
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}
