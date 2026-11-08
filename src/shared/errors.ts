/**
 * @fileoverview Извлечение текста ошибки из неизвестного значения
 * @module lv24-opencode-consilium
 */

/** Извлекает текст ошибки */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
