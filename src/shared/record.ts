/**
 * @fileoverview Проверки формы JSON-объектов
 * @module lv24-opencode-consilium
 */

/** Объект с произвольными строковыми ключами */
export type JsonRecord = Record<string, unknown>;

/** Проверяет, что значение — обычный объект (не null и не массив) */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Возвращает объект только для объектных значений */
export function recordOf(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}
