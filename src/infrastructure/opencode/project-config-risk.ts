/**
 * @fileoverview Ключи проектной конфигурации OpenCode, которые read-only слой
 * Consilium не ограничивает: MCP-серверы, плагины и провайдеры.
 *
 * Read-only слой запрещает агентам инструменты, но `opencode.json` из
 * репозитория загружает сам OpenCode. Локальный MCP-сервер или плагин из
 * чужого репозитория — это запуск чужого кода, а провайдер с подменённым
 * адресом — канал утечки ключа. Consilium об этом только предупреждает.
 *
 * @module lv24-opencode-consilium
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { isRecord, readJsonFile } from '../config/jsonc.js';

/** Файлы проектной конфигурации OpenCode относительно рабочего каталога */
const PROJECT_CONFIG_FILES = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc'
] as const;

/** Ключи, которые запускают код или меняют адрес провайдера */
const RISK_KEYS = ['mcp', 'plugin', 'plugins', 'provider', 'providers'] as const;

function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

/** Найденные ключи одного файла конфигурации */
export interface ProjectConfigRisk {
  /** Путь относительно рабочего каталога */
  file: string;
  keys: string[];
}

/**
 * Возвращает файлы проектной конфигурации OpenCode с непустыми ключами
 * `mcp`, `plugin(s)`, `provider(s)`. Нечитаемые файлы пропускаются:
 * о них сообщают другие проверки.
 */
export function findProjectConfigRisks(cwd: string): ProjectConfigRisk[] {
  const risks: ProjectConfigRisk[] = [];
  for (const file of PROJECT_CONFIG_FILES) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = readJsonFile(path);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const keys = RISK_KEYS.filter(key => isNonEmpty(parsed[key]));
    if (keys.length > 0) risks.push({ file, keys: [...keys] });
  }
  return risks;
}

/** Однострочное предупреждение для лога или undefined, если рисков нет */
export function formatProjectConfigRisks(risks: readonly ProjectConfigRisk[]): string | undefined {
  if (risks.length === 0) return undefined;
  const details = risks.map(risk => `${risk.file} (${risk.keys.join(', ')})`).join('; ');
  return (
    'Read-only does not restrict the project OpenCode config: ' +
    `${details}. MCP servers and plugins run code and providers can redirect requests; ` +
    'review these keys before running the council on a repository you do not trust.'
  );
}
