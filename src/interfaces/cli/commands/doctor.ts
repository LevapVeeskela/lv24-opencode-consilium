/**
 * @fileoverview Команда doctor: диагностика окружения
 * @module lv24-opencode-consilium/cli/commands/doctor
 */

import type { CLIOptions } from '../../../domain/types.js';
import { loadConfig } from '../../../application/consilium.js';
import { formatDoctorReport, runDoctor } from '../../../application/diagnostics/doctor.js';

export async function commandDoctor(options: CLIOptions): Promise<number> {
  const loaded = loadConfig(options.config, { trustProjectConfig: options.config !== undefined });
  if (loaded.warnings.length > 0 && !options.silent) {
    for (const warning of loaded.warnings) {
      console.error(`⚠️ ${warning}`);
    }
  }
  const checks = await runDoctor(loaded.config, {
    configPath: loaded.configPath,
    cwd: process.cwd(),
    checkModels: true
  });
  console.log(formatDoctorReport(checks));
  if ((loaded.errors?.length ?? 0) > 0) {
    return 1;
  }
  return checks.some(check => check.status === 'fail') ? 1 : 0;
}
