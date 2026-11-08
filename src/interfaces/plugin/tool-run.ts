/**
 * @fileoverview Shared use-case for running the Consilium council as a tool.
 * Used by the native OpenCode V2 plugin (and, later, other hosts).
 * No MCP or `@opencode/plugin` imports here — pure library orchestration.
 * @module lv24-opencode-consilium/tool-run
 */

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Consilium, cloneConfig, loadConfig } from '../../application/consilium.js';
import { CONFIG_FILE_NAMES } from '../../domain/defaults.js';
import { applyPreset } from '../../domain/council/presets.js';
import type { ConsiliumConfig, ConsiliumResult, RunOptions } from '../../domain/types.js';

/** Загружает конфиг из workspace активного проекта, если он там есть */
function loadConfigForWorkspace(workspace: string | undefined): ConsiliumConfig {
  if (workspace !== undefined) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = resolve(workspace, name);
      if (existsSync(candidate)) {
        return loadConfig(candidate).config;
      }
    }
  }
  return loadConfig().config;
}

/**
 * Arguments accepted by {@link runConsiliumTool}.
 */
export interface ToolRunArgs {
  task: string;
  experts?: string[];
  chair?: string;
  timeoutMs?: number;
  consensus?: boolean;
  smartExperts?: boolean;
  maxCost?: number;
  fallbackModels?: string[];
  session?: string;
  artifacts?: boolean | string;
  preset?: string;
}

/**
 * Totally ordered result of {@link runConsiliumTool}.
 */
export interface ToolRunResult {
  text: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

/** Опции выполнения инструмента (отмена из хоста) */
export interface ToolRunOptions {
  signal?: AbortSignal;
  /** Рабочая директория активного проекта (OpenCode V2 передаёт её в ctx.location.directory) */
  workspace?: string;
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Formats a council result for chat display: chair text, expert opinions
 * (truncated to 4000 chars each) and a JSON summary block.
 */
export function formatToolResult(result: ConsiliumResult): string {
  const sections: string[] = [result.text, '---', '## Мнения экспертов'];

  for (const expert of result.experts) {
    sections.push(`### ${expert.agent} (${expert.model ?? 'default'})`);
    sections.push(truncateText(expert.text, 4000));
  }

  const consensusSource = result.metadata?.consensus;
  let consensus: { agreement: unknown; averageSimilarity: unknown } | undefined;
  if (
    consensusSource !== null &&
    typeof consensusSource === 'object' &&
    !Array.isArray(consensusSource)
  ) {
    const report = consensusSource as {
      agreement?: unknown;
      averageSimilarity?: unknown;
    };
    consensus = {
      agreement: report.agreement,
      averageSimilarity: report.averageSimilarity
    };
  }

  const models: Record<string, string> = {};
  for (const expert of result.experts) {
    if (expert.model) models[expert.agent] = expert.model;
  }

  const summary = {
    success: result.success,
    totalTime: result.totalTime,
    usage: result.usage,
    cost: result.metadata?.cost,
    consensus,
    models
  };

  sections.push('```json');
  sections.push(JSON.stringify(summary, null, 2));
  sections.push('```');

  const artifacts = result.metadata?.artifacts;
  if (artifacts !== null && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
    const dir = (artifacts as { dir?: unknown }).dir;
    if (typeof dir === 'string') {
      sections.push(`**Artifacts:** \`${dir}\``);
    }
  }

  return sections.join('\n\n');
}

/**
 * Runs the council with the given tool arguments.
 * Throws on empty task or unknown preset; never catches run errors
 * (the caller maps them to a visible tool result).
 */
export async function runConsiliumTool(
  args: ToolRunArgs,
  baseConfig?: ConsiliumConfig,
  options: ToolRunOptions = {}
): Promise<ToolRunResult> {
  const task = args.task;
  if (typeof task !== 'string' || task.trim().length === 0) {
    throw new Error('"task" is required and must be a non-empty string');
  }

  if (options.signal?.aborted === true) {
    throw new Error('Consilium run aborted');
  }

  const workspace = options.workspace?.trim();
  let config: ConsiliumConfig =
    baseConfig !== undefined
      ? cloneConfig(baseConfig)
      : loadConfigForWorkspace(workspace);

  if (config.cwd === undefined && workspace !== undefined && workspace.length > 0) {
    config.cwd = workspace;
  }

  if (args.preset !== undefined) {
    // applyPreset throws on unknown preset names — surfaced to the caller.
    config = applyPreset(config, args.preset);
  }
  if (args.consensus !== undefined) config.consensus = args.consensus;
  if (args.smartExperts !== undefined) config.smartExperts = args.smartExperts;
  if (args.maxCost !== undefined) config.maxCost = args.maxCost;
  if (args.fallbackModels !== undefined) config.fallbackModels = args.fallbackModels;
  if (args.session !== undefined) config.session = args.session;

  if (typeof args.artifacts === 'string') {
    const workspace = resolve(config.cwd ?? process.cwd());
    const target = resolve(workspace, args.artifacts);
    const rel = relative(workspace, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('"artifacts" must stay inside the workspace');
    }
    config.artifacts = target;
  } else if (args.artifacts !== undefined) {
    config.artifacts = args.artifacts;
  }

  const runOptions: RunOptions = {};
  if (args.experts !== undefined) runOptions.experts = args.experts;
  if (args.chair !== undefined) runOptions.chair = args.chair;
  if (args.timeoutMs !== undefined) runOptions.timeout = args.timeoutMs;

  const consilium = new Consilium(config);
  const onAbort = (): void => {
    consilium.cancel();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const result = await consilium.run(task, runOptions);
    return {
      text: formatToolResult(result),
      isError: !result.success,
      metadata: result.metadata
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
