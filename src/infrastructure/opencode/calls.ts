/**
 * @fileoverview Вызовы агентов OpenCode: попытки, повторы, эксперты и председатель
 * @module lv24-opencode-consilium
 */

import type {
  AgentResult,
  AgentUsage,
  ConsiliumConfig,
  ExpertConfig
} from '../../domain/types.js';
import { resolveOpenCodeAgent } from '../config/config.js';
import { buildFallbackChain, shouldFallback } from '../../domain/council/fallback.js';
import { buildChairPrompt, buildExpertPrompt } from '../../domain/council/prompts.js';
import { buildAgentSession, buildChairSession } from '../../domain/council/sessions.js';
import { isValidAgentName, isValidModelName } from './args.js';
import {
  calculateRetryDelay,
  DEFAULT_CHAIR_TIMEOUT,
  DEFAULT_RETRY_DELAY,
  DEFAULT_TIMEOUT,
  isRetryable,
  nonNegativeInteger,
  positiveInteger,
  RATE_LIMIT_RETRY_WINDOW_MS,
  sanitizeRetries,
  sanitizeTimeout
} from './retry.js';
import { defaultController, type RunController } from './controller.js';
import { errorToMessage, invokeErrorHook, invokeHook, runAgentProcess } from './spawn.js';

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_EXPERT_TEXT = 3000;
const MAX_CONCURRENCY = 8;

interface AgentAttemptOptions {
  agentName: string;
  prompt: string;
  model?: string;
  sessionBase?: string;
  isChair?: boolean;
  fallbackModels?: string[];
  timeoutMs: number;
  attempt: number;
  controller: RunController;
  config: ConsiliumConfig;
}

/** Суммирует usage двух вызовов (токены и стоимость) */
function sumUsagePair(a?: AgentUsage, b?: AgentUsage): AgentUsage | undefined {
  if (a === undefined && b === undefined) return undefined;

  const usage: AgentUsage = {};
  const fields = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens'
  ] as const;
  for (const field of fields) {
    const total = (a?.[field] ?? 0) + (b?.[field] ?? 0);
    if (total > 0) usage[field] = total;
  }
  usage.cost = (a?.cost ?? 0) + (b?.cost ?? 0);
  return usage;
}

/** Суммирует usage двух попыток (токены и стоимость) */
function mergeAttemptUsage(previous: AgentResult, next: AgentResult): AgentResult {
  const usage = sumUsagePair(previous.usage, next.usage);
  return usage === undefined ? next : { ...next, usage };
}

/** Одна попытка вызова агента: fallback по моделям и при отсутствии агента */
async function callAgentOnce(options: AgentAttemptOptions): Promise<AgentResult> {
  const agentName = options.agentName.trim();
  if (agentName.length > 0 && !isValidAgentName(agentName)) {
    return {
      agent: options.agentName,
      text: '',
      success: false,
      errorCode: 'PARSE_ERROR',
      errorMessage: `Недопустимое имя агента: "${options.agentName}"`,
      attempt: options.attempt,
      exitCode: null
    };
  }

  const requestedModel = options.model?.trim();
  let model =
    requestedModel !== undefined && requestedModel.length > 0
      ? requestedModel
      : undefined;

  // OpenCode V2 не применяет модель агента из конфигурации при `run --agent`.
  // Заодно проверяем существование агента: для неизвестного имени сразу идём
  // default-агентом, иначе OpenCode создаст сессию с несуществующим агентом.
  let agentExists = agentName.length === 0;
  if (agentName.length > 0) {
    try {
      const resolved = resolveOpenCodeAgent(agentName, {
        opencodeConfigPath: options.config.opencodeConfigPath,
        cwd: options.config.cwd
      });
      agentExists = resolved.exists;
      if (
        model === undefined &&
        resolved.model !== undefined &&
        isValidModelName(resolved.model)
      ) {
        model = resolved.model;
      }
    } catch {
      // Конфигурация OpenCode недоступна: пусть модель и агента выбирает сам OpenCode
      agentExists = true;
    }
  }

  const agentArg = agentExists && agentName.length > 0 ? agentName : undefined;
  const sessionSuffix =
    agentName.length === 0 ? 'default' : agentExists ? agentName : `default-${agentName}`;
  const session = options.isChair === true
    ? buildChairSession(options.sessionBase)
    : buildAgentSession(options.sessionBase, sessionSuffix);

  if (model !== undefined && !isValidModelName(model)) {
    return {
      agent: options.agentName,
      text: '',
      success: false,
      errorCode: 'PARSE_ERROR',
      errorMessage: `Недопустимая модель: "${model}"`,
      attempt: options.attempt,
      exitCode: null
    };
  }

  let effectiveAgentArg = agentArg;
  let result = await runAgentProcess({
    agentName: options.agentName,
    agentArg: effectiveAgentArg,
    model,
    session,
    prompt: options.prompt,
    timeoutMs: options.timeoutMs,
    attempt: options.attempt,
    controller: options.controller,
    config: options.config
  });

  if (result.errorCode === 'AGENT_NOT_FOUND') {
    // Агент не найден: повторяем без --agent и с default-сессией.
    // Старую сессию не переиспользуем — OpenCode запомнил в ней несуществующего агента.
    const fallback = await runAgentProcess({
      agentName: options.agentName,
      agentArg: undefined,
      model,
      session: buildAgentSession(
        options.sessionBase,
        agentName.length > 0 ? `default-${agentName}` : 'default'
      ),
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
      attempt: options.attempt,
      controller: options.controller,
      config: options.config
    });
    if (model !== undefined) fallback.model = model;
    result = mergeAttemptUsage(result, fallback);
    effectiveAgentArg = undefined;
  }

  // Запасные модели: включаются только для RATE_LIMITED/MODEL_UNAVAILABLE/EMPTY_RESPONSE.
  const chain = buildFallbackChain(model, options.fallbackModels ?? [], { max: 2 });
  for (const candidate of chain) {
    if (result.success || !shouldFallback(result.errorCode)) break;
    if (options.controller.isCancelled()) break;

    const attempt = await runAgentProcess({
      agentName: options.agentName,
      agentArg: effectiveAgentArg,
      model: candidate,
      session,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
      attempt: options.attempt,
      controller: options.controller,
      config: options.config
    });
    attempt.model = candidate;
    result = mergeAttemptUsage(result, attempt);
    if (attempt.success) break;
  }

  return result;
}

