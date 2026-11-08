/**
 * @fileoverview Идентификаторы сессий OpenCode для агентов совета
 * @module lv24-opencode-consilium
 */

/** Допустимый идентификатор сессии OpenCode */
export const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@\/_-]*$/;

/** Проверяет, что идентификатор сессии допустим для `--session` */
export function isValidSessionId(session: string): boolean {
  return SESSION_PATTERN.test(session);
}

/**
 * Строит идентификатор сессии OpenCode для конкретного агента.
 * Эксперты не должны делить одну сессию: к контексту добавляется имя агента.
 */
export function buildAgentSession(
  base: string | undefined,
  agentName: string
): string | undefined {
  const trimmed = base?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;

  // OpenCode требует, чтобы session id начинался с "ses".
  const prefixed = trimmed.startsWith('ses') ? trimmed : `ses_${trimmed}`;
  const suffix = `-${agentName.trim().length > 0 ? agentName.trim() : 'default'}`;
  const cleaned = `${prefixed}${suffix}`
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');

  // Обрезаем базу, а не суффикс: иначе разные агенты получат одинаковый id.
  const maxBase = Math.max(8, 128 - suffix.length);
  return cleaned.length <= 128
    ? cleaned
    : `${cleaned.slice(0, Math.min(maxBase, cleaned.length - suffix.length))}${suffix}`;
}

/**
 * Сессия председателя: базовый id используется как есть, чтобы продолжать
 * существующую сессию OpenCode, а не создавать новую.
 */
export function buildChairSession(base: string | undefined): string | undefined {
  const trimmed = base?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;

  const prefixed = trimmed.startsWith('ses') ? trimmed : `ses_${trimmed}`;
  const cleaned = prefixed
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');

  return cleaned.length > 0 ? cleaned.slice(0, 128) : undefined;
}
