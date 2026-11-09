/**
 * @fileoverview Второй раунд дебатов: анонимное ревью ответов коллег,
 * финальные позиции и заметка председателю.
 * @module lv24-opencode-consilium
 */

import type {
  AgentResult,
  AgentUsage,
  ConsiliumConfig,
  ExpertConfig
} from '../domain/types.js';
import type { CostTracker } from '../domain/council/fallback.js';
import {
  appendFindingsInstruction,
  buildChairPrompt,
  buildDebatePrompt,
  hasPositionChanged,
  normalizeDebateText
} from '../domain/council/prompts.js';
import { callAgent } from '../infrastructure/opencode/agents.js';
import type { RunController } from '../infrastructure/opencode/controller.js';
import { positiveInteger } from '../infrastructure/opencode/retry.js';

const DEFAULT_DEBATE_CONCURRENCY = 3;
const MAX_DEBATE_CONCURRENCY = 8;
const DEFAULT_DEBATE_CHAIR_TEXT = 3000;

/** Метаданные состоявшегося второго раунда */
export interface DebateMetadata {
  rounds: 2;
  /** Имена экспертов, участвовавших в дебатах */
  participants: string[];
  /** Имена экспертов, изменивших позицию по нормализованному тексту */
  changed: string[];
}

/** Результат второго раунда */
export interface DebateOutcome {
  /** Итоговые результаты: round-2 где он есть, иначе round-1 */
  results: AgentResult[];
  metadata: DebateMetadata;
  /** Компактная заметка для промпта председателя */
  note: string;
}

/** Сигнатура вызова агента; инъекция нужна для unit-тестов */
export type DebateCallAgent = typeof callAgent;

/** Опции запуска второго раунда */
export interface DebateRoundOptions {
  /** Запрошенное число раундов; всё, кроме 2, отключает дебаты */
  rounds?: number;
  controller?: RunController;
  costTracker?: CostTracker;
  /** Переопределение callAgent в тестах */
  callAgent?: DebateCallAgent;
}

/** Допустимое число раундов: только 1 или 2 */
export function normalizeDebateRounds(value: number | undefined): 1 | 2 {
  return value === 2 ? 2 : 1;
}

/** Собирает metadata.debate */
export function buildDebateMetadata(
  participants: string[],
  changed: string[]
): DebateMetadata {
  return {
    rounds: 2,
    participants: [...participants],
    changed: [...changed]
  };
}

/** Компактная заметка председателю об итогах peer-review */
export function buildDebateChairNote(changed: string[]): string {
  return changed.length > 0
    ? `Debate review (round 2): position changed: ${changed.join(', ')}`
    : 'Debate review (round 2): no expert changed their final position';
}

/** Верхняя граница конкурентности второго раунда — как у экспертов */
function debateConcurrency(config: ConsiliumConfig): number {
  const configured = positiveInteger(config.retry?.maxConcurrency);
  return Math.min(MAX_DEBATE_CONCURRENCY, configured ?? DEFAULT_DEBATE_CONCURRENCY);
}

/** Суммирует usage первого и второго раундов */
function mergeUsage(
  first: AgentUsage | undefined,
  second: AgentUsage | undefined
): AgentUsage | undefined {
  if (first === undefined && second === undefined) return undefined;

  const usage: AgentUsage = {};
  const fields = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens'
  ] as const;
  for (const field of fields) {
    const total = (first?.[field] ?? 0) + (second?.[field] ?? 0);
    if (total > 0) usage[field] = total;
  }

  const firstCost =
    typeof first?.cost === 'number' && Number.isFinite(first.cost) ? first.cost : undefined;
  const secondCost =
    typeof second?.cost === 'number' && Number.isFinite(second.cost)
      ? second.cost
      : undefined;
  if (firstCost !== undefined || secondCost !== undefined) {
    usage.cost = (firstCost ?? 0) + (secondCost ?? 0);
  }

  return usage;
}

/**
 * Запускает второй раунд для всех успешных экспертов первого раунда.
 *
 * Возвращает undefined, если дебаты не нужны: rounds !== 2, успешных
 * экспертов меньше двух, запуск отменён или лимит стоимости уже превышен.
 * При отмене/дедлайне во время второго раунда готовые ответы используются,
 * а для остальных экспертов остаётся ответ первого раунда.
 */
