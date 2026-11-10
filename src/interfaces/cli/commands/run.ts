/**
 * @fileoverview Команда run: запуск консилиума
 * @module lv24-opencode-consilium/cli/commands/run
 */

import type { CLIOptions, RunOptions } from '../../../domain/types.js';
import { Consilium, loadConfig } from '../../../application/consilium.js';
import { diffArtifacts, type ArtifactRun } from '../../../domain/artifacts/artifacts.js';
import {
  evaluatePolicyGate,
  formatPolicyGate,
  loadBaseline
} from '../../../domain/artifacts/baseline.js';
import { loadArtifact, resolveArtifactRoot } from '../../../infrastructure/artifacts/store.js';
import {
  applyReplayPlan,
  parseReplayExperts
} from '../../../application/replay.js';
import { EXIT_CODES, UsageError } from '../args.js';
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
  const loaded = loadConfig(options.config, { trustProjectConfig: options.config !== undefined });
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

  // Запоминаем настроенный каталог артефактов до применения --no-artifacts:
  // чтение --replay/--diff-runs не должно зависеть от флага сохранения.
  const configuredArtifacts = loaded.config.artifacts;
  const config = applyCliOverrides(loaded.config, options);
  if (config.output.logLevel === 'silent') {
    options.silent = true;
  }

  const failOn = options.failOn ?? 'none';
  if (failOn !== 'none' && config.findings !== true) {
    throw new UsageError(
      `Флаг --fail-on ${failOn} требует включённых находок: ` +
        'добавьте --findings или findings: true в конфигурацию.'
    );
  }

  if (options.listAgents) {
    printAgentList(config);
    return EXIT_CODES.success;
  }

  const artifactsSetting = options.noArtifacts
    ? false
    : options.artifacts ?? config.artifacts;
  const lookupArtifacts =
    typeof options.artifacts === 'string'
      ? options.artifacts
      : typeof configuredArtifacts === 'string'
        ? configuredArtifacts
        : undefined;
  const artifactsRoot = resolveArtifactRoot({
    artifacts: lookupArtifacts ?? true,
    cwd: config.cwd
  });

  if (options.diffRuns !== undefined) {
    const [leftId, rightId] = options.diffRuns;
    try {
      const left = loadArtifact(leftId, artifactsRoot);
      const right = loadArtifact(rightId, artifactsRoot);
      console.log(diffArtifacts(left, right));
      return EXIT_CODES.success;
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

    const requestedExperts = parseReplayExperts(options.experts);
    const replay = applyReplayPlan(config, replayArtifact, {
      chairAgent: config.chair.agent,
      artifacts: artifactsSetting,
      experts: requestedExperts
    });
    task = replay.plan.task;

    if (replay.emptySelection) {
      throw new UsageError(
        `В артефакте ${replayArtifact.id} нет экспертов: ${(requestedExperts ?? []).join(', ')}. ` +
          `Доступны: ${replay.plan.experts.map(expert => expert.name).join(', ')}`
      );
    }
    if (replay.missing.length > 0 && !options.silent) {
      console.error(`⚠️ Нет в артефакте: ${replay.missing.join(', ')}`);
    }

    if (!options.silent) {
      console.error(`↩️ Повтор артефакта ${replayArtifact.id} (${replayArtifact.createdAt})`);
      for (const warning of replay.plan.warnings) {
        console.error(`⚠️ ${warning}`);
      }
    }
  } else {
    const built = await buildTask(options, config);
    if (!built) {
      throw new UsageError(
        'Укажите задачу: consilium "Оценить архитектуру" (или передайте её через stdin: consilium -)'
      );
    }
    task = built;
  }

  if (options.dryRun) {
    printDryRun(task, config);
    return EXIT_CODES.success;
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

    if (!result.success) {
      return EXIT_CODES.runFailed;
    }

    if (failOn !== 'none') {
      const loadedBaseline = loadBaseline(process.cwd());
      if (loadedBaseline.warning !== undefined && !options.silent) {
        console.error(`⚠️ ${loadedBaseline.warning}`);
      }
      const gate = evaluatePolicyGate(
        result.metadata?.findings?.items,
        loadedBaseline.baseline,
        failOn
      );
      if (gate.failed) {
        console.error(formatPolicyGate(gate));
        return EXIT_CODES.policyGate;
      }
    }

    return EXIT_CODES.success;
  } catch (error) {
    console.error(`\n❌ Ошибка: ${(error as Error).message}`);
    return EXIT_CODES.runFailed;
  }
}
