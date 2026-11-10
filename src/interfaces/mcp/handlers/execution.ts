// Shared MCP execution path for consilium_run and consilium_replay:
// progress notifications, active-run state, result formatting and errors.
import { Consilium } from '../../../application/consilium.js';
import { selectExperts } from '../../../application/run.js';
import { selectSmartExperts } from '../../../domain/council/smart-experts.js';
import type {
  ConsiliumConfig,
  ConsiliumResult,
  ProgressEvent,
  RunOptions
} from '../../../domain/types.js';
import { truncateText } from '../format.js';
import { emitNotification } from '../protocol.js';
import type { ProgressToken, RequestId } from '../protocol.js';
import {
  clearActiveConsilium,
  describeError,
  setActiveConsilium,
  toolError
} from './shared.js';
import type { McpToolResult } from './shared.js';

/** Дополнительный блок предупреждений в конце результата */
export interface WarningSection {
  heading: string;
  items: string[];
}

/** Собирает карту фактически использованных моделей */
function collectResultModels(result: ConsiliumResult): Record<string, string> {
  const fromMetadata = result.metadata?.models;
  if (
    fromMetadata !== null &&
    typeof fromMetadata === 'object' &&
    !Array.isArray(fromMetadata)
  ) {
    const entries = Object.entries(fromMetadata as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    );
    if (entries.length > 0) {
      return Object.fromEntries(entries);
    }
  }

  const models: Record<string, string> = {};
  for (const item of [...result.experts, result.chair]) {
    if (typeof item.model === 'string' && item.model.length > 0) {
      models[item.agent] = item.model;
    }
  }
  return models;
}

/** Человекочитаемый результат консилиума: текст, мнения экспертов и JSON-сводка. */
export function formatConsiliumResult(result: ConsiliumResult, config: ConsiliumConfig): string {
  const sections: string[] = [result.text, '---', '## Мнения экспертов'];

  for (const expert of result.experts) {
    sections.push(`### ${expert.agent} (${expert.model ?? 'default'})`);
    sections.push(truncateText(expert.text, 4000));
  }

  sections.push('---');
  const replayOf = result.metadata?.replayOf;
  const summary = {
    success: result.success,
    totalTime: result.totalTime,
    parallelTime: result.parallelTime,
    usage: result.usage,
    cost: result.metadata?.cost,
    models: collectResultModels(result),
    deadlineMs: config.deadlineMs ?? null,
    deadline: result.metadata?.deadline,
    rounds: config.rounds ?? 1,
    debate: result.metadata?.debate,
    localOnly: config.localOnly === true,
    safety: result.metadata?.safety ?? {
      readOnly: config.readOnly === true,
      isolate: config.isolate === true
    },
    consensus:
      result.metadata?.consensus !== null && typeof result.metadata?.consensus === 'object'
        ? (() => {
            const report = result.metadata.consensus as {
              agreement?: unknown;
              averageSimilarity?: unknown;
            };
            return {
              agreement: report.agreement,
              averageSimilarity: report.averageSimilarity
            };
          })()
        : undefined,
    findings: result.metadata?.findings,
    ...(typeof replayOf === 'string' ? { replayOf } : {}),
    experts: result.experts.map((expert) => ({
      agent: expert.agent,
      model: expert.model,
      success: expert.success,
      duration: expert.duration,
      errorCode: expert.errorCode,
      usage: expert.usage
    }))
  };
  sections.push('```json');
  sections.push(JSON.stringify(summary, null, 2));
  sections.push('```');

  const savedFile = result.metadata?.savedFile;
  const saveError = result.metadata?.saveError;
  if (typeof savedFile === 'string') {
    sections.push(`**Saved to:** \`${savedFile}\``);
  } else if (typeof saveError === 'string') {
    sections.push(`**Save failed:** ${saveError}`);
  }

  const artifacts = result.metadata?.artifacts;
  if (artifacts !== null && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
    const dir = (artifacts as { dir?: unknown }).dir;
    if (typeof dir === 'string') {
      sections.push(`**Artifacts:** \`${dir}\``);
    }
  }

  return sections.join('\n\n');
}

/**
 * Считает фактический размер совета для прогресса: явные эксперты, disabled
 * и smart-выбор уже применены. Возвращает число экспертов + председатель.
 */
export function computeProgressTotal(
  config: ConsiliumConfig,
  requestedExperts: string[] | undefined,
  task: string
): number {
  try {
    const selected = selectExperts(config, requestedExperts, undefined);
    const council =
      config.smartExperts === true
        ? selectSmartExperts(selected, task, { onLog: () => {} }).experts
        : selected;
    return Math.max(1, council.length) + 1;
  } catch {
    const enabled = config.experts.filter((expert) => expert.enabled !== false).length;
    return Math.max(1, enabled) + 1;
  }
}

/**
 * Подписывает консилиум на MCP `notifications/progress`.
 * Возвращает функцию отписки или undefined, если progressToken не передан.
 * Поток данных — только события прогресса, без частичных result-чанков.
 */
export function attachProgressNotifications(
  consilium: Consilium,
  total: number,
  progressToken: ProgressToken | undefined
): (() => void) | undefined {
  if (progressToken === undefined) return undefined;

  let startedExperts = 0;

  return consilium.onProgress((event: ProgressEvent) => {
    let progress: number;
    let message: string;
    if (event.type === 'expert_start') {
      startedExperts += 1;
      progress = Math.min(startedExperts, Math.max(1, total - 1));
      message = `Expert ${event.agent ?? ''} started`.trim();
    } else if (event.type === 'chair_start') {
      progress = Math.max(1, total - 1);
      message = 'Chair is synthesizing the final answer';
    } else if (event.type === 'chair_end') {
      progress = total;
      message = 'Consilium completed';
    } else if (event.type === 'error') {
      progress = Math.min(startedExperts, Math.max(0, total - 1));
      message = 'Consilium failed';
    } else {
      return;
    }

    emitNotification({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken,
        progress,
        total,
        message
      }
    });
  });
}

/** Входные данные общего пути выполнения консилиума */
export interface ConsiliumExecutionInput {
  config: ConsiliumConfig;
  task: string;
  runOptions: RunOptions;
  progressToken?: ProgressToken;
  requestId?: RequestId;
  /** Дополнительные блоки предупреждений после результата */
  warningSections?: WarningSection[];
  /** Префикс ошибки инструмента */
  errorPrefix?: string;
}

/**
 * Запускает Consilium с общими для всех MCP-инструментов прогрессом,
 * активным состоянием (для notifications/cancelled) и форматированием.
 */
export async function runConsiliumWithProgress(
  input: ConsiliumExecutionInput
): Promise<McpToolResult> {
  const consilium = new Consilium(input.config);
  const total = computeProgressTotal(
    input.config,
    input.runOptions.experts,
    input.task
  );
  const unsubscribe = attachProgressNotifications(
    consilium,
    total,
    input.progressToken
  );

  setActiveConsilium(consilium, input.requestId);
  try {
    const result = await consilium.run(input.task, input.runOptions);
    let text = formatConsiliumResult(result, input.config);
    for (const section of input.warningSections ?? []) {
      if (section.items.length === 0) continue;
      text += `\n\n---\n\n**${section.heading}**\n${section.items.map(item => `- ${item}`).join('\n')}`;
    }
    return {
      content: [{ type: 'text', text }],
      isError: result.success === false
    };
  } catch (error) {
    return toolError(`${input.errorPrefix ?? 'Consilium run'} failed: ${describeError(error)}`);
  } finally {
    if (unsubscribe !== undefined) unsubscribe();
    clearActiveConsilium(consilium);
  }
}
