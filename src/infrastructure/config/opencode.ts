/**
 * @fileoverview Обнаружение и чтение конфигурации OpenCode (агенты)
 * @module lv24-opencode-consilium
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import type { ExpertConfig } from '../../domain/types.js';
import { DEFAULT_EXPERT_PROMPTS } from '../../domain/defaults.js';
import {
  readAgentDefinition,
  readAgentSection,
  type AgentSectionView
} from './compat.js';
import {
  readJsonFile,
  isRecord,
  recordOf,
  type JsonRecord
} from './jsonc.js';

/**
 * Возвращает все найденные файлы конфигурации OpenCode в порядке возрастания
 * приоритета: глобальный → прямые файлы от корня к cwd → `.opencode`-файлы
 * от корня к cwd. OpenCode сливает их именно в таком порядке.
 */
export function listOpenCodeConfigPaths(cwd?: string): string[] {
  const start = resolve(cwd ?? process.cwd());
  const paths: string[] = [];
  const seen = new Set<string>();

  const push = (candidate: string): void => {
    if (!seen.has(candidate) && existsSync(candidate)) {
      seen.add(candidate);
      paths.push(candidate);
    }
  };

  const configHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  push(resolve(configHome, 'opencode', 'opencode.json'));
  push(resolve(configHome, 'opencode', 'opencode.jsonc'));

  const chain: string[] = [];
  let current = start;
  for (let depth = 0; depth < 24; depth += 1) {
    chain.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const directory of chain) {
    push(resolve(directory, 'opencode.json'));
    push(resolve(directory, 'opencode.jsonc'));
  }
  for (const directory of chain) {
    push(resolve(directory, '.opencode', 'opencode.json'));
    push(resolve(directory, '.opencode', 'opencode.jsonc'));
  }

  return paths;
}

/**
 * Находит основной файл конфигурации OpenCode (наивысший приоритет).
 * Если заданный `opencodeConfigPath` не существует, используется автоопределение.
 */
export function findOpenCodeConfigPath(configuredPath?: string, cwd?: string): string | null {
  const start = resolve(cwd ?? process.cwd());

  if (configuredPath) {
    const resolved = resolve(start, configuredPath);
    if (existsSync(resolved)) return resolved;
    if (!configuredPath.endsWith('.jsonc') && existsSync(`${resolved}c`)) {
      return `${resolved}c`;
    }
  }

  const paths = listOpenCodeConfigPaths(start);
  return paths.length > 0 ? paths[paths.length - 1] ?? null : null;
}

/** Сливает конфигурации OpenCode: агенты и MCP объединяются по именам */
function mergeOpenCodeConfigs(layers: JsonRecord[]): JsonRecord {
  const merged: JsonRecord = {};

  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'agent' || key === 'agents') {
        merged[key] = { ...recordOf(merged[key]), ...recordOf(value) };
      } else if (key === 'mcp') {
        const base = recordOf(merged.mcp);
        const next = recordOf(value);
        const mcp: JsonRecord = { ...base, ...next };
        if (isRecord(base.servers) || isRecord(next.servers)) {
          mcp.servers = { ...recordOf(base.servers), ...recordOf(next.servers) };
        }
        merged.mcp = mcp;
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
}

/** Снимок агентов из конфигурации OpenCode */
export interface OpenCodeAgentSnapshot {
  /** Файл с наивысшим приоритетом */
  path: string | null;
  /** Слитая конфигурация */
  config: JsonRecord | null;
  section: AgentSectionView | null;
  /** Все прочитанные файлы в порядке возрастания приоритета */
  files: string[];
  /** Причина, по которой конфигурация не прочитана */
  error?: string;
  /** Некритичное предупреждение (например, заданный путь не найден) */
  warning?: string;
}

/**
 * Читает агентов из opencode.json, понимая V1 (`agent`) и V2 (`agents`).
 * Без явного пути сливает все слои так же, как OpenCode.
 */
