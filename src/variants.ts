/**
 * @fileoverview Варианты моделей OpenCode (`provider/model#variant`).
 * @module opencode-consilium
 *
 * Ссылка на модель: `provider/model` с необязательным `#variant`.
 * Провайдер заканчивается на первом `/`; в имени модели `/` допустим;
 * вариант следует за первым `#`; в `provider/model` символа `#` нет.
 */

import { splitModelRef } from './compat.js';

/** Допустимый вариант модели: латиница/цифры, далее латиница/цифры/`._-` */
export const VARIANT_PATTERN: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Проверяет вариант (с триммингом); пустой/некорректный — `false` */
export function isValidVariant(variant: string): boolean {
  const trimmed = variant.trim();
  if (trimmed.length === 0) return false;
  return VARIANT_PATTERN.test(trimmed);
}

/** Возвращает часть после первого `#` (пустая — `undefined`); без `#` — `undefined` */
export function variantOf(ref: string): string | undefined {
  return splitModelRef(ref).variant;
}

/** Убирает `#...` с конца; остальной текст сохраняет как есть (без трима) */
export function stripVariant(ref: string): string {
  return splitModelRef(ref).model;
}

/** Проверяет базу `provider/model`: непустая и содержит `/` */
function assertValidBase(base: string, ref: string): void {
  if (base.length === 0 || !base.includes('/')) {
    throw new Error(`Некорректная модель: ${ref}`);
  }
}

/**
 * Ставит вариант на ссылку: `undefined`/`''` — снять вариант,
 * иначе заменить/добавить `#variant`. База обязана содержать `/`.
 */
export function withVariant(ref: string, variant: string | undefined): string {
  if (variant === undefined || variant === '') {
    const base = stripVariant(ref);
    assertValidBase(base, ref);
    return base;
  }
  const trimmed = variant.trim();
  if (!isValidVariant(trimmed)) {
    throw new Error(`Некорректный вариант модели: ${variant}`);
  }
  const base = stripVariant(ref);
  assertValidBase(base, ref);
  return `${base}#${trimmed}`;
}

/**
 * Применяет вариант ко всем моделям: у кого вариант уже есть — оставить,
 * корректным `provider/model` без варианта — добавить `#variant`,
 * некорректные id — оставить без изменений. Новый объект, вход не мутирует.
 */
export function applyVariant(
  models: Record<string, string | undefined>,
  variant: string
): Record<string, string> {
  const trimmed = variant.trim();
  if (!isValidVariant(trimmed)) {
    throw new Error(`Некорректный вариант модели: ${variant}`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(models)) {
    if (typeof value !== 'string') {
      (out as Record<string, string | undefined>)[key] = value;
      continue;
    }
    if (value.trim().length === 0) {
      out[key] = value;
      continue;
    }
    if (variantOf(value) !== undefined) {
      out[key] = value;
      continue;
    }
    const base = stripVariant(value);
    if (base.length === 0 || !base.includes('/')) {
      out[key] = value;
      continue;
    }
    out[key] = `${base}#${trimmed}`;
  }
  return out;
}

/** То же для массива; дедупликация с сохранением порядка */
export function applyVariantList(models: string[], variant: string): string[] {
  const trimmed = variant.trim();
  if (!isValidVariant(trimmed)) {
    throw new Error(`Некорректный вариант модели: ${variant}`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of models) {
    let next: string;
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      next = ref;
    } else if (variantOf(ref) !== undefined) {
      next = ref;
    } else {
      const base = stripVariant(ref);
      next = base.length === 0 || !base.includes('/') ? ref : `${base}#${trimmed}`;
    }
    if (!seen.has(next)) {
      seen.add(next);
      out.push(next);
    }
  }
  return out;
}
