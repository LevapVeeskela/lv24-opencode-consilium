/**
 * @fileoverview Чтение и запись раздела MCP-серверов opencode.json(c)
 * @module lv24-opencode-consilium
 *
 * V1 хранит серверы плоско в `mcp.<name>`, V2 — в `mcp.servers.<name>`.
 * V2 игнорирует плоские записи, поэтому формат выбирается по файлу.
 */

import { detectConfigFlavor, isRecord, recordOf, type ConfigFlavor } from './readers.js';

/** Содержимое раздела MCP-серверов в opencode.json */
export interface McpSectionView {
  flavor: ConfigFlavor;
  servers: Record<string, Record<string, unknown>>;
  /** Плоские записи `mcp.<name>`, которые V2 игнорирует */
  flat: Record<string, Record<string, unknown>>;
  /** Имена, заданные и в `mcp.<name>`, и в `mcp.servers` */
  duplicated: string[];
}

/** Описание локального MCP-сервера */
export interface McpLocalServerSpec {
  command: string[];
  environment?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

/** Результат записи MCP-сервера */
export interface UpsertMcpResult {
  config: Record<string, unknown>;
  flavor: ConfigFlavor;
  key: 'mcp' | 'mcp.servers';
  warnings: string[];
}

/**
 * Читает MCP-серверы из конфигурации OpenCode.
 * V1 хранит их плоско в `mcp.<name>`, V2 — в `mcp.servers.<name>`.
 */
export function readMcpSection(config: unknown): McpSectionView {
  const root = recordOf(config);
  const mcp = recordOf(root.mcp);
  const flavor = detectConfigFlavor(root);

  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(recordOf(mcp.servers))) {
    servers[name] = recordOf(entry);
  }

  const flat: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(mcp)) {
    if (name === 'servers' || name === 'timeout') continue;
    if (!isRecord(entry)) continue;
    flat[name] = entry;
  }

  const duplicated = Object.keys(flat).filter(name =>
    Object.prototype.hasOwnProperty.call(servers, name)
  );

  return { flavor, servers, flat, duplicated };
}

/** Собирает запись MCP-сервера в формате нужной версии */
export function buildMcpServerEntry(
  flavor: ConfigFlavor,
  spec: McpLocalServerSpec
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: 'local',
    command: [...spec.command]
  };

  if (spec.environment !== undefined && Object.keys(spec.environment).length > 0) {
    entry.environment = { ...spec.environment };
  }
  if (spec.cwd !== undefined && spec.cwd.trim().length > 0) {
    entry.cwd = spec.cwd.trim();
  }

  if (flavor === 'v2') {
    if (spec.enabled === false) entry.disabled = true;
  } else if (spec.enabled === false) {
    entry.enabled = false;
  }

  return entry;
}

/**
 * Записывает MCP-сервер в конфигурацию OpenCode.
 * V2 игнорирует плоские записи `mcp.<name>`, поэтому формат выбирается по файлу.
 */
export function upsertMcpServer(
  config: unknown,
  name: string,
  spec: McpLocalServerSpec,
  options: { flavor?: ConfigFlavor } = {}
): UpsertMcpResult {
  const root = recordOf(config);
  const section = readMcpSection(root);
  const flavor = options.flavor ?? section.flavor;
  const warnings: string[] = [];

  const mcp: Record<string, unknown> = { ...recordOf(root.mcp) };

  if (flavor === 'v2') {
    const servers: Record<string, unknown> = { ...recordOf(mcp.servers) };
    const existing = recordOf(servers[name]);
    servers[name] = { ...existing, ...buildMcpServerEntry('v2', spec) };
    mcp.servers = servers;

    if (Object.prototype.hasOwnProperty.call(section.flat, name)) {
      warnings.push(
        `Плоская запись mcp.${name} игнорируется OpenCode V2. Удалите её, чтобы не было двух источников правды.`
      );
    }
  } else {
    const existing = recordOf(mcp[name]);
    mcp[name] = { ...existing, ...buildMcpServerEntry('v1', spec) };
    if (Object.prototype.hasOwnProperty.call(section.servers, name)) {
      warnings.push(
        `OpenCode V1 не читает mcp.servers.${name}; запись добавлена в плоский раздел mcp.`
      );
    }
  }

  return {
    config: { ...root, mcp },
    flavor,
    key: flavor === 'v2' ? 'mcp.servers' : 'mcp',
    warnings
  };
}

/** Ссылка на команду установки MCP-сервера для текущего формата */
export function describeMcpShellCommand(name: string, flavor: ConfigFlavor): string {
  if (flavor === 'v2') {
    return `opencode mcp add ${name} -- npx -y lv24-opencode-consilium mcp`;
  }
  return 'mcp.consilium: { "type": "local", "command": ["npx", "-y", "lv24-opencode-consilium", "mcp"] }';
}
