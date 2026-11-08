/**
 * @fileoverview Чтение JSON/JSONC и проверка формы значений
 * @module lv24-opencode-consilium
 */

import { readFileSync } from 'fs';

// Помощники формы значений живут в shared-ядре; реэкспорт сохраняет прежние
// импорты из jsonc.js.
export { isRecord, recordOf, type JsonRecord } from '../../shared/record.js';

/**
 * Удаляет комментарии и висячие запятые из JSONC, не трогая строки
 */
export function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const next = text[i + 1] ?? '';

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    result += char;
  }

  return removeTrailingCommas(result);
}

function removeTrailingCommas(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ',') {
      let lookahead = i + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead] ?? '')) {
        lookahead += 1;
      }
      const following = text[lookahead];
      if (following === '}' || following === ']') {
        continue;
      }
    }

    result += char;
  }

  return result;
}

/**
 * Читает JSON/JSONC файл
 */
export function readJsonFile(path: string): unknown {
  const content = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(stripJsonComments(content));
}
