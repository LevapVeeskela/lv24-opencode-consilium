/**
 * @fileoverview Атомарная запись файлов
 * @module lv24-opencode-consilium
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { errorMessage } from './errors.js';

/**
 * Атомарно записывает файл: создаёт родительский каталог, пишет во временный
 * файл рядом с целевым и переименовывает его. При ошибке удаляет временный
 * файл и бросает ошибку с путём назначения.
 */
export function writeFileAtomic(target: string, content: string): void {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporaryPath, content, 'utf-8');
    renameSync(temporaryPath, target);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Уборка временного файла не должна маскировать исходную ошибку
    }
    throw new Error(`Не удалось записать ${target}: ${errorMessage(error)}`);
  }
}