export function loadOpenCodeAgents(
  options: { opencodeConfigPath?: string; cwd?: string } = {}
): OpenCodeAgentSnapshot {
  const start = resolve(options.cwd ?? process.cwd());
  const explicit = options.opencodeConfigPath?.trim();
  let files: string[] = [];
  let warning: string | undefined;

  if (explicit !== undefined && explicit.length > 0) {
    const resolved = resolve(start, explicit);
    if (existsSync(resolved)) {
      files = [resolved];
    } else if (!explicit.endsWith('.jsonc') && existsSync(`${resolved}c`)) {
      files = [`${resolved}c`];
    } else {
      files = listOpenCodeConfigPaths(start);
      warning =
        files.length > 0
          ? `opencodeConfigPath "${explicit}" не найден; использовано автоопределение: ${files[files.length - 1]}`
          : `opencodeConfigPath "${explicit}" не найден, конфигурация OpenCode не обнаружена`;
    }
  } else {
    files = listOpenCodeConfigPaths(start);
  }

  if (files.length === 0) {
    return { path: null, config: null, section: null, files, warning };
  }

  const layers: JsonRecord[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const config = readJsonFile(file);
      if (isRecord(config)) {
        layers.push(config);
      } else {
        errors.push(`${file}: ожидается JSON-объект`);
      }
    } catch (error) {
      errors.push(`${file}: ${(error as Error).message}`);
    }
  }

  const path = files[files.length - 1] ?? null;
  if (layers.length === 0) {
    return {
      path,
      config: null,
      section: null,
      files,
      error: errors.join('; ') || 'конфигурация не прочитана',
      warning
    };
  }

  const merged = mergeOpenCodeConfigs(layers);
  return { path, config: merged, section: readAgentSection(merged), files, warning };
}

/** Встроенные агенты OpenCode, которые доступны без записи в opencode.json */
const BUILTIN_OPENCODE_AGENTS = new Set([
  'build',
  'plan',
  'general',
  'explore',
  'compaction',
  'title',
  'summary'
]);

/** Проверяет наличие файлового агента (`.opencode/agents/<name>.md`) */
function hasAgentFile(agentName: string, cwd?: string): boolean {
  if (agentName.includes('..')) return false;

  const start = resolve(cwd ?? process.cwd());
  const chain: string[] = [];
  let current = start;
  for (let depth = 0; depth < 24; depth += 1) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const directories: string[] = [];
  for (const directory of chain) {
    directories.push(resolve(directory, '.opencode', 'agents'));
    directories.push(resolve(directory, '.opencode', 'agent'));
  }
  const configHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  directories.push(resolve(configHome, 'opencode', 'agents'));
  directories.push(resolve(configHome, 'opencode', 'agent'));

  return directories.some(directory => existsSync(resolve(directory, `${agentName}.md`)));
}

/**
 * Проверяет, существует ли агент и какую модель он использует.
 *
 * Нужна для OpenCode V2: `opencode run --agent` не применяет модель агента
 * из конфигурации, поэтому её приходится передавать через `--model`, а для
 * несуществующего агента — сразу запускать default-агент.
 */
export function resolveOpenCodeAgent(
  agentName: string,
  options: { opencodeConfigPath?: string; cwd?: string } = {}
): { exists: boolean; model?: string } {
  if (BUILTIN_OPENCODE_AGENTS.has(agentName)) {
    return { exists: true };
  }
  if (hasAgentFile(agentName, options.cwd)) {
    return { exists: true };
  }

  const snapshot = loadOpenCodeAgents(options);
  const entry = snapshot.section?.entries[agentName];
  if (entry === undefined) {
    return { exists: false };
  }
  return { exists: true, model: readAgentDefinition(entry).model };
}

/**
 * Возвращает модель агента из opencode.json.
 */
export function resolveOpenCodeAgentModel(
  agentName: string,
  options: { opencodeConfigPath?: string; cwd?: string } = {}
): string | undefined {
  return resolveOpenCodeAgent(agentName, options).model;
}

/**
 * Извлекает агентов из раздела opencode.json.
 * Не входит в публичное API слайса, экспортируется для соседнего модуля загрузки.
 */
export function extractAgentsFromOpenCode(
  section: AgentSectionView,
  excludedAgents: string[]
): ExpertConfig[] {
  const excluded = new Set(excludedAgents);
  const agents: ExpertConfig[] = [];
  let priority = 1;

  for (const [name, raw] of Object.entries(section.entries)) {
    if (excluded.has(name)) continue;
    const definition = readAgentDefinition(raw);
    if (definition.mode === 'subagent') continue;
    if (definition.disabled) continue;

    // prompt в opencode.json — это системный промпт агента, OpenCode применит его сам.
    // Для пользовательского сообщения берём task-aware промпт роли по умолчанию.
    agents.push({
      name,
      enabled: true,
      priority,
      model: definition.model,
      prompt: Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, name)
        ? DEFAULT_EXPERT_PROMPTS[name]
        : DEFAULT_EXPERT_PROMPTS.default
    });
    priority += 1;
  }

  return agents;
}
