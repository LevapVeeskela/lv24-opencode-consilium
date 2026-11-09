/**
 * @fileoverview Команда presets: встроенные и пользовательские пресеты
 * @module lv24-opencode-consilium/cli/commands/presets
 */

import type { CLIOptions } from '../../../domain/types.js';
import { loadConfig } from '../../../application/consilium.js';
import { formatPresets, listPresets } from '../../../domain/council/presets.js';
import { UsageError } from '../args.js';

export async function commandPresets(options: CLIOptions): Promise<number> {
  const loaded = loadConfig(options.config, {
    trustProjectConfig: options.config !== undefined
  });
  if (options.config && (!loaded.configPath || (loaded.errors?.length ?? 0) > 0)) {
    throw new UsageError(
      loaded.errors?.[0] ?? `Файл конфигурации не найден: ${options.config}`
    );
  }
  if (!options.silent) {
    for (const warning of loaded.warnings) {
      console.error(`⚠️ ${warning}`);
    }
  }

  const presets = listPresets(loaded.config.presets);
  if (options.json) {
    console.log(JSON.stringify(presets, null, 2));
  } else {
    console.log(formatPresets(presets));
  }
  return 0;
}