export async function runDebateRound(
  round1: AgentResult[],
  task: string,
  config: ConsiliumConfig,
  options: DebateRoundOptions = {}
): Promise<DebateOutcome | undefined> {
  const requestedRounds = options.rounds ?? config.rounds;
  if (normalizeDebateRounds(requestedRounds) !== 2) return undefined;

  const participants = round1.filter(result => result.success === true);
  if (participants.length < 2) return undefined;
  if (options.controller?.isCancelled() === true) return undefined;

  const expertByName = new Map(config.experts.map(expert => [expert.name, expert]));

  if (options.costTracker?.exceeded() === true) {
    config.hooks?.onLog?.(
      'warn',
      'Лимит стоимости уже превышен: второй раунд дебатов пропущен, используются ответы первого раунда'
    );
    return undefined;
  }

  const invoke = options.callAgent ?? callAgent;
  const concurrency = debateConcurrency(config);
  const round2 = new Array<AgentResult | undefined>(participants.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.controller?.isCancelled() === true) return;

      const index = nextIndex;
      nextIndex += 1;
      if (index >= participants.length) return;

      const participant = participants[index];
      const expert: ExpertConfig = expertByName.get(participant.agent) ?? {
        name: participant.agent,
        model: participant.model
      };
      const prompt = buildDebatePrompt(
        task,
        participant.agent,
        round1,
        config.findings === true
      );

      try {
        round2[index] = await invoke(participant.agent, prompt, config, {
          timeout: expert.timeout,
          retries: expert.retries,
          isChair: false,
          model: expert.model,
          session: config.session,
          controller: options.controller
        });
      } catch (error) {
        round2[index] = {
          agent: participant.agent,
          text: '',
          success: false,
          errorCode: 'SPAWN_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };

  const workerCount = Math.min(concurrency, participants.length);
  const workers: Array<Promise<void>> = [];
  for (let index = 0; index < workerCount; index++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Стоимость неудачных попыток второго раунда тоже учитывается.
  for (const result of round2) {
    if (result !== undefined) {
      options.costTracker?.add(result.agent, result.usage);
    }
  }

  const secondByAgent = new Map<string, AgentResult>();
  const changed: string[] = [];
  for (let index = 0; index < participants.length; index++) {
    const first = participants[index];
    const second = round2[index];
    if (second === undefined || second.success !== true) continue;

    secondByAgent.set(first.agent, second);
    if (hasPositionChanged(first.text, second.text)) {
      changed.push(first.agent);
    }
  }

  const results = round1.map(result => {
    if (result.success !== true) return result;
    const second = secondByAgent.get(result.agent);
    if (second === undefined) return result;

    const merged: AgentResult = {
      ...second,
      usage: mergeUsage(result.usage, second.usage)
    };
    if (result.duration !== undefined || second.duration !== undefined) {
      merged.duration = (result.duration ?? 0) + (second.duration ?? 0);
    }
    return merged;
  });

  const participantNames = participants.map(result => result.agent);
  return {
    results,
    metadata: buildDebateMetadata(participantNames, changed),
    note: buildDebateChairNote(changed)
  };
}

/**
 * Возвращает копию конфигурации, чей промпт председателя дополнен заметкой
 * о втором раунде. Пользовательский шаблон и инструкция findings сохраняются.
 */
export function withDebateChairNote(
  config: ConsiliumConfig,
  note: string
): ConsiliumConfig {
  const template = config.chair.promptTemplate;
  const maxExpertTextLength =
    positiveInteger(config.chair.maxExpertTextLength) ?? DEFAULT_DEBATE_CHAIR_TEXT;
  const consensus = config.consensus === true;
  const findings = config.findings === true;

  return {
    ...config,
    chair: {
      ...config.chair,
      promptTemplate: (task, experts) => {
        let prompt = template
          ? template(task, experts)
          : buildChairPrompt(task, experts, maxExpertTextLength, consensus, findings);
        if (findings) prompt = appendFindingsInstruction(prompt, 'chair');
        return `${prompt}\n\n${note}`;
      }
    }
  };
}

// Повторно экспортируем чистые помощники, чтобы их можно было тестировать
// и использовать из слоя приложения без импорта domain-модуля.
export { hasPositionChanged, normalizeDebateText };
