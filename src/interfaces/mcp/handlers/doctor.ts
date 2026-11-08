// consilium_doctor tool handler.
import { loadConfig } from '../../../application/consilium.js';
import { formatDoctorReport, runDoctor } from '../../../domain/diagnostics/doctor.js';
import { toolText } from './shared.js';
import type { McpToolResult } from './shared.js';

export async function toolDoctor(): Promise<McpToolResult> {
  const loaded = loadConfig();
  const checks = await runDoctor(loaded.config, { configPath: loaded.configPath });
  const report = formatDoctorReport(checks);
  if (loaded.warnings.length === 0) {
    return toolText(report);
  }
  const warnings = loaded.warnings.map(warning => `- ${warning}`).join('\n');
  return toolText(`${report}\n\n### Config warnings\n\n${warnings}`);
}