function finalizeResult(
  result: AgentResult,
  startedAt: number,
  totalCost: number,
  hasCost: boolean,
  mergedUsage?: AgentUsage
): AgentResult {
  const usage: AgentUsage = { ...(mergedUsage ?? result.usage ?? {}) };
  if (hasCost) {
    usage.cost = totalCost;
  }
  return {
    ...result,
    duration: Date.now() - startedAt,
    usage
  };
}

function cancelledResult(agentName: string, attempt: number, model?: string): AgentResult {
  const result: AgentResult = {
    agent: agentName,
    text: '',
    success: false,
    errorCode: 'CANCELLED',
    errorMessage: 'Запуск отменён',
    attempt,
    exitCode: null
  };
  if (model !== undefined) {
    result.model = model;
  }
  return result;
}

/** Ожидание с проверкой отмены каждые 100 мс; false — отменено */
async function delayWithCancel(
  delayMs: number,
  controller: RunController
): Promise<boolean> {
  let remaining = delayMs;
  while (remaining > 0) {
    if (controller.isCancelled()) return false;
    const chunk = Math.min(100, remaining);
    await new Promise<void>(resolve => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
  return !controller.isCancelled();
}

/**
 * Вызывает одного агента с повторами и контролем отмены
 */
export async function callAgent(
  agentName: string,
  prompt: string,
  config: ConsiliumConfig,
  options: {
    timeout?: number;
    retries?: number;
    isChair?: boolean;
    model?: string;
    session?: string;
    fallbackModels?: string[];
    controller?: RunController;
  } = {}
): Promise<AgentResult> {
  const controller = options.controller ?? defaultController;
  const isChair = options.isChair === true;
  const sessionBase = options.session ?? config.session;
  const fallbackModels = options.fallbackModels ?? config.fallbackModels ?? [];

  const defaultTimeout = isChair
    ? sanitizeTimeout(config.timeouts?.chair, DEFAULT_CHAIR_TIMEOUT)
    : sanitizeTimeout(config.timeouts?.expert, DEFAULT_TIMEOUT);
  const timeoutMs = sanitizeTimeout(options.timeout, defaultTimeout);

  const defaultRetries = isChair
    ? nonNegativeInteger(config.retry?.chairRetries) ?? 1
    : nonNegativeInteger(config.retry?.expertRetries) ?? 1;
  const retries = sanitizeRetries(options.retries, defaultRetries);

  const delayMs = nonNegativeInteger(config.retry?.delay) ?? DEFAULT_RETRY_DELAY;
  const exponential = config.retry?.exponentialBackoff === true;
  const maxAttempts = retries + 1;
  const startedAt = Date.now();

  let totalCost = 0;
  let hasCost = false;
  let lastResult: AgentResult | undefined;
  let mergedUsage: AgentUsage | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (controller.isCancelled()) {
      return finalizeResult(
        cancelledResult(agentName, attempt, options.model),
        startedAt,
        totalCost,
        hasCost,
        mergedUsage
      );
    }

    if (attempt > 0) {
      const rateLimitDelay =
        lastResult?.errorCode === 'RATE_LIMITED' ? lastResult.retryAfterMs : undefined;
      const delay =
        rateLimitDelay !== undefined
          ? Math.min(rateLimitDelay, RATE_LIMIT_RETRY_WINDOW_MS)
          : calculateRetryDelay(
              attempt - 1,
              delayMs,
              exponential,
              config.retry?.jitter === true
            );
      const ready = await delayWithCancel(delay, controller);
      if (!ready) {
        return finalizeResult(
          cancelledResult(agentName, attempt, options.model),
          startedAt,
          totalCost,
          hasCost,
          mergedUsage
        );
      }
    }

    const result = await callAgentOnce({
      agentName,
      prompt,
      model: options.model,
      sessionBase,
      isChair,
      fallbackModels,
      timeoutMs,
      attempt,
      controller,
      config
    });

    const cost = result.usage?.cost;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      totalCost += cost;
      hasCost = true;
    }

    lastResult = result;
    mergedUsage = sumUsagePair(mergedUsage, result.usage);

    if (result.success) {
      return finalizeResult(result, startedAt, totalCost, hasCost, mergedUsage);
    }

    await invokeErrorHook(config, isChair, result);

    if (!isRetryable(result.errorCode, result.retryAfterMs)) {
      return finalizeResult(result, startedAt, totalCost, hasCost, mergedUsage);
    }
  }

  return finalizeResult(
    lastResult ?? {
      agent: agentName,
      text: '',
      success: false,
      errorCode: 'EXIT_ERROR',
      errorMessage: 'Все попытки исчерпаны'
    },
    startedAt,
    totalCost,
    hasCost,
    mergedUsage
  );
}

