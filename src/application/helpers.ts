/**
 * @fileoverview Чистые помощники уровня приложения: агрегация результатов
 * агентов, входные данные согласия и построение промптов.
 * @module lv24-opencode-consilium
 */

import type { AgentResult, AgentUsage } from '../domain/types.js';
import { DEFAULT_EXPERT_PROMPTS } from '../domain/defaults.js';

/** Суммирует расход токенов и стоимость по результатам агентов */
export function sumUsage(results: AgentResult[]): AgentUsage | undefined {
  let found = false;
  const total: Required<AgentUsage> = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0
  };

  for (const result of results) {
    const usage = result.usage;
    if (!usage) continue;
    found = true;
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.reasoningTokens += usage.reasoningTokens ?? 0;
    total.cacheReadTokens += usage.cacheReadTokens ?? 0;
    total.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    total.cost += usage.cost ?? 0;
  }

  return found ? total : undefined;
}

/** Собирает модели агентов из результатов */
export function collectModels(results: AgentResult[]): Record<string, string> {
  const models: Record<string, string> = {};
  for (const result of results) {
    if (result.model) models[result.agent] = result.model;
  }
  return models;
}

/** Входные данные для анализа согласия */
export function consensusInputs(results: AgentResult[]): Array<{
  agent: string;
  text: string;
  model?: string;
  success: boolean;
}> {
  return results.map(result => ({
    agent: result.agent,
    text: result.text,
    model: result.model,
    success: result.success
  }));
}

/** Собирает реальные session id агентов */
export function collectSessions(results: AgentResult[]): Record<string, string> {
  const sessions: Record<string, string> = {};
  for (const result of results) {
    if (result.sessionId !== undefined) sessions[result.agent] = result.sessionId;
  }
  return sessions;
}

/** Строит промпт эксперта с подстановкой задачи */
export function buildExpertPrompt(expertName: string, prompt: unknown, task: string): string {
  if (typeof prompt === 'function') {
    return prompt(task);
  }
  if (typeof prompt === 'string' && prompt.trim().length > 0) {
    return prompt.replace(/\$\{task\}/g, task);
  }
  const fallback = Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, expertName)
    ? DEFAULT_EXPERT_PROMPTS[expertName]
    : DEFAULT_EXPERT_PROMPTS.default;
  return typeof fallback === 'function' ? fallback(task) : task;
}
