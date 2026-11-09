/**
 * @fileoverview Bootstrap локального консилиума: назначение найденных моделей
 * экспертам и председателю, текстовая сводка и частичная конфигурация.
 * @module lv24-opencode-consilium
 */

import type { ChairConfig, ConsiliumConfig, ExpertConfig } from '../domain/types.js';
import type { LocalProviderProbeResult } from '../infrastructure/local-models.js';

/** Роли экспертов по умолчанию */
export const DEFAULT_LOCAL_ROLES = ['arch', 'ux', 'ba', 'sec'] as const;

/** Имя председателя по умолчанию */
export const DEFAULT_LOCAL_CHAIR = 'consilium';

/** Опции сборки локального bootstrap */
export interface LocalBootstrapOptions {
  /** Результаты проверки локальных провайдеров */
  providers: readonly LocalProviderProbeResult[];
  /** Роли экспертов (по умолчанию arch, ux, ba, sec) */
  roles?: readonly string[];
  /** Имя председателя (по умолчанию consilium) */
  chair?: string;
}

/** Эксперт с назначенной моделью */
export interface LocalBootstrapExpert {
  /** Имя роли */
  name: string;
  /** Модель в формате provider/model */
  model: string;
}

/** Председатель с назначенной моделью */
export interface LocalBootstrapChair {
  /** Имя агента-председателя */
  agent: string;
  /** Модель в формате provider/model */
  model: string;
}

/** Причина, по которой bootstrap невозможен */
export type LocalBootstrapFailureReason = 'no-local-models';

/** Успешный результат bootstrap */
export interface LocalBootstrapSuccess {
  ok: true;
  experts: LocalBootstrapExpert[];
  chair: LocalBootstrapChair;
  /** Все найденные локальные модели в порядке проверки провайдеров */
  models: string[];
  /** Предупреждения (например, о переиспользовании моделей) */
  warnings: string[];
}

/** Неуспешный результат bootstrap */
export interface LocalBootstrapFailure {
  ok: false;
  reason: LocalBootstrapFailureReason;
  /** Исходные результаты проверки провайдеров */
  providers: readonly LocalProviderProbeResult[];
}

/** Результат сборки локального bootstrap */
export type LocalBootstrapResult = LocalBootstrapSuccess | LocalBootstrapFailure;

/** Нормализует имя роли или председателя */
function normalizeName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length > 0 ? name : fallback;
}

/** Оставляет непустые имена ролей в исходном порядке */
function normalizeRoles(roles: readonly string[] | undefined): string[] {
  const source = roles ?? DEFAULT_LOCAL_ROLES;
  const normalized: string[] = [];
  for (const role of source) {
    const name = normalizeName(role, '');
    if (name.length > 0) normalized.push(name);
  }
  return normalized;
}

/**
 * Собирает `provider/model` из успешных проверок с непустым списком моделей.
 * Префикс — метка провайдера из результата проверки (`ollama` или `lmstudio`).
 */
function collectLocalModels(providers: readonly LocalProviderProbeResult[]): string[] {
  const models: string[] = [];
  for (const provider of providers) {
    if (!provider.ok) continue;
    const modelIds = Array.isArray(provider.modelIds) ? provider.modelIds : [];
    for (const raw of modelIds) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      if (id.length === 0) continue;
      models.push(`${provider.provider}/${id}`);
    }
  }
  return models;
}

/**
 * Собирает локальную конфигурацию из результатов проверки провайдеров.
 *
 * Модели назначаются ролям и председателю по кругу (round-robin). Если моделей
 * меньше, чем агентов, модели переиспользуются, а в `warnings` добавляется
 * предупреждение. Функция ничего не пишет на диск и не обращается к сети.
 */
export function buildLocalBootstrap(
  options: LocalBootstrapOptions
): LocalBootstrapResult {
  const providers = Array.isArray(options.providers) ? options.providers : [];
  const roles = normalizeRoles(options.roles);
  const chairName = normalizeName(options.chair, DEFAULT_LOCAL_CHAIR);
  const models = collectLocalModels(providers);

  if (models.length === 0) {
    return { ok: false, reason: 'no-local-models', providers };
  }

  const experts: LocalBootstrapExpert[] = roles.map((name, index) => ({
    name,
    model: models[index % models.length]
  }));
  const chair: LocalBootstrapChair = {
    agent: chairName,
    model: models[roles.length % models.length]
  };

  const warnings: string[] = [];
  const agents = roles.length + 1;
  if (models.length < agents) {
    warnings.push(
      `Only ${models.length} local model(s) for ${agents} agent(s); models are reused round-robin.`
    );
  }

  return { ok: true, experts, chair, models, warnings };
}

/**
 * Форматирует результат bootstrap как текст: строки «роль → модель»,
 * список моделей и предупреждения.
 */
export function formatLocalBootstrap(result: LocalBootstrapResult): string {
  if (!result.ok) {
    const lines = [`Local bootstrap failed: ${result.reason}`];
    for (const provider of result.providers) {
      const status = provider.ok ? 'ok' : 'fail';
      const count = typeof provider.models === 'number' ? provider.models : 0;
      const error =
        typeof provider.error === 'string' && provider.error.length > 0
          ? `: ${provider.error}`
          : '';
      lines.push(`${provider.provider}: ${status}, ${count} model(s)${error}`);
    }
    return lines.join('\n');
  }

  const lines = ['Local bootstrap'];
  for (const expert of result.experts) {
    lines.push(`${expert.name} → ${expert.model}`);
  }
  lines.push(`chair (${result.chair.agent}) → ${result.chair.model}`);
  lines.push(`Models (${result.models.length}): ${result.models.join(', ')}`);

  if (result.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Строит частичную конфигурацию Consilium для локального режима.
 * Поля `base` сохраняются, кроме `experts` и `chair`, которые заменяются
 * результатом bootstrap. Исходный объект `base` не изменяется.
 */
export function buildLocalConfig(
  result: LocalBootstrapSuccess,
  base: Partial<ConsiliumConfig> = {}
): Partial<ConsiliumConfig> {
  const experts: ExpertConfig[] = result.experts.map(expert => ({
    name: expert.name,
    model: expert.model
  }));
  const chair: ChairConfig = {
    agent: result.chair.agent,
    model: result.chair.model
  };

  return {
    ...base,
    experts,
    chair,
    localOnly: true,
    autoDiscoverAgents: false
  };
}
