/**
 * @fileoverview Общие типы и утилиты диагностики Consilium
 * @module lv24-opencode-consilium
 */

// Помощники формы значений и текста ошибок живут в shared-ядре; реэкспорт
// сохраняет прежние импорты из diagnostics/types.js.
export { isRecord } from '../../shared/record.js';
export { errorMessage } from '../../shared/errors.js';

/** Результат одной проверки */
export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  hint?: string;
}

/** Опции диагностики */
export interface DoctorOptions {
  configPath?: string | null;
  cwd?: string;
  checkModels?: boolean;
}

/** Ссылка на модель агента */
export interface ModelRef {
  owner: string;
  model: string;
}

/** Тип функции проверки */
export type CheckFn = () => DoctorCheck | Promise<DoctorCheck>;

/** Прочитанная конфигурация OpenCode */
export interface OpenCodeConfigRead {
  path: string | null;
  config: Record<string, unknown> | null;
  error?: string;
}

/** Ограничивает список имён в сообщении */
export function formatNames(names: string[], limit = 5): string {
  if (names.length <= limit) {
    return names.join(', ');
  }
  return `${names.slice(0, limit).join(', ')} и ещё ${names.length - limit}`;
}

/** Находит дубликаты в списке имён */
export function findDuplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      duplicates.add(name);
    } else {
      seen.add(name);
    }
  }
  return [...duplicates];
}

/** Возвращает префикс провайдера модели */
export function getProvider(model: string): string {
  const slashIndex = model.indexOf('/');
  return slashIndex > 0 ? model.slice(0, slashIndex) : '';
}
