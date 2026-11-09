/**
 * @fileoverview Пресеты консилиума
 * @module lv24-opencode-consilium
 */

import type { ConsiliumConfig, ExpertConfig } from '../types.js';

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
  /** Дополнительный промпт пользовательского пресета (передаётся как есть) */
  prompt?: string;
}

/** Пользовательские пресеты: имя пресета — ключ, поля — частичный пресет. */
export type CustomPresetConfig = Record<string, Partial<CouncilPreset>>;

/** Результат слияния встроенных и пользовательских пресетов. */
export interface MergedPresets {
  presets: Record<string, CouncilPreset>;
  warnings: string[];
}

/** Допустимое имя пресета: латиница/цифры, далее латиница/цифры/`_-` */
export const PRESET_NAME_PATTERN: RegExp = /^[a-z0-9][a-z0-9_-]*$/i;

/** Описание пользовательского пресета, если оно не задано */
const CUSTOM_PRESET_DESCRIPTION = 'Пользовательский пресет';

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

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Копия пресета без общих массивов с исходником */
function clonePreset(preset: CouncilPreset): CouncilPreset {
  const clone: CouncilPreset = { ...preset };
  if (preset.experts !== undefined) clone.experts = [...preset.experts];
  return clone;
}

function warnInvalidField(
  warnings: string[],
  name: string,
  field: string,
  expected: string
): void {
  warnings.push(
    `Пресет "${name}": поле "${field}" должно быть ${expected}; значение проигнорировано.`
  );
}

/**
 * Проверяет одну пользовательскую запись и оставляет только корректные поля.
 * `name` берётся из ключа и не может быть переопределён полем внутри записи.
 */
function normalizeCustomPreset(
  name: string,
  raw: unknown,
  warnings: string[]
): Partial<CouncilPreset> | null {
  if (!PRESET_NAME_PATTERN.test(name)) {
    warnings.push(
      `Пресет "${name}": имя должно соответствовать ${PRESET_NAME_PATTERN}; запись пропущена.`
    );
    return null;
  }
  if (!isPlainObject(raw)) {
    warnings.push(`Пресет "${name}": ожидается объект с полями пресета; запись пропущена.`);
    return null;
  }

  const normalized: Partial<CouncilPreset> = {};

  for (const field of ['description', 'chair', 'focus', 'prompt'] as const) {
    if (!hasOwn(raw, field) || raw[field] === undefined) continue;
    const value = raw[field];
    if (typeof value === 'string') {
      normalized[field] = value;
    } else {
      warnInvalidField(warnings, name, field, 'строкой');
    }
  }

  for (const field of ['retries', 'expertTimeout', 'chairTimeout'] as const) {
    if (!hasOwn(raw, field) || raw[field] === undefined) continue;
    const value = raw[field];
    if (isNonNegativeInteger(value)) {
      normalized[field] = value;
    } else {
      warnInvalidField(warnings, name, field, 'неотрицательным целым числом');
    }
  }

  if (hasOwn(raw, 'experts') && raw.experts !== undefined) {
    const experts = raw.experts;
    if (Array.isArray(experts) && experts.every(item => typeof item === 'string')) {
      normalized.experts = [...experts] as string[];
    } else {
      warnInvalidField(warnings, name, 'experts', 'массивом строк');
    }
  }

  return normalized;
}

/** Накладывает корректные пользовательские поля на копию базового пресета */
function mergePreset(base: CouncilPreset, partial: Partial<CouncilPreset>): CouncilPreset {
  const merged = clonePreset(base);
  if (partial.description !== undefined) merged.description = partial.description;
  if (partial.experts !== undefined) merged.experts = [...partial.experts];
  if (partial.chair !== undefined) merged.chair = partial.chair;
  if (partial.retries !== undefined) merged.retries = partial.retries;
  if (partial.expertTimeout !== undefined) merged.expertTimeout = partial.expertTimeout;
  if (partial.chairTimeout !== undefined) merged.chairTimeout = partial.chairTimeout;
  if (partial.focus !== undefined) merged.focus = partial.focus;
  if (partial.prompt !== undefined) merged.prompt = partial.prompt;
  return merged;
}

/** Алфавитный порядок без зависимости от локали */
function comparePresetNames(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Объединяет встроенные пресеты с пользовательскими.
 *
 * Встроенные пресеты идут первыми в исходном порядке, новые пользовательские —
 * после них по алфавиту. Поля пользовательской записи переопределяют встроенные;
 * отсутствующие поля сохраняют встроенные значения. Некорректные записи и поля
 * отбрасываются, причина попадает в `warnings`. `PRESETS` не мутируется.
 */
export function mergePresets(custom?: CustomPresetConfig): MergedPresets {
  const warnings: string[] = [];
  const overrides = new Map<string, Partial<CouncilPreset>>();

  if (custom !== undefined && custom !== null && !isPlainObject(custom)) {
    warnings.push('Пользовательские пресеты должны быть объектом; настройка проигнорирована.');
  } else {
    for (const [name, raw] of Object.entries(custom ?? {})) {
      const normalized = normalizeCustomPreset(name, raw, warnings);
      if (normalized !== null) overrides.set(name, normalized);
    }
  }

  const presets: Record<string, CouncilPreset> = {};
  for (const [name, preset] of Object.entries(PRESETS)) {
    const override = overrides.get(name);
    presets[name] = override ? mergePreset(preset, override) : clonePreset(preset);
  }

  const customNames = [...overrides.keys()]
    .filter(name => !hasOwn(PRESETS, name))
    .sort(comparePresetNames);

  for (const name of customNames) {
    const base: CouncilPreset = { name, description: CUSTOM_PRESET_DESCRIPTION };
    presets[name] = mergePreset(base, overrides.get(name) ?? {});
  }

  return { presets, warnings };
}

/**
 * Список пресетов (встроенные, затем пользовательские по алфавиту)
 */
export function listPresets(custom?: CustomPresetConfig): CouncilPreset[] {
  const { presets } = mergePresets(custom);
  return Object.values(presets).map(clonePreset);
}

/**
 * Применить пресет к конфигурации (возвращает новую конфигурацию)
 */
export function applyPreset(
  config: ConsiliumConfig,
  name: string,
  custom?: CustomPresetConfig
): ConsiliumConfig {
  const { presets } = mergePresets(custom);
  const preset = hasOwn(presets, name) ? presets[name] : undefined;
  if (!preset) {
    throw new Error(
      `Неизвестный пресет: ${name}. Доступны: ${Object.keys(presets).join(', ')}`
    );
  }

  const experts: ExpertConfig[] = config.experts.map(expert => ({ ...expert }));
  let filtered = experts;

  if (preset.experts) {
    const order = new Map(preset.experts.map((expertName, index) => [expertName, index] as const));
    const matched = experts
      .filter(expert => order.has(expert.name))
      .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
    // Пресет не должен обнулять совет: если в конфиге только кастомные
    // эксперты (или имена не совпали), оставляем настроенный состав.
    filtered = matched.length > 0 ? matched : experts;
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

/**
 * Компактное текстовое представление пресетов для CLI/MCP.
 * Порядок входа сохраняется.
 */
export function formatPresets(
  presets: CouncilPreset[] | Record<string, CouncilPreset>
): string {
  const list = Array.isArray(presets) ? presets : Object.values(presets);
  return list
    .map(preset => {
      const experts =
        preset.experts && preset.experts.length > 0 ? preset.experts.join(', ') : 'none';
      return `${preset.name} — ${preset.description} (experts: ${experts})`;
    })
    .join('\n');
}
