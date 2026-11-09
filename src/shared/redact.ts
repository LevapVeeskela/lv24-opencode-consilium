/**
 * @fileoverview Редактирование секретов и управляющих последовательностей
 * @module lv24-opencode-consilium
 */

interface SecretRule {
  pattern: RegExp;
  replacement: string;
}

// Порядок важен: более специфичные префиксы обрабатываются раньше общих.
const SECRET_RULES: readonly SecretRule[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: 'sk-***' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, replacement: 'github_pat_***' },
  { pattern: /\bghp_[A-Za-z0-9]{8,}\b/g, replacement: 'ghp_***' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: 'AKIA***' },
  { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1 ***' },
  {
    pattern: /\b(api[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{6,}["']?/gi,
    replacement: '$1=***'
  },
  {
    pattern: /\b(access_token|refresh_token|token)\s*=\s*["']?[^\s&"',;`]{4,}["']?/gi,
    replacement: '$1=***'
  }
];

/**
 * Маскирует известные форматы секретов, сохраняя узнаваемый префикс.
 * Правила намеренно консервативны, чтобы не портить обычный текст.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const rule of SECRET_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

const OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const OTHER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Удаляет ANSI/OSC-последовательности и прочие управляющие символы */
export function stripControlSequences(text: string): string {
  return text
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(OTHER_CONTROL, '');
}
