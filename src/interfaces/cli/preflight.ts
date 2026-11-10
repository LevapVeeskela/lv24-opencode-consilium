/**
 * @fileoverview CLI-проверки изоляции: типизированная ошибка -> ошибка использования
 * @module lv24-opencode-consilium/cli/preflight
 */

import {
  assertIsolatedReadOnlyPreflight,
  isIsolationConfigError,
  type IsolatedReadOnlyPreflightOptions
} from '../../infrastructure/opencode/isolate.js';
import { UsageError } from './args.js';

/**
 * Проверяет несовместимость `--isolate` с `--read-only` до запуска совета.
 *
 * Неверная конфигурация изоляции — это ошибка использования (код 2), а не
 * сбой запуска (код 1): совет ещё не начинал работу, пользователю нужно
 * поправить проект или флаги.
 */
export function assertCliIsolatedReadOnlyPreflight(
  options: IsolatedReadOnlyPreflightOptions
): void {
  try {
    assertIsolatedReadOnlyPreflight(options);
  } catch (error) {
    if (isIsolationConfigError(error)) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}
