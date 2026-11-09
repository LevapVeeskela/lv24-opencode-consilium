// consilium_list_agents tool handler.
import { loadConfig } from '../../../application/consilium.js';
import { listPresets } from '../../../domain/council/presets.js';
import type { ConsiliumConfig } from '../../../domain/types.js';
import { cell } from '../format.js';
import { safeJson } from '../protocol.js';
import { isRecord, toolText } from './shared.js';
import type { McpToolResult } from './shared.js';

function formatPresets(presets: unknown): string {
  if (!Array.isArray(presets)) {
    return typeof presets === 'string' && presets.length > 0 ? presets : 'none';
  }

  const entries: string[] = [];
  for (const preset of presets as unknown[]) {
    if (typeof preset === 'string') {
      entries.push(preset);
      continue;
    }
    if (isRecord(preset)) {
      const name = preset['name'];
      if (typeof name === 'string') {
        const description = preset['description'];
        entries.push(
          typeof description === 'string' ? `${name} — ${description}` : name
        );
        continue;
      }
    }
    entries.push(safeJson(preset));
  }
  return entries.length > 0 ? entries.join(', ') : 'none';
}

function formatAgentsReport(
  config: ConsiliumConfig,
  configPath: string | null,
  presets: unknown
): string {
  const lines: string[] = [];
  lines.push('## Consilium agents');
  lines.push('');
  lines.push(`Config file: ${configPath ?? '(none, using defaults)'}`);
  lines.push('');
  lines.push(`### Experts (${config.experts.length})`);
  lines.push('');
  lines.push('| Name | Model | Enabled | Prompt length |');
  lines.push('| --- | --- | --- | --- |');

  for (const expert of config.experts) {
    const promptLength =
      typeof expert.prompt === 'function'
        ? `function (${expert.prompt.toString().length} chars)`
        : expert.prompt !== undefined
          ? `${expert.prompt.length} chars`
          : 'default';
    lines.push(
      `| ${cell(expert.name)} | ${cell(expert.model ?? '(default)')} | ${
        expert.enabled === false ? 'no' : 'yes'
      } | ${cell(promptLength)} |`
    );
  }

  lines.push('');
  lines.push('### Chair');
  lines.push('');
  lines.push(`- Agent: ${config.chair.agent}`);
  lines.push(`- Model: ${config.chair.model ?? '(default)'}`);
  lines.push(
    `- Max expert text length: ${config.chair.maxExpertTextLength ?? '(default)'}`
  );
  lines.push('');
  lines.push('### Presets');
  lines.push('');
  lines.push(formatPresets(presets));
  return lines.join('\n');
}

export async function toolListAgents(): Promise<McpToolResult> {
  const loaded = loadConfig();
  let presets: unknown = [];
  try {
    presets = await listPresets(loaded.config.presets);
  } catch {
    presets = [];
  }
  return toolText(formatAgentsReport(loaded.config, loaded.configPath, presets));
}
