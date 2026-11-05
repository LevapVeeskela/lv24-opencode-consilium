/**
 * @fileoverview Пресеты консилиума
 * @module opencode-consilium
 */

import type { ConsiliumConfig, ExpertConfig } from './types.js';

/** Пресет состава и таймаутов консилиума */
export interface CouncilPreset {
  name: string;
  description: string;
  experts?: string[];
  chair?: string;
  retries?: number;
  expertTimeout?: number;
  chairTimeout?: number;
  focus?: string;
}

/** Встроенные пресеты */
export const PRESETS: Record<string, CouncilPreset> = {
  fast: {
    name: 'fast',
    description: 'Быстрый консилиум: архитектор и безопасник, без повторных попыток.',
    experts: ['arch', 'sec'],
    expertTimeout: 180_000,
    chairTimeout: 300_000,
    retries: 0
  },
  deep: {
    name: 'deep',
    description: 'Глубокий разбор: все эксперты, увеличенные таймауты и повторные попытки.',
    experts: ['arch', 'ux', 'ba', 'sec'],
    expertTimeout: 600_000,
    chairTimeout: 1_200_000,
    retries: 1
  },
  security: {
    name: 'security',
    description: 'Аудит безопасности: архитектор, безопасник и бизнес-аналитик.',
    experts: ['sec', 'arch', 'ba'],
    focus: 'security'
  },
  review: {
    name: 'review',
    description: 'Ревью кода: архитектура, безопасность и UX.',
    experts: ['arch', 'sec', 'ux'],
    focus: 'code review'
  },
  free: {
    name: 'free',
    description: 'Бесплатный консилиум на free-моделях; требуется bootstrap бесплатных моделей.',
    experts: ['arch', 'ux', 'ba', 'sec']
  }
};

/**
 * Список пресетов
 */
export function listPresets(): CouncilPreset[] {
  return Object.values(PRESETS);
}

/**
 * Применить пресет к конфигурации (возвращает новую конфигурацию)
 */
export function applyPreset(config: ConsiliumConfig, name: string): ConsiliumConfig {
  const preset = Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name] : undefined;
  if (!preset) {
    throw new Error(
      `Неизвестный пресет: ${name}. Доступны: ${Object.keys(PRESETS).join(', ')}`
    );
  }

  const experts: ExpertConfig[] = config.experts.map(expert => ({ ...expert }));
  let filtered = experts;

  if (preset.experts) {
    const order = new Map(preset.experts.map((expertName, index) => [expertName, index] as const));
    filtered = experts
      .filter(expert => order.has(expert.name))
      .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  }

  const timeouts = { ...config.timeouts };
  if (preset.expertTimeout !== undefined) timeouts.expert = preset.expertTimeout;
  if (preset.chairTimeout !== undefined) timeouts.chair = preset.chairTimeout;

  const retry = { ...config.retry };
  if (preset.retries !== undefined) {
    retry.expertRetries = preset.retries;
    retry.chairRetries = preset.retries;
  }

  const chair = { ...config.chair };
  if (preset.chair !== undefined) chair.agent = preset.chair;
  if (preset.chairTimeout !== undefined) chair.timeout = preset.chairTimeout;

  return {
    ...config,
    experts: filtered,
    chair,
    timeouts,
    retry
  };
}
