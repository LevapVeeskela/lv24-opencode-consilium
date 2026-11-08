/**
 * @fileoverview Команда run: запуск консилиума
 * @module lv24-opencode-consilium/cli/commands/run
 */

import type { CLIOptions, RunOptions } from '../../../domain/types.js';
import { Consilium, loadConfig } from '../../../application/consilium.js';
import {
  diffArtifacts,
  loadArtifact,
  resolveArtifactRoot,
  type ArtifactRun
} from '../../../domain/artifacts/artifacts.js';
import { planReplay } from '../../../domain/artifacts/replay.js';
import { UsageError } from '../args.js';
import { applyCliOverrides } from '../overrides.js';
import { buildTask } from '../task.js';
import {
  printAgentList,
  printDryRun,
  printResult,
  printSummary,
  setupConsoleHooks,
  writeRunReport
} from '../output.js';

export async function commandRun(options: CLIOptions): Promise<number> {
  const loaded = loadConfig(options.config);
  if (options.config && (!loaded.configPath || (loaded.errors?.length ?? 0) > 0)) {
    throw new UsageError(
      loaded.errors?.[0] ?? `Файл конфигурации не найден: ${options.config}`
    );
  }
  if (!options.silent) {
    for (const warning of loaded.warnings) {
      console.error(`⚠️ ${warning}`);
    }
  }

  const config = applyCliOverrides(loaded.config, options);
  if (config.output.logLevel === 'silent') {
    options.silent = true;
  }

  if (options.listAgents) {
    printAgentList(config);
    return 0;
  }

  const artifactsSetting = options.noArtifacts
    ? false
    : options.artifacts ?? config.artifacts;
  const artifactsRoot = resolveArtifactRoot({
    artifacts:
      artifactsSetting !== undefined && artifactsSetting !== false ? artifactsSetting : true,
    cwd: config.cwd
  });

  if (options.diffRuns !== undefined) {
    const [leftId, rightId] = options.diffRuns;
    try {
      const left = loadArtifact(leftId, artifactsRoot);
      const right = loadArtifact(rightId, artifactsRoot);
      console.log(diffArtifacts(left, right));
      return 0;
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }

  let replayArtifact: ArtifactRun | undefined;
  let task: string;
  if (options.replay !== undefined) {
    try {
      replayArtifact = loadArtifact(options.replay, artifactsRoot);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }

    const plan = planReplay(replayArtifact, {
      chairAgent: config.chair.agent,
      artifacts: artifactsSetting
    });
    task = plan.task;

    const byName = new Map(config.experts.map(expert => [expert.name, expert]));
    config.experts = plan.experts.map((expert, index) => {
      const base = byName.get(expert.name) ?? {
        name: expert.name,
        enabled: true,
        priority: index + 1
      };
      return expert.model !== undefined ? { ...base, model: expert.model } : base;
    });

    if (options.experts !== undefined) {
      const requested = options.experts
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0);
      const wanted = new Set(requested);
      const filtered = config.experts.filter(expert => wanted.has(expert.name));

      if (filtered.length === 0) {
        throw new UsageError(
          `В артефакте ${replayArtifact.id} нет экспертов: ${requested.join(', ')}. ` +
            `Доступны: ${plan.experts.map(expert => expert.name).join(', ')}`
        );
      }
      const missing = requested.filter(
        name => !plan.experts.some(expert => expert.name === name)
      );
      if (missing.length > 0 && !options.silent) {
        console.error(`⚠️ Нет в артефакте: ${missing.join(', ')}`);
      }
      config.experts = filtered;
    }
    config.chair = { ...config.chair, agent: plan.chair.agent };
    if (plan.chair.model !== undefined) {
      config.chair = { ...config.chair, model: plan.chair.model };
    }
    if (plan.options.consensus !== undefined) config.consensus = plan.options.consensus;
    if (plan.options.smartExperts !== undefined) config.smartExperts = plan.options.smartExperts;
    if (plan.options.fallbackModels !== undefined) {
      config.fallbackModels = plan.options.fallbackModels;
    }
    if (plan.options.session !== undefined) config.session = plan.options.session;
    if (plan.options.artifacts !== undefined) config.artifacts = plan.options.artifacts;

    if (!options.silent) {
      console.error(`↩️ Повтор артефакта ${replayArtifact.id} (${replayArtifact.createdAt})`);
      for (const warning of plan.warnings) {
        console.error(`⚠️ ${warning}`);
      }
    }
  } else {
    const built = await buildTask(options);
    if (!built) {
      throw new UsageError(
        'Укажите задачу: consilium "Оценить архитектуру" (или передайте её через stdin: consilium -)'
      );
    }
    task = built;
  }

  if (options.dryRun) {
    printDryRun(task, config);
    return 0;
  }

  setupConsoleHooks(config, options);
  const consilium = new Consilium(config);
  if (options.verbose && !options.silent) {
    consilium.onProgress(event => {
      console.error(`[${new Date(event.timestamp).toISOString()}] ${event.type}`, event.agent ?? '');
    });
  }

  let cancelled = false;
  const shutdown = (): void => {
    if (cancelled) process.exit(130);
    cancelled = true;
    console.error('\n⏹️ Отмена...');
    consilium.cancel();
    setTimeout(() => process.exit(130), Math.max(1000, config.timeouts.shutdown)).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const runOptions: RunOptions = {};
  if (options.chair) runOptions.chair = options.chair;
  if (options.output && !options.noSave) runOptions.outputFile = options.output;
  if (replayArtifact !== undefined) {
    runOptions.metadata = { replayOf: replayArtifact.id };
  }

  try {
    const result = await consilium.run(task, runOptions);
    const reportPrinted = writeRunReport(result, config, options);
    if (!reportPrinted) printResult(result, options);
    printSummary(result, options);
    return result.success ? 0 : 1;
  } catch (error) {
    console.error(`\n❌ Ошибка: ${(error as Error).message}`);
    return 1;
  }
}
