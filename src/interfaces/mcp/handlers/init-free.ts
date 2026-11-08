// consilium_init_free tool handler.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildConsiliumConfigFromModels,
  buildCouncilAgents,
  fetchFreeModels,
  selectCouncilModels
} from '../../../domain/models/models.js';
import { verifyModels } from '../../../application/models/verify.js';
import { DEFAULT_CONFIG } from '../../../domain/defaults.js';
import { findOpenCodeConfigPath, readJsonFile } from '../../../infrastructure/config/config.js';
import {
  readAgentDefinition,
  readAgentSection,
  upsertAgents
} from '../../../infrastructure/config/compat.js';
import type { ConsiliumConfig } from '../../../domain/types.js';
import { writeFileAtomic } from '../../../shared/fs.js';
import { cell } from '../format.js';
import {
  describeError,
  isRecord,
  optionalBoolean,
  toolError,
  toolText
} from './shared.js';
import type { McpToolResult } from './shared.js';

type CouncilAgents = ReturnType<typeof buildCouncilAgents>;

function applyFreeSetup(
  agents: CouncilAgents,
  consiliumConfig: ConsiliumConfig,
  force: boolean,
  extraWarnings: string[] = []
): McpToolResult {
  const workingDirectory = consiliumConfig.cwd ?? process.cwd();
  const opencodePath =
    findOpenCodeConfigPath(consiliumConfig.opencodeConfigPath, workingDirectory) ??
    resolve(workingDirectory, 'opencode.json');
  const consiliumPath = resolve(workingDirectory, 'consilium.config.json');

  let baseConfig: Record<string, unknown> = {};
  if (existsSync(opencodePath)) {
    let parsed: unknown;
    try {
      parsed = readJsonFile(opencodePath);
    } catch (error) {
      return toolError(
        `Cannot apply: opencode.json is not valid JSON (${describeError(
          error
        )}). No files were written.`
      );
    }
    if (!isRecord(parsed)) {
      return toolError(
        'Cannot apply: opencode.json must contain a JSON object. No files were written.'
      );
    }
    baseConfig = parsed;
  }

  const section = readAgentSection(baseConfig);
  const definitions: Record<string, { model?: string; prompt?: string; mode?: string }> = {};

  for (const [agentName, proposed] of Object.entries(agents)) {
    const current = section.entries[agentName];
    const currentView = current === undefined ? undefined : readAgentDefinition(current);
    const currentModel = currentView?.model;
    const kept = currentModel !== undefined && currentModel.length > 0 && !force;

    definitions[agentName] = {
      model: kept && currentModel !== undefined ? currentModel : proposed.model,
      prompt: currentView?.prompt ?? proposed.prompt,
      mode: kept ? currentView?.mode ?? proposed.mode : proposed.mode
    };
  }

  const upserted = upsertAgents(baseConfig, definitions, {});
  const nextConfig =
    typeof upserted.config['$schema'] === 'string'
      ? upserted.config
      : { $schema: 'https://opencode.ai/config.json', ...upserted.config };

  writeFileAtomic(opencodePath, `${JSON.stringify(nextConfig, null, 2)}\n`);

  let consiliumWritten = false;
  const warnings: string[] = [...extraWarnings, ...upserted.warnings];
  if (opencodePath.endsWith('.jsonc')) {
    warnings.push(
      `Файл ${opencodePath} перезаписан без комментариев: JSONC-комментарии не сохраняются.`
    );
  }
  if (!existsSync(consiliumPath) || force) {
    writeFileAtomic(consiliumPath, `${JSON.stringify(consiliumConfig, null, 2)}\n`);
    consiliumWritten = true;
  } else {
    warnings.push(
      `Skipped ${consiliumPath}: file already exists (pass "force": true to overwrite).`
    );
  }

  const lines: string[] = [];
  lines.push('## Free-model setup applied');
  lines.push('');
  lines.push('### Written files');
  lines.push(`- ${opencodePath}`);
  if (consiliumWritten) {
    lines.push(`- ${consiliumPath}`);
  }
  lines.push('');
  lines.push('### Assigned models');
  lines.push('');
  lines.push('| Agent | Model |');
  lines.push('| --- | --- |');
  for (const agentName of Object.keys(agents).sort()) {
    const model = definitions[agentName]?.model ?? '(unchanged)';
    lines.push(`| ${cell(agentName)} | ${cell(model)} |`);
  }
  if (warnings.length > 0) {
    lines.push('');
    lines.push('### Warnings');
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  return toolText(lines.join('\n'));
}

export async function toolInitFree(args: Record<string, unknown>): Promise<McpToolResult> {
  const apply = optionalBoolean(args, 'apply') ?? false;
  const force = optionalBoolean(args, 'force') ?? false;
  const verify = optionalBoolean(args, 'verify') ?? false;

  const fetched = await fetchFreeModels({ includeUnavailable: false });
  let pool = fetched.models;
  const verificationWarnings: string[] = [];
  let verification: Array<{ model: string; ok: boolean; error?: string }> = [];

  if (verify) {
    const candidates = pool.slice(0, Math.min(12, pool.length));
    const checks = await verifyModels(candidates, { timeoutMs: 60000, concurrency: 4 });
    verification = checks.map(check => ({
      model: check.model.id,
      ok: check.ok,
      error: check.error
    }));
    const working = checks.filter(check => check.ok).map(check => check.model);
    if (working.length >= 3) {
      pool = working;
    } else {
      verificationWarnings.push(
        `Only ${working.length} model(s) passed verification; using the unverified ranking.`
      );
    }
  }

  const selected = selectCouncilModels(pool, 5);
  if (selected.length === 0) {
    return toolError('No free models are available; cannot build a council configuration.');
  }

  const agents = buildCouncilAgents(selected);
  const council = buildConsiliumConfigFromModels(selected);
  const consiliumConfig: ConsiliumConfig = {
    version: DEFAULT_CONFIG.version ?? '1.0.0',
    experts: council.experts,
    chair: council.chair,
    retry: { ...DEFAULT_CONFIG.retry },
    timeouts: { ...DEFAULT_CONFIG.timeouts },
    output: {
      file: false,
      format: 'markdown',
      progress: true,
      logLevel: 'info'
    },
    autoDiscoverAgents: false
  };

  if (!apply) {
    return toolText(
      JSON.stringify(
        {
          opencodeConfig: { agent: agents },
          consiliumConfig,
          verification,
          warnings: verificationWarnings
        },
        null,
        2
      )
    );
  }

  return applyFreeSetup(agents, consiliumConfig, force, verificationWarnings);
}
