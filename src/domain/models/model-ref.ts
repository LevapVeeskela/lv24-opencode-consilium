/**
 * @fileoverview Ссылки на модели OpenCode (`provider/model#variant`): нормализация и разбор.
 * @module lv24-opencode-consilium
 */

import { isRecord } from '../../shared/record.js';

/**
 * Нормализует ссылку на модель.
 * Поддерживает строку и расширенный объект V2 (`providerID`/`model`/`variant`).
 */
export function toModelRef(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!isRecord(value)) return undefined;

  const provider =
    typeof value.providerID === 'string'
      ? value.providerID
      : typeof value.provider === 'string'
        ? value.provider
        : undefined;
  const model =
    typeof value.model === 'string'
      ? value.model
      : typeof value.modelID === 'string'
        ? value.modelID
        : undefined;

  if (provider === undefined || model === undefined) return undefined;
  if (provider.trim().length === 0 || model.trim().length === 0) return undefined;

  const variant = typeof value.variant === 'string' ? value.variant.trim() : '';
  return variant.length > 0 ? `${provider}/${model}#${variant}` : `${provider}/${model}`;
}

/** Делит ссылку `provider/model#variant` на модель и вариант */
export function splitModelRef(ref: string): { model: string; variant?: string } {
  const hash = ref.indexOf('#');
  if (hash === -1) return { model: ref };
  const variant = ref.slice(hash + 1).trim();
  return variant.length > 0
    ? { model: ref.slice(0, hash), variant }
    : { model: ref.slice(0, hash) };
}
