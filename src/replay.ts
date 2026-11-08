/**
 * @fileoverview Планирование повтора запуска из сохранённого артефакта
 * @module lv24-opencode-consilium
 */

import type { ArtifactRun } from './artifacts.js';

/** Эксперт в плане повтора */
export interface ReplayExpert {
  name: string;
  model?: string;
}

/** План повтора запуска, восстановленный из артефакта */
export interface ReplayPlan {
  task: string;
  experts: ReplayExpert[];
  chair: { agent: string; model?: string };
  options: {
    consensus?: boolean;
    smartExperts?: boolean;
    fallbackModels?: string[];
    session?: string;
    artifacts?: boolean | string;
  };
  warnings: string[];
}

/** Артефакт с возможным новым необязательным полем chairAgent */
type ArtifactWithChair = ArtifactRun & { chairAgent?: unknown };

/** Проверяет, что значение — plain object */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Возвращает строку, если она непустая после trim, иначе undefined */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Строит план повтора запуска из артефакта.
 * Чистая функция: не читает fs, не мутирует вход, не бросает исключений
 * на некорректных опциональных метаданных — вместо этого добавляет warnings.
 */
export function planReplay(
  artifact: ArtifactRun,
  defaults?: { chairAgent?: string; artifacts?: boolean | string }
): ReplayPlan {
  const warnings: string[] = [];

  const rawTask: unknown = artifact.task;
  const task = typeof rawTask === 'string' ? rawTask : '';

  const rawModels: unknown = artifact.models;
  const models: Record<string, unknown> = isRecord(rawModels) ? rawModels : {};

  const rawExperts: unknown = artifact.experts;
  const expertList: unknown[] = Array.isArray(rawExperts) ? rawExperts : [];

  const experts: ReplayExpert[] = [];
  const seen = new Set<string>();
  for (const item of expertList) {
    const name = isRecord(item) ? cleanString(item['agent']) : undefined;
    if (name === undefined || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const fromExpert = isRecord(item) ? cleanString(item['model']) : undefined;
    const fromModels = cleanString(models[name]);
    const expert: ReplayExpert = { name };
    const model = fromExpert ?? fromModels;
    if (model !== undefined) {
      expert.model = model;
    }
    experts.push(expert);
  }

  const rawChair: unknown = (artifact as ArtifactWithChair).chairAgent;
  const chairAgent =
    cleanString(rawChair) ?? cleanString(defaults?.chairAgent) ?? 'consilium';
  const chairModel =
    cleanString(models[chairAgent]) ?? experts.find(e => e.name === chairAgent)?.model;
  const chair: { agent: string; model?: string } = { agent: chairAgent };
  if (chairModel !== undefined) {
    chair.model = chairModel;
  }

  const rawMetadata: unknown = artifact.metadata;
  const metadata = isRecord(rawMetadata) ? rawMetadata : undefined;

  let fallbackModels: string[] | undefined;
  const rawFallback: unknown = metadata?.['fallbackModels'];
  if (Array.isArray(rawFallback)) {
    const items: unknown[] = rawFallback;
    if (items.every((entry: unknown): entry is string => typeof entry === 'string')) {
      fallbackModels = items.filter(
        (entry: unknown): entry is string => typeof entry === 'string'
      );
    }
  }

  const rawSession: unknown = metadata?.['session'];
  const session = typeof rawSession === 'string' ? rawSession : undefined;

  const rawArtifacts: unknown = defaults?.artifacts;
  const artifacts: boolean | string =
    typeof rawArtifacts === 'boolean' || typeof rawArtifacts === 'string'
      ? rawArtifacts
      : true;

  const options: ReplayPlan['options'] = {};
  if (metadata !== undefined) {
    // Флаг восстанавливаем только если он был зафиксирован в артефакте:
    // отсутствие ключа не должно перекрывать конфиг.
    if (metadata['consensus'] !== undefined) options.consensus = true;
    if (metadata['smartExperts'] !== undefined) options.smartExperts = true;
  }
  if (fallbackModels !== undefined) {
    options.fallbackModels = fallbackModels;
  }
  if (session !== undefined) {
    options.session = session;
  }
  options.artifacts = artifacts;

  if (task.trim() === '') {
    warnings.push('Пустая задача в артефакте: поле task отсутствует или пустое.');
  }
  if (experts.length === 0) {
    warnings.push('В артефакте нет экспертов: план содержит пустой список экспертов.');
  }
  if (chairModel === undefined) {
    warnings.push(`Неизвестная модель председателя "${chairAgent}": ни карта models, ни эксперты её не содержат.`);
  }
  if (metadata === undefined) {
    warnings.push(
      'Метаданные артефакта отсутствуют: флаги consensus/smartExperts восстановить нельзя, использованы значения по умолчанию (выключены).'
    );
  }
  if (artifact.success === false) {
    warnings.push(
      'Артефакт зафиксировал неудачный запуск (success: false): повтор может воспроизвести ту же ошибку.'
    );
  }

  return { task, experts, chair, options, warnings };
}
