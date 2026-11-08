/**
 * @fileoverview Команда hooks: git pre-commit hook
 * @module lv24-opencode-consilium/cli/commands/hooks
 */

import type { CLIOptions } from '../../../domain/types.js';
import { installPreCommitHook, uninstallPreCommitHook } from '../../../infrastructure/watch.js';

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

  const hookCommand =
    'npx -y lv24-opencode-consilium --staged -s "Ревью staged-изменений" || exit 1';
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
