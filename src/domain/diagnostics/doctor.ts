/**
 * @fileoverview Диагностика окружения и конфигурации Consilium
 * @module lv24-opencode-consilium
 */

import type { ConsiliumConfig } from '../types.js';
import { getOpenCodeVersion } from '../../infrastructure/opencode/agents.js';
import { parseOpenCodeVersion } from '../../infrastructure/config/compat.js';
import type { CheckFn, DoctorCheck, DoctorOptions } from './types.js';
import { errorMessage } from './types.js';
import {
  checkAutoApprove,
  checkChair,
  checkConcurrency,
  checkConfigFile,
  checkExperts,
  checkFeatures,
  checkModelsCache,
  checkModelsFormat,
  checkNodeVersion,
  checkOpenCodeCli,
  checkOpenCodeConfig,
  checkOpenCodeV2Compat,
  checkOutputFile,
  checkStandalone,
  checkTimeouts
} from './checks.js';

export type { DoctorCheck, DoctorOptions } from './types.js';
export { formatDoctorReport } from './report.js';

/** Выполняет проверку, превращая исключения в fail */
async function safeCheck(id: string, fn: CheckFn): Promise<DoctorCheck> {
  try {
    return await fn();
  } catch (error) {
    return {
      id,
      status: 'fail',
      message: `Проверка не выполнена: ${errorMessage(error)}`
    };
  }
}

/**
 * Запускает все проверки диагностики
 */
export async function runDoctor(
  config: ConsiliumConfig,
  options: DoctorOptions = {}
): Promise<DoctorCheck[]> {
  const cwd = options.cwd ?? config.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  let versionText: string | null = null;
  try {
    versionText = await getOpenCodeVersion(config);
  } catch {
    versionText = null;
  }
  const cliMajor = parseOpenCodeVersion(versionText).major;

  checks.push(await safeCheck('node-version', () => checkNodeVersion()));
  checks.push(await safeCheck('opencode-cli', () => checkOpenCodeCli(versionText)));
  checks.push(await safeCheck('config-file', () => checkConfigFile(options.configPath)));
  checks.push(await safeCheck('experts-config', () => checkExperts(config)));
  checks.push(await safeCheck('chair-config', () => checkChair(config)));
  checks.push(await safeCheck('timeouts', () => checkTimeouts(config)));
  checks.push(await safeCheck('models-format', () => checkModelsFormat(config)));
  checks.push(await safeCheck('opencode-config', () => checkOpenCodeConfig(config, cwd)));
  checks.push(
    await safeCheck('opencode-v2-compat', () =>
      checkOpenCodeV2Compat(cwd, cliMajor, config.opencodeConfigPath)
    )
  );
  checks.push(await safeCheck('output-file', () => checkOutputFile(config, cwd)));

  if (options.checkModels !== false) {
    checks.push(await safeCheck('models-cache', () => checkModelsCache()));
  }

  checks.push(await safeCheck('concurrency', () => checkConcurrency(config)));
  checks.push(await safeCheck('features', () => checkFeatures(config)));
  checks.push(await safeCheck('standalone', () => checkStandalone(config)));
  checks.push(await safeCheck('auto-approve', () => checkAutoApprove(config)));

  return checks;
}
