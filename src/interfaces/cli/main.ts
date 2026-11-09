#!/usr/bin/env node

/**
 * @fileoverview CLI интерфейс для Consilium
 * @module lv24-opencode-consilium/cli
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { CLIOptions } from '../../domain/types.js';
import { startMcpServer } from '../mcp/mcp.js';
import { EXIT_CODES, parseArgs, UsageError } from './args.js';
import { printHelp } from './help.js';
import { commandRun } from './commands/run.js';
import { commandInit } from './commands/init.js';
import { commandModels } from './commands/models.js';
import { commandDoctor } from './commands/doctor.js';
import { commandMcpInstall } from './commands/mcp-install.js';
import { commandWatch } from './commands/watch.js';
import { commandHooks } from './commands/hooks.js';
import { commandBaseline } from './commands/baseline.js';
import { commandEval } from './commands/eval.js';
import { commandHistory, commandStats } from './commands/history.js';
import { commandPresets } from './commands/presets.js';
import { commandAudit } from './commands/audit.js';

export { applyCliOverrides } from './overrides.js';

export function readVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL('../../../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(packagePath, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: CLIOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`❌ ${error.message}`);
      return EXIT_CODES.usage;
    }
    throw error;
  }

  const command = options.command ?? 'run';

  try {
    switch (command) {
      case 'help':
        printHelp();
        return EXIT_CODES.success;
      case 'version':
        console.log(`consilium v${readVersion()}`);
        return EXIT_CODES.success;
      case 'init':
        return await commandInit(options);
      case 'models':
        return await commandModels(options);
      case 'doctor':
        return await commandDoctor(options);
      case 'mcp': {
        if (options.mcpInstall === true) {
          return await commandMcpInstall(options);
        }
        if (!options.silent) console.error('lv24-opencode-consilium MCP server (stdio). Логи — в stderr.');
        await startMcpServer({ version: readVersion() });
        return EXIT_CODES.success;
      }
      case 'watch':
        return await commandWatch(options);
      case 'hooks':
        return await commandHooks(options);
      case 'baseline':
        return await commandBaseline(options);
      case 'eval':
        return await commandEval(options);
      case 'history':
        return await commandHistory(options);
      case 'stats':
        return await commandStats(options);
      case 'presets':
        return await commandPresets(options);
      case 'audit':
        return await commandAudit(options);
      case 'run':
        return await commandRun(options);
      default:
        console.error(`❌ Неизвестная команда: ${command}`);
        return EXIT_CODES.usage;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`❌ ${error.message}`);
      return EXIT_CODES.usage;
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedDirectly) {
  main()
    .then(code => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error('💥 Критическая ошибка:', error);
      process.exitCode = 1;
    });
}
