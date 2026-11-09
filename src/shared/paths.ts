/**
 * @fileoverview Проверки вложенности путей с разрешением симлинков
 * @module lv24-opencode-consilium
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Ошибка выхода пути за пределы разрешённого каталога */
export class PathContainmentError extends Error {
  readonly code = 'PATH_OUTSIDE';

  constructor(
    message: string,
    readonly base: string,
    readonly candidate: string
  ) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

/** Возвращает realpath существующего пути или undefined для отсутствующего */
function realpathIfExists(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * Канонизирует путь: разрешает симлинки самого глубокого существующего
 * предка и дописывает ещё не существующий хвост.
 */
export function canonicalizePath(target: string): string {
  let current = resolve(target);
  const tail: string[] = [];

  for (;;) {
    const real = realpathIfExists(current);
    if (real !== undefined) {
      return tail.length === 0 ? real : resolve(real, ...tail.reverse());
    }
    const parent = dirname(current);
    if (parent === current) {
      // Корень (например, несуществующий диск или UNC-шара) не разрешается.
      return resolve(target);
    }
    tail.push(basename(current));
    current = parent;
  }
}

/** Проверяет вложенность уже канонизированных путей */
function contains(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Не бросающая проверка: находится ли candidate внутри base.
 * Учитывает `..`, абсолютные пути, разные диски/UNC и симлинки.
 */
export function isInside(base: string, candidate: string): boolean {
  try {
    const basePath = canonicalizePath(resolve(base));
    const candidatePath = canonicalizePath(resolve(basePath, candidate));
    return contains(basePath, candidatePath);
  } catch {
    return false;
  }
}

/**
 * Резолвит candidate относительно base и требует, чтобы итоговый путь
 * (с разрешёнными симлинками) оставался внутри base.
 *
 * @throws {PathContainmentError} если путь выходит за пределы base
 */
export function resolveInside(base: string, candidate: string, label = 'Path'): string {
  const basePath = canonicalizePath(resolve(base));
  const candidatePath = canonicalizePath(resolve(basePath, candidate));

  if (!contains(basePath, candidatePath)) {
    throw new PathContainmentError(
      `${label} must stay inside the allowed directory`,
      basePath,
      candidatePath
    );
  }

  return candidatePath;
}