/**
 * Параллельно вызывает экспертов с ограничением конкурентности
 */
export async function callExpertsParallel(
  experts: ExpertConfig[],
  task: string,
  config: ConsiliumConfig,
  options: { controller?: RunController } = {}
): Promise<AgentResult[]> {
  const enabled = experts.filter(expert => expert.enabled !== false);
  const results: AgentResult[] = new Array<AgentResult>(enabled.length);
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    positiveInteger(config.retry?.maxConcurrency) ?? DEFAULT_MAX_CONCURRENCY
  );
  const controller = options.controller;

  const runExpert = async (expert: ExpertConfig): Promise<AgentResult> => {
    try {
      const prompt = buildExpertPrompt(expert, task);

      await invokeHook(
        config,
        () => config.hooks?.onExpertStart?.(expert.name, task),
        'onExpertStart'
      );

      const result = await callAgent(expert.name, prompt, config, {
        timeout: expert.timeout,
        retries: expert.retries,
        isChair: false,
        model: expert.model,
        controller
      });

      await invokeHook(
        config,
        () => config.hooks?.onExpertEnd?.(result),
        'onExpertEnd'
      );

      return result;
    } catch (error) {
      const result: AgentResult = {
        agent: expert.name,
        text: '',
        success: false,
        errorCode: 'SPAWN_ERROR',
        errorMessage: errorToMessage(error)
      };

      await invokeHook(
        config,
        () => config.hooks?.onExpertError?.(result),
        'onExpertError'
      );

      return result;
    }
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= enabled.length) return;
      results[index] = await runExpert(enabled[index]);
    }
  };

  const workerCount = Math.min(concurrency, enabled.length);
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

/**
 * Вызывает председателя по результатам экспертов
 */
export async function callChair(
  expertResults: AgentResult[],
  task: string,
  config: ConsiliumConfig,
  options: { controller?: RunController } = {}
): Promise<AgentResult> {
  const successful = expertResults.filter(result => result.success);

  if (successful.length === 0) {
    throw new Error(
      'Ни один эксперт не дал ответа — председатель не может синтезировать результат'
    );
  }

  const maxExpertTextLength =
    positiveInteger(config.chair?.maxExpertTextLength) ?? DEFAULT_MAX_EXPERT_TEXT;

  let prompt: string;
  const template = config.chair?.promptTemplate;
  if (template) {
    prompt = template(task, expertResults);
  } else {
    prompt = buildChairPrompt(
      task,
      expertResults,
      maxExpertTextLength,
      config.consensus === true
    );
  }

  await invokeHook(
    config,
    () => config.hooks?.onChairStart?.(task, expertResults),
    'onChairStart'
  );

  const result = await callAgent(config.chair.agent, prompt, config, {
    timeout: config.chair?.timeout,
    retries: config.retry?.chairRetries,
    isChair: true,
    model: config.chair?.model,
    controller: options.controller
  });

  await invokeHook(config, () => config.hooks?.onChairEnd?.(result), 'onChairEnd');

  return result;
}

/**
 * Получает список доступных агентов из конфигурации (обратная совместимость)
 */
export async function getAvailableAgents(): Promise<string[]> {
  const { loadConfig } = await import('../config/config.js');
  const { config } = loadConfig();
  return config.experts.map(expert => expert.name);
}
