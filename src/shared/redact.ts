/**
 * @fileoverview Редактирование секретов и управляющих последовательностей
 * @module lv24-opencode-consilium
 */

interface SecretRule {
  pattern: RegExp;
  replacement: string;
}

/**
 * Правила с высокой уверенностью: узнаваемые префиксы токенов, PEM-ключи, JWT
 * и JSON-поля с секретом. Они почти не дают ложных срабатываний на обычном
 * тексте ревью, поэтому применяются ко всему выводу (отчёты, SARIF, JSON, MCP).
 * Порядок важен: более специфичные префиксы обрабатываются раньше общих.
 */
const HIGH_CONFIDENCE_RULES: readonly SecretRule[] = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----'
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: 'sk-***' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, replacement: 'github_pat_***' },
  { pattern: /\b(gh[pousr])_[A-Za-z0-9]{8,}\b/g, replacement: '$1_***' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{8,}/g, replacement: 'glpat-***' },
  { pattern: /\b(xox[abeoprs])-[A-Za-z0-9-]{8,}/g, replacement: '$1-***' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: 'AKIA***' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: 'AIza***' },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: 'eyJ***'
  },
  { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1 ***' },
  {
    // JSON-вид: "apiKey": "value", "access_token": "value", "password": "value".
    pattern:
      /"(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|authorization)"(\s*:\s*)"[^"\r\n]{8,}"/gi,
    replacement: '"$1"$2"***"'
  }
];

/** Общие присваивания: больше ложных срабатываний, только для артефактов */
const ASSIGNMENT_RULES: readonly SecretRule[] = [
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
  return applyRules(applyRules(text, HIGH_CONFIDENCE_RULES), ASSIGNMENT_RULES);
}

/**
 * Маскирует только секреты с высокой уверенностью (префиксы токенов, PEM, JWT,
 * JSON-поля). Безопасно для текста ревью: `token = getToken()` не трогается.
 */
export function redactHighConfidenceSecrets(text: string): string {
  return applyRules(text, HIGH_CONFIDENCE_RULES);
}

function applyRules(text: string, rules: readonly SecretRule[]): string {
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Рекурсивно применяет `redact` ко всем строкам JSON-подобного значения.
 * Возвращает копию; исходное значение не меняется. Ключи объектов не трогает.
 */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map(item => redactDeep(item, redact)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = redactDeep(item, redact);
    }
    return copy as T;
  }
  return value;
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
