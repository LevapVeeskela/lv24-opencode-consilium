/**
 * @fileoverview Проверка доступности бесплатных моделей реальным вызовом
 * @module opencode-consilium
 */

import { callAgent } from './agents.js';
import { mergeWithDefaults } from './config.js';
import type { ConsiliumConfig } from './types.js';
import type { FreeModel } from './models.js';

/** Результат проверки одной модели */
export interface ModelVerification {
  model: FreeModel;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface VerifyModelsOptions {
  concurrency?: number;
  timeoutMs?: number;
  cwd?: string;
  opencodePath?: string;
  prompt?: string;
}

function clampConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(8, Math.floor(value)));
}

/**
 * Проверяет модели коротким реальным запросом через OpenCode.
 * Возвращает результаты в исходном порядке.
 */
export async function verifyModels(
  models: FreeModel[],
  options: VerifyModelsOptions = {}
): Promise<ModelVerification[]> {
  if (models.length === 0) return [];

  const concurrency = clampConcurrency(options.concurrency);
  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 60000;
  const prompt = options.prompt ?? 'Ответь ровно одним словом: ок. Не вызывай инструменты.';

  const config: ConsiliumConfig = mergeWithDefaults({
    cwd: options.cwd,
    opencodePath: options.opencodePath,
    standalone: true,
    timeouts: { expert: timeoutMs, chair: timeoutMs, shutdown: 1000 },
    retry: {
      expertRetries: 0,
      chairRetries: 0,
      delay: 0,
      exponentialBackoff: false,
      maxConcurrency: concurrency
    }
  });

  const results: ModelVerification[] = new Array<ModelVerification>(models.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= models.length) return;

      const model = models[index];
      const result = await callAgent('', prompt, config, {
        timeout: timeoutMs,
        retries: 0,
        model: model.id
      });

      results[index] = {
        model,
        ok: result.success,
        ms: result.duration ?? 0,
        error: result.success
          ? undefined
          : result.errorMessage ?? result.errorCode ?? 'нет ответа'
      };
    }
  };

  const workerCount = Math.min(concurrency, models.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Проверяет кандидатов и возвращает только рабочие модели (в порядке рейтинга).
 */
export async function filterWorkingModels(
  models: FreeModel[],
  options: VerifyModelsOptions = {}
): Promise<{ working: FreeModel[]; failed: ModelVerification[]; checked: ModelVerification[] }> {
  const checks = await verifyModels(models, options);
  const working: FreeModel[] = [];
  const failed: ModelVerification[] = [];
  for (const check of checks) {
    if (check.ok) working.push(check.model);
    else failed.push(check);
  }
  return { working, failed, checked: checks };
}
