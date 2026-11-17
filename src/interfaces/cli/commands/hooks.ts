/**
 * @fileoverview Команда hooks: git pre-commit hook
 * @module lv24-opencode-consilium/cli/commands/hooks
 */

import type { CLIOptions } from '../../../domain/types.js';
import { DEFAULT_CONFIG } from '../../../domain/defaults.js';
import { installPreCommitHook, uninstallPreCommitHook } from '../../../infrastructure/watch.js';

/** Команда pre-commit hook с закреплённой версией пакета */
export function buildHookCommand(version: string | undefined): string {
  const pinned =
    typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)
      ? `lv24-opencode-consilium@${version}`
      : 'lv24-opencode-consilium';
  return `npx -y ${pinned} --staged -s "Ревью staged-изменений" || exit 1`;
}

/** Устанавливает или удаляет git pre-commit hook */
export async function commandHooks(options: CLIOptions): Promise<number> {
  const cwd = process.cwd();

  if (options.hookAction === undefined) {
    console.error('❌ Укажите действие: consilium hooks install|uninstall');
    return 2;
  }

  if (options.hookAction === 'uninstall') {
    const removed = uninstallPreCommitHook(cwd);
    console.log(
      removed
        ? '✅ consilium-блок удалён из pre-commit'
        : 'ℹ️ consilium-блок в pre-commit не найден'
    );
    return 0;
  }

  // Версия закреплена на установленной: хук не должен молча подтягивать
  // новый релиз из npm при каждом коммите.
  const hookCommand = buildHookCommand(DEFAULT_CONFIG.version);
  try {
    const hook = installPreCommitHook(cwd, hookCommand);
    console.log(`✅ pre-commit hook ${hook.created ? 'создан' : 'обновлён'}: ${hook.path}`);
    console.log(`   ${hookCommand}`);
    return 0;
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    return 1;
  }
}
