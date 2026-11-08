/**
 * @fileoverview Помощники оркестрации запуска Consilium: выбор участников,
 * сборка результата, отмена, стоимость, вывод и артефакты.
 * @module lv24-opencode-consilium
 */

import { writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import type {
  AgentResult,
  ConsiliumConfig,
  ConsiliumResult
} from '../domain/types.js';
import { analyzeConsensus, formatConsensusReport } from '../domain/council/consensus.js';
import type { SmartExpertSelection } from '../domain/council/smart-experts.js';
import type { CostReport } from '../domain/council/fallback.js';
import type { ArtifactRun } from '../domain/artifacts/artifacts.js';
import {
  createArtifactId,
  resolveArtifactRoot,
  saveArtifact
} from '../infrastructure/artifacts/store.js';
import { collectModels, collectSessions, consensusInputs, sumUsage } from './helpers.js';

/** Выбирает экспертов с учётом явного запроса и включённости */
export function selectExperts(
  config: ConsiliumConfig,
  requested: string[] | undefined,
  hooks: ConsiliumConfig['hooks']
): ConsiliumConfig['experts'] {
  if (requested && requested.length > 0) {
    const wanted = new Set(requested);
    const available = new Set(config.experts.map(expert => expert.name));
    const missing = requested.filter(name => !available.has(name));
    if (missing.length > 0) {
      hooks?.onLog?.('warn', `Неизвестные эксперты пропущены: ${missing.join(', ')}`);
    }
    const experts = config.experts.filter(
      expert => wanted.has(expert.name) && expert.enabled !== false
    );
    if (experts.length === 0) {
      throw new Error(
        `Выбранные эксперты недоступны: ${requested.join(', ')}. Доступны: ${[...available].join(', ')}`
      );
    }
    return experts;
  }

  const experts = config.experts.filter(expert => expert.enabled !== false);
  if (experts.length === 0) {
    throw new Error('Нет активных экспертов для консилиума');
  }
  return experts;
}

/** Разрешает председателя запуска и при смене агента сбрасывает модель */
export function selectChairAgent(config: ConsiliumConfig, requested: string | undefined): string {
  const configuredChair = config.chair.agent;
  const chairAgent = requested ?? configuredChair;
  if (chairAgent !== configuredChair) {
    // Модель была выбрана для другого агента: переразрешаем её для нового.
    config.chair = { ...config.chair, agent: chairAgent, model: undefined };
  } else {
    config.chair.agent = chairAgent;
  }
  return chairAgent;
}

/** Формирует результат отменённого запуска */
export function createCancelledResult(
  experts: AgentResult[],
  chair: AgentResult | undefined,
  parallelTime: number,
  startTime: number,
  config: ConsiliumConfig
): ConsiliumResult {
  return {
    text: '[Консилиум отменён]',
    experts,
    chair: chair || {
      agent: config.chair.agent,
      text: '[Отменено]',
      success: false,
      errorCode: 'CANCELLED'
    },
    totalTime: Date.now() - startTime,
    parallelTime,
    success: false,
    usage: sumUsage(chair ? [...experts, chair] : experts),
    metadata: { cancelled: true }
  };
}

/** Дополняет метаданные отменённого запуска */
export function buildCancelledMetadata(
  experts: AgentResult[],
  chair: AgentResult | undefined,
  metadata: Record<string, unknown> | undefined,
  cost: CostReport,
  session: string | undefined
): Record<string, unknown> {
  const results = chair ? [...experts, chair] : experts;
  return {
    ...metadata,
    models: collectModels(results),
    sessions: collectSessions(results),
    cost,
    ...(session ? { session } : {})
  };
}

/** Входные данные для сборки успешного результата */
export interface BuildCompletedResultInput {
  experts: AgentResult[];
  chair: AgentResult;
  parallelTime: number;
  startTime: number;
  metadata?: Record<string, unknown>;
  cost: CostReport;
  costExceeded: boolean;
  consensusEnabled: boolean;
  smartSelection?: SmartExpertSelection;
  session?: string;
  fallbackModels: string[];
}

/** Собирает итоговый результат запуска с согласием, стоимостью и метаданными */
export function buildCompletedResult(input: BuildCompletedResultInput): ConsiliumResult {
  const results = [...input.experts, input.chair];
  const models = collectModels(results);
  const sessions = collectSessions(results);

  const consensusReport = input.consensusEnabled
    ? analyzeConsensus(consensusInputs(input.experts))
    : undefined;
  const consensusText = consensusReport
    ? `\n\n---\n\n${formatConsensusReport(consensusReport)}`
    : '';

  return {
    text: `${input.chair.text}${consensusText}`.trim(),
    experts: input.experts,
    chair: input.chair,
    totalTime: Date.now() - input.startTime,
    parallelTime: input.parallelTime,
    success: input.chair.success,
    usage: sumUsage(results),
    metadata: {
      ...input.metadata,
      models,
      cost: input.cost,
      ...(input.costExceeded ? { costExceeded: true } : {}),
      ...(consensusReport ? { consensus: consensusReport } : {}),
      ...(input.smartSelection
        ? {
            smartExperts: {
              dropped: input.smartSelection.dropped,
              scores: input.smartSelection.scores,
              reasons: input.smartSelection.reasons
            }
          }
        : {}),
      ...(input.session ? { session: input.session } : {}),
      ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
      ...(input.fallbackModels.length > 0 ? { fallbackModels: input.fallbackModels } : {})
    }
  };
}

/** Предупреждает, что провайдер не сообщил стоимость и лимит не проверить */
export function applyCostTelemetryWarning(
  result: ConsiliumResult,
  maxCost: number | undefined,
  hooks: ConsiliumConfig['hooks'] | undefined
): void {
  if (maxCost === undefined) return;

  const hasCostTelemetry = [...result.experts, result.chair].some(
    item => typeof item.usage?.cost === 'number'
  );
  if (!hasCostTelemetry) {
    hooks?.onLog?.(
      'warn',
      'Провайдер не сообщил стоимость запуска: лимит maxCost невозможно проверить.'
    );
    result.metadata = { ...result.metadata, costTelemetry: 'missing' };
  }
}

/** Форматирует результат в markdown для сохранения */
function formatAsMarkdown(result: ConsiliumResult): string {
  let md = `# Результат консилиума\n\n`;
  md += `**Время выполнения:** ${(result.totalTime / 1000).toFixed(1)}с\n\n`;
  if (result.usage?.cost) {
    md += `**Стоимость:** $${result.usage.cost.toFixed(6)}\n\n`;
  }
  md += `---\n\n`;
  md += result.text;
  md += `\n\n---\n\n`;
  md += `## Мнения экспертов\n\n`;

  for (const expert of result.experts) {
    const model = expert.model ? ` (${expert.model})` : '';
    md += `### ${expert.agent.toUpperCase()}${model}\n`;
    md += `${expert.success ? '' : '⚠️ '}${expert.text}\n\n`;
  }

  return md;
}

/** Сохраняет результат в файл; возвращает полный путь */
export function saveResult(
  result: ConsiliumResult,
  outputPath: string,
  config: ConsiliumConfig
): string {
  const baseDir = config.cwd ? resolve(config.cwd) : process.cwd();
  const fullPath = resolve(baseDir, outputPath);
  const dir = dirname(fullPath);

  if (outputPath.trim().length === 0) {
    throw new Error('Пустой путь для сохранения результата');
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let content: string;
  switch (config.output.format) {
    case 'json':
      content = JSON.stringify(result, null, 2);
      break;
    case 'markdown':
      content = formatAsMarkdown(result);
      break;
    default:
      content = result.text;
  }

  const temporary = `${fullPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, content, 'utf-8');
    renameSync(temporary, fullPath);
  } catch (error) {
    try {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    } catch {
      // Очистка необязательна
    }
    throw error;
  }
  return fullPath;
}

/**
 * Сохраняет артефакт запуска, если он включён.
 * Ошибка сохранения не должна ломать сам запуск.
 */
export function saveArtifactRun(
  result: ConsiliumResult,
  task: string,
  setting: boolean | string | undefined,
  runConfig: ConsiliumConfig,
  hooks: ConsiliumConfig['hooks'] | undefined
): void {
  if (setting === undefined || setting === false) return;

  try {
    const metadata = result.metadata ?? {};
    const metaModels = metadata.models;
    const models =
      metaModels !== null && typeof metaModels === 'object' && !Array.isArray(metaModels)
        ? (metaModels as Record<string, string>)
        : collectModels([...result.experts, result.chair]);
    const run: ArtifactRun = {
      version: 1,
      id: createArtifactId(),
      createdAt: new Date().toISOString(),
      task,
      success: result.success,
      text: result.text,
      experts: result.experts.map(expert => ({
        agent: expert.agent,
        model: expert.model,
        success: expert.success,
        errorCode: expert.errorCode,
        errorMessage: expert.errorMessage,
        duration: expert.duration,
        text: expert.text,
        usage: expert.usage
      })),
      models,
      chairAgent: result.chair.agent,
      usage: result.usage,
      consensus: metadata.consensus,
      metadata
    };

    const root = resolveArtifactRoot({ artifacts: setting, cwd: runConfig.cwd });
    const ref = saveArtifact(run, { root });
    result.metadata = {
      ...metadata,
      artifacts: { id: ref.id, dir: ref.dir }
    };
  } catch (error) {
    result.metadata = {
      ...(result.metadata ?? {}),
      artifactsError: (error as Error).message
    };
    hooks?.onLog?.('warn', `Не удалось сохранить артефакт: ${(error as Error).message}`);
  }
}
