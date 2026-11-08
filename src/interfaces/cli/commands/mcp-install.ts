/**
 * @fileoverview Команда mcp --install: регистрация MCP-сервера в opencode.json
 * @module lv24-opencode-consilium/cli/commands/mcp-install
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import type { CLIOptions } from '../../../domain/types.js';
import { loadConfig } from '../../../application/consilium.js';
import { getOpenCodeVersion } from '../../../infrastructure/opencode/agents.js';
import { findOpenCodeConfigPath, readJsonFile } from '../../../infrastructure/config/config.js';
import { parseOpenCodeVersion, readMcpSection, upsertMcpServer } from '../../../infrastructure/config/compat.js';
import { log, writeJsonAtomic } from '../output.js';

/** Путь к глобальному opencode.json(c) */
function resolveGlobalOpenCodePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  const directory = resolve(configHome, 'opencode');
  const json = resolve(directory, 'opencode.json');
  const jsonc = resolve(directory, 'opencode.jsonc');
  return existsSync(json) ? json : existsSync(jsonc) ? jsonc : json;
}

/**
 * Регистрирует MCP-сервер в конфигурации OpenCode в формате установленной версии.
 * V2 пишет `mcp.servers.<name>` и `disabled`, V1 — `mcp.<name>` и `enabled`.
 */
export async function commandMcpInstall(options: CLIOptions): Promise<number> {
  const global = options.globalConfig === true;
  const loaded = loadConfig(options.config);
  const cwd = loaded.config.cwd ?? process.cwd();

  const path = global
    ? resolveGlobalOpenCodePath()
    : findOpenCodeConfigPath(loaded.config.opencodeConfigPath, cwd) ??
      resolve(cwd, 'opencode.json');

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = readJsonFile(path);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (error) {
      console.error(`❌ Не удалось прочитать ${path}: ${(error as Error).message}`);
      return 1;
    }
  }

  // Формат MCP-секции определяет установленный CLI, а не формат agent-секции:
  // V2 игнорирует плоские записи mcp.<name>.
  let flavor: 'v1' | 'v2' | undefined;
  try {
    const cliMajor = parseOpenCodeVersion(await getOpenCodeVersion(loaded.config)).major;
    flavor = cliMajor === 2 ? 'v2' : cliMajor === 1 ? 'v1' : undefined;
  } catch {
    flavor = undefined;
  }

  const section = readMcpSection(existing);
  const targetFlavor = flavor ?? section.flavor;
  const installedEntry =
    targetFlavor === 'v2' ? section.servers.consilium : section.flat.consilium;

  if (installedEntry !== undefined && !options.force && !options.dryRun) {
    console.log(`ℹ️ MCP-сервер consilium уже есть в ${path} (используйте --force для обновления).`);
    return 0;
  }

  const upserted = upsertMcpServer(
    existing,
    'consilium',
    { command: ['npx', '-y', 'lv24-opencode-consilium', 'mcp'] },
    { flavor: targetFlavor }
  );

  for (const warning of upserted.warnings) {
    log(options, `⚠️ ${warning}`);
  }

  const proposed = {
    $schema:
      typeof existing.$schema === 'string'
        ? existing.$schema
        : 'https://opencode.ai/config.json',
    ...upserted.config
  };

  if (options.dryRun) {
    console.log(JSON.stringify(proposed, null, 2));
    return 0;
  }

  if (path.endsWith('.jsonc')) {
    log(options, '⚠️ Файл .jsonc будет перезаписан без комментариев (они не сохраняются).');
  }

  writeJsonAtomic(path, proposed);
  const key = upserted.key === 'mcp.servers' ? 'mcp.servers.consilium' : 'mcp.consilium';
  const flavorLabel = upserted.flavor === 'v2' ? 'V2' : 'V1';
  console.log(`✅ MCP-сервер зарегистрирован: ${path}`);
  console.log(`   Ключ: ${key} (${flavorLabel}-формат)`);
  console.log('   Проверка: opencode mcp list');
  return 0;
}
