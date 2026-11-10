/**
 * @fileoverview Команда watch: перезапуск консилиума при изменениях в проекте
 * @module lv24-opencode-consilium/cli/commands/watch
 */

import { relative, resolve } from 'path';
import type { CLIOptions, RunOptions } from '../../../domain/types.js';
import { Consilium, loadConfig } from '../../../application/consilium.js';
import { getGitDiff, formatDiffForPrompt } from '../../../infrastructure/git.js';
import { createProjectWatcher } from '../../../infrastructure/watch.js';
import { resolveArtifactRoot } from '../../../infrastructure/artifacts/store.js';
import { UsageError } from '../args.js';
import { applyCliOverrides } from '../overrides.js';
import { READ_ONLY_OVERLAY_RELATIVE_PATH } from '../../../infrastructure/opencode/read-only.js';
import { ISOLATE_WORKTREES_RELATIVE_PATH } from '../../../infrastructure/opencode/isolate.js';
import { readTaskFromFile, appendTaskContext } from '../task.js';
import {
  printAgentList,
  printDryRun,
  printResult,
  printSummary,
  writeRunReport
} from '../output.js';

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

  const loaded = loadConfig(options.config, { trustProjectConfig: options.config !== undefined });
  if (!options.silent) {
    for (const warning of loaded.warnings) {
      console.error(`⚠️ ${warning}`);
    }
  }
  const config = applyCliOverrides(loaded.config, options);
  if (options.listAgents) {
    printAgentList(config);
    return 0;
  }
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
  // Временный read-only слой пишется и снимается каждым прогоном:
  // без ignore watch зациклится на собственных изменениях.
  if (config.readOnly === true) {
    ignore.push(READ_ONLY_OVERLAY_RELATIVE_PATH);
  }
  // Изолированные worktree создаются и удаляются на каждом вызове агента.
  if (config.isolate === true) {
    ignore.push(ISOLATE_WORKTREES_RELATIVE_PATH);
  }

  if (!options.silent) {
    console.error(`👀 watch: ${cwd} (debounce ${debounceMs} мс), Ctrl+C — выход`);
    if (ignore.length > 0) console.error(`   игнорирую выводы: ${ignore.join(', ')}`);
  }

  let running = false;
  let pendingRerun = false;
  let closed = false;
  let active: Consilium | undefined;

  const runOptions: RunOptions = {};
  if (options.chair) runOptions.chair = options.chair;
  if (options.output && !options.noSave) runOptions.outputFile = options.output;

  const runOnce = async (): Promise<void> => {
    if (closed) {
      return;
    }
    if (running) {
      pendingRerun = true;
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
      let diffText: string | undefined;
      try {
        const diff = await getGitDiff({
          cwd,
          staged: options.diffStaged,
          base: options.diffBase
        });
        diffText = diff.diff;
        if (diff.filesChanged > 0) {
          fullTask = `${baseTask}\n\n${formatDiffForPrompt(diff)}`;
        }
      } catch {
        // Вне git-репозитория работаем с задачей как есть
      }
      fullTask = await appendTaskContext(options, config, fullTask, diffText);

      if (options.dryRun) {
        printDryRun(fullTask, config);
        return;
      }
      if (closed) {
        return;
      }

      if (!options.silent) console.error('\n🔄 Запуск консилиума...');
      active = new Consilium(config);
      if (closed) {
        return;
      }
      const result = await active.run(fullTask, runOptions);
      const reportPrinted = writeRunReport(result, config, options);
      if (!reportPrinted) printResult(result, options);
      printSummary(result, options);
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
    } finally {
      active = undefined;
      running = false;
      // Правки, пришедшие во время прогона, не теряем: один повтор после старта.
      if (pendingRerun && !closed) {
        pendingRerun = false;
        void runOnce();
      }
    }
  };

  let watcher: { close(): void };
  try {
    watcher = createProjectWatcher({
      cwd,
      debounceMs,
      ignore,
      onTrigger: () => {
        if (closed) return;
        if (running) {
          pendingRerun = true;
          return;
        }
        void runOnce();
      }
    });
  } catch (error) {
    console.error(`❌ Не удалось запустить watch: ${(error as Error).message}`);
    return 1;
  }

  // Обработчики ставим до первого прогона: Ctrl+C должен отменять и его.
  const shutdownPromise = new Promise<void>(resolveShutdown => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      if (closed) return;
      closed = true;
      pendingRerun = false;
      active?.cancel();
      watcher.close();
      resolveShutdown();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  await runOnce();
  await shutdownPromise;

  return 0;
}
