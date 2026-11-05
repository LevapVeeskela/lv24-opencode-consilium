import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Consilium, loadConfig } from './index.js';
import { readJsonFile } from './config.js';
import type {
  ConsiliumConfig,
  ConsiliumResult,
  ProgressEvent,
  RunOptions
} from './types.js';
import type { FreeModel } from './models.js';
import {
  buildConsiliumConfigFromModels,
  buildCouncilAgents,
  fetchFreeModels,
  selectCouncilModels
} from './models.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { verifyModels } from './verify.js';
import { applyPreset, listPresets } from './presets.js';
import { DEFAULT_CONFIG } from './defaults.js';

const DEFAULT_VERSION = '1.1.0';
const SERVER_NAME = 'opencode-consilium';
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18'
];
const OUTPUT_FORMATS = ['text', 'markdown', 'json'] as const;
const PRESET_NAMES = ['fast', 'deep', 'security', 'review', 'free'] as const;

type OutputFormat = (typeof OUTPUT_FORMATS)[number];
type PresetName = (typeof PRESET_NAMES)[number];
type ProgressToken = string | number;
type RequestId = string | number | null;
type NotificationSink = (message: Record<string, unknown>) => void;
type CouncilAgents = ReturnType<typeof buildCouncilAgents>;

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: RequestId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpTextContent {
  type: 'text';
  text: string;
}

interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: { listChanged: boolean };
    logging: Record<string, never>;
  };
  serverInfo: { name: string; version: string };
  instructions: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface StartMcpServerOptions {
  version?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

let notificationSink: NotificationSink | null = null;
let activeConsilium: Consilium | null = null;
let activeRunRequestId: RequestId | undefined;

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'consilium_run',
    description:
      'Run a council of expert AI agents through the OpenCode CLI. Experts analyze the task in parallel and the chair synthesizes the final answer.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          minLength: 1,
          description: 'Task for the expert council.'
        },
        experts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Expert agent names to use (default: all enabled experts).'
        },
        chair: {
          type: 'string',
          description: 'Chair agent name (default: from configuration).'
        },
        timeout_ms: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Timeout per expert in milliseconds.'
        },
        output_file: {
          type: 'string',
          description: 'Optional path for saving the result (must stay inside the workspace).'
        },
        format: {
          type: 'string',
          enum: [...OUTPUT_FORMATS],
          description: 'Format used when the result is saved.'
        },
        preset: {
          type: 'string',
          enum: [...PRESET_NAMES],
          description: 'Configuration preset applied before the run.'
        }
      },
      required: ['task']
    }
  },
  {
    name: 'consilium_list_agents',
    description:
      'List configured consilium experts, the chair agent, the active config path and available presets.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'consilium_free_models',
    description:
      'List free OpenCode models discovered from provider catalogs with context length, tool support, reasoning, score and availability.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 15,
          description: 'Maximum number of models to show.'
        },
        available_only: {
          type: 'boolean',
          default: false,
          description: 'Show only models marked as available.'
        },
        refresh: {
          type: 'boolean',
          default: false,
          description: 'Ignore the cache and refresh the model catalog.'
        }
      },
      required: []
    }
  },
  {
    name: 'consilium_doctor',
    description: 'Run environment and configuration diagnostics for opencode-consilium.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'consilium_init_free',
    description:
      'Propose (dry run) or apply a free-model council setup. Apply merges agents into opencode.json and writes consilium.config.json.',
    inputSchema: {
      type: 'object',
      properties: {
        apply: {
          type: 'boolean',
          default: false,
          description: 'Write the proposal to opencode.json and consilium.config.json.'
        },
        force: {
          type: 'boolean',
          default: false,
          description: 'Overwrite existing agent models and consilium.config.json.'
        },
        verify: {
          type: 'boolean',
          default: false,
          description: 'Probe candidate models with a tiny real request before selecting.'
        }
      },
      required: []
    }
  }
];

const MCP_TOOL_NAMES = new Set(MCP_TOOLS.map((tool) => tool.name));

export function getMcpTools(): McpToolDef[] {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: tool.inputSchema.type,
      properties: { ...tool.inputSchema.properties },
      required: [...tool.inputSchema.required]
    }
  }));
}

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function formatTimestamp(milliseconds: number): string {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? String(milliseconds) : date.toISOString();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolInputError(`"${key}" must be a string`);
  }
  return value;
}

function requireNonEmptyString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value.trim().length === 0) {
    throw new ToolInputError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ToolInputError(`"${key}" must be an array of strings`);
  }
  const items: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') {
      throw new ToolInputError(`"${key}" must be an array of strings`);
    }
    items.push(item);
  }
  return items;
}

function optionalPositiveNumber(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ToolInputError(`"${key}" must be a positive number`);
  }
  return value;
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ToolInputError(`"${key}" must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ToolInputError(`"${key}" must be a boolean`);
  }
  return value;
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ToolInputError(`"${key}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function toolText(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function toolError(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function jsonRpcSuccess(id: RequestId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(
  id: RequestId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return data === undefined
    ? { jsonrpc: '2.0', id, error: { code, message } }
    : { jsonrpc: '2.0', id, error: { code, message, data } };
}

function normalizeRequestId(value: unknown): RequestId {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function extractProgressToken(
  params: Record<string, unknown>
): ProgressToken | undefined {
  const meta = params['_meta'];
  if (!isRecord(meta)) return undefined;
  const token = meta['progressToken'];
  if (typeof token === 'string' || typeof token === 'number') return token;
  return undefined;
}

function emitNotification(message: Record<string, unknown>): void {
  const sink = notificationSink;
  if (sink === null) return;
  try {
    sink(message);
  } catch {
    // Progress notifications are best-effort.
  }
}

function formatConsiliumResult(result: ConsiliumResult): string {
  const sections: string[] = [result.text, '---', '## Мнения экспертов'];

  for (const expert of result.experts) {
    sections.push(`### ${expert.agent} (${expert.model ?? 'default'})`);
    sections.push(truncateText(expert.text, 4000));
  }

  sections.push('---');
  const summary = {
    success: result.success,
    totalTime: result.totalTime,
    parallelTime: result.parallelTime,
    usage: result.usage,
    experts: result.experts.map((expert) => ({
      agent: expert.agent,
      model: expert.model,
      success: expert.success,
      duration: expert.duration,
      errorCode: expert.errorCode,
      usage: expert.usage
    }))
  };
  sections.push('```json');
  sections.push(JSON.stringify(summary, null, 2));
  sections.push('```');

  const savedFile = result.metadata?.savedFile;
  const saveError = result.metadata?.saveError;
  if (typeof savedFile === 'string') {
    sections.push(`**Saved to:** \`${savedFile}\``);
  } else if (typeof saveError === 'string') {
    sections.push(`**Save failed:** ${saveError}`);
  }

  return sections.join('\n\n');
}

function resolveOutputFile(outputFile: string | undefined): { value?: string; error?: string } {
  if (outputFile === undefined || outputFile.trim().length === 0) {
    return {};
  }
  const cwd = process.cwd();
  const resolved = resolve(cwd, outputFile);
  const prefix = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
  if (!resolved.startsWith(prefix)) {
    return {
      error: `output_file must stay inside the workspace (${cwd}); got: ${outputFile}`
    };
  }
  return { value: resolved };
}

function applyPresetFor(config: ConsiliumConfig, name: PresetName): ConsiliumConfig {
  return applyPreset(config, name as Parameters<typeof applyPreset>[1]);
}

async function toolConsiliumRun(
  args: Record<string, unknown>,
  progressToken: ProgressToken | undefined,
  requestId?: RequestId
): Promise<McpToolResult> {
  const task = requireNonEmptyString(args, 'task');
  const experts = optionalStringArray(args, 'experts');
  const chair = optionalString(args, 'chair');
  const timeoutMs = optionalPositiveNumber(args, 'timeout_ms');
  const outputFile = optionalString(args, 'output_file');
  const format: OutputFormat | undefined = optionalEnum(args, 'format', OUTPUT_FORMATS);
  const preset: PresetName | undefined = optionalEnum(args, 'preset', PRESET_NAMES);

  const outputPath = resolveOutputFile(outputFile);
  if (outputPath.error !== undefined) {
    return toolError(outputPath.error);
  }

  const loaded = loadConfig();
  let config = loaded.config;
  if (preset !== undefined) {
    config = applyPresetFor(config, preset);
  }
  if (format !== undefined) {
    config.output.format = format;
  }
  if (outputPath.value !== undefined) {
    config.output.file = outputPath.value;
  }

  const runOptions: RunOptions = {};
  if (experts !== undefined) runOptions.experts = experts;
  if (chair !== undefined) runOptions.chair = chair;
  if (timeoutMs !== undefined) runOptions.timeout = timeoutMs;
  if (outputPath.value !== undefined) runOptions.outputFile = outputPath.value;

  const enabledCount = config.experts.filter((expert) => expert.enabled !== false).length;
  const expertCount = experts !== undefined && experts.length > 0 ? experts.length : enabledCount;
  const total = Math.max(1, expertCount) + 1;

  const consilium = new Consilium(config);
  let unsubscribe: (() => void) | undefined;
  let startedExperts = 0;

  if (progressToken !== undefined) {
    unsubscribe = consilium.onProgress((event: ProgressEvent) => {
      let progress: number;
      let message: string;
      if (event.type === 'expert_start') {
        startedExperts += 1;
        progress = Math.min(startedExperts, total - 1);
        message = `Expert ${event.agent ?? ''} started`.trim();
      } else if (event.type === 'chair_start') {
        progress = Math.max(1, total - 1);
        message = 'Chair is synthesizing the final answer';
      } else if (event.type === 'chair_end') {
        progress = total;
        message = 'Consilium completed';
      } else {
        return;
      }
      emitNotification({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          total,
          message
        }
      });
    });
  }

  activeConsilium = consilium;
  activeRunRequestId = requestId;
  try {
    const result = await consilium.run(task, runOptions);
    let text = formatConsiliumResult(result);
    if (loaded.warnings.length > 0) {
      text += `\n\n---\n\n**Config warnings**\n${loaded.warnings.map(w => `- ${w}`).join('\n')}`;
    }
    return {
      content: [{ type: 'text', text }],
      isError: result.success === false
    };
  } catch (error) {
    return toolError(`Consilium run failed: ${describeError(error)}`);
  } finally {
    if (unsubscribe !== undefined) unsubscribe();
    if (activeConsilium === consilium) activeConsilium = null;
    if (activeConsilium === null) activeRunRequestId = undefined;
  }
}

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

async function toolListAgents(): Promise<McpToolResult> {
  const loaded = loadConfig();
  let presets: unknown = [];
  try {
    presets = await listPresets();
  } catch {
    presets = [];
  }
  return toolText(formatAgentsReport(loaded.config, loaded.configPath, presets));
}

const MODEL_ID_KEYS = ['id', 'model', 'modelId', 'model_id', 'name', 'slug'] as const;
const MODEL_CONTEXT_KEYS = [
  'contextLength',
  'context_length',
  'contextWindow',
  'context_window',
  'context',
  'maxContext',
  'max_context',
  'limit'
] as const;
const MODEL_TOOLS_KEYS = [
  'supportsTools',
  'supports_tools',
  'tools',
  'toolCall',
  'tool_call',
  'functionCalling',
  'function_calling'
] as const;
const MODEL_REASONING_KEYS = [
  'reasoning',
  'supportsReasoning',
  'supports_reasoning',
  'thinking'
] as const;
const MODEL_SCORE_KEYS = [
  'score',
  'quality',
  'rank',
  'rating',
  'benchmarkScore',
  'benchmark_score'
] as const;
const MODEL_AVAILABLE_KEYS = [
  'available',
  'isAvailable',
  'is_available',
  'hasKey',
  'has_key'
] as const;
const MODEL_SOURCE_KEYS = ['source', 'provider', 'origin'] as const;

function readModelValue(model: FreeModel, keys: readonly string[]): unknown {
  const record = model as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return '?';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeJson(value);
}

function flagValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'available', 'supported'].includes(normalized)) return true;
    if (['false', 'no', '0', 'unavailable', 'unsupported'].includes(normalized)) return false;
  }
  return undefined;
}

function readModelFlag(model: FreeModel, keys: readonly string[]): boolean | undefined {
  return flagValue(readModelValue(model, keys));
}

function renderFlag(model: FreeModel, keys: readonly string[]): string {
  const flag = readModelFlag(model, keys);
  if (flag === undefined) return '?';
  return flag ? 'yes' : 'no';
}

function renderContext(model: FreeModel): string {
  const value = readModelValue(model, MODEL_CONTEXT_KEYS);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return displayValue(value);
}

async function toolFreeModels(args: Record<string, unknown>): Promise<McpToolResult> {
  const limit = optionalInteger(args, 'limit', 1, 50) ?? 15;
  const availableOnly = optionalBoolean(args, 'available_only') ?? false;
  const refresh = optionalBoolean(args, 'refresh') ?? false;

  const fetched = await fetchFreeModels({
    forceRefresh: refresh,
    includeUnavailable: !availableOnly
  });
  const filtered = availableOnly
    ? fetched.models.filter((model) => readModelFlag(model, MODEL_AVAILABLE_KEYS) === true)
    : fetched.models;
  const visible = filtered.slice(0, limit);

  const lines: string[] = [];
  lines.push('## Free OpenCode models');
  lines.push('');
  lines.push(
    `Cache: ${fetched.fromCache ? 'hit' : 'miss'}; fetched at ${formatTimestamp(
      fetched.fetchedAt
    )}`
  );
  lines.push('');
  lines.push('### Sources');
  if (fetched.sources.length === 0) {
    lines.push('- (no sources reported)');
  } else {
    for (const source of fetched.sources) {
      const status = source.ok
        ? `ok (${source.count} models)`
        : `failed${source.error !== undefined ? ` — ${source.error}` : ''}`;
      lines.push(`- ${source.source}: ${status}`);
    }
  }
  lines.push('');
  lines.push(`### Models (${visible.length} of ${filtered.length})`);
  lines.push('');
  if (visible.length === 0) {
    lines.push('No models matched the request.');
  } else {
    lines.push('| rank | model id | ctx | tools | reasoning | score | available | source |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    visible.forEach((model, index) => {
      const id = displayValue(readModelValue(model, MODEL_ID_KEYS));
      const score = displayValue(readModelValue(model, MODEL_SCORE_KEYS));
      const source = displayValue(readModelValue(model, MODEL_SOURCE_KEYS));
      lines.push(
        `| ${index + 1} | ${cell(id)} | ${cell(renderContext(model))} | ${cell(
          renderFlag(model, MODEL_TOOLS_KEYS)
        )} | ${cell(renderFlag(model, MODEL_REASONING_KEYS))} | ${cell(score)} | ${cell(
          renderFlag(model, MODEL_AVAILABLE_KEYS)
        )} | ${cell(source)} |`
      );
    });
  }
  return toolText(lines.join('\n'));
}

async function toolDoctor(): Promise<McpToolResult> {
  const loaded = loadConfig();
  const checks = await runDoctor(loaded.config, { configPath: loaded.configPath });
  const report = formatDoctorReport(checks);
  if (loaded.warnings.length === 0) {
    return toolText(report);
  }
  const warnings = loaded.warnings.map(warning => `- ${warning}`).join('\n');
  return toolText(`${report}\n\n### Config warnings\n\n${warnings}`);
}

function writeFileAtomic(filePath: string, content: string): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = resolve(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  writeFileSync(temporaryPath, content, 'utf-8');
  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Ignore cleanup failures and surface the original error.
    }
    throw error;
  }
}

function applyFreeSetup(
  agents: CouncilAgents,
  consiliumConfig: ConsiliumConfig,
  force: boolean,
  extraWarnings: string[] = []
): McpToolResult {
  const workingDirectory = process.cwd();
  const opencodeJson = resolve(workingDirectory, 'opencode.json');
  const opencodeJsonc = resolve(workingDirectory, 'opencode.jsonc');
  const opencodePath = existsSync(opencodeJson)
    ? opencodeJson
    : existsSync(opencodeJsonc)
      ? opencodeJsonc
      : opencodeJson;
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

  const existingAgents = isRecord(baseConfig['agent']) ? baseConfig['agent'] : {};
  const mergedAgents: Record<string, unknown> = { ...existingAgents };

  for (const [agentName, proposed] of Object.entries(agents)) {
    const current = isRecord(mergedAgents[agentName]) ? mergedAgents[agentName] : {};
    const currentModel = typeof current['model'] === 'string' ? current['model'] : '';

    if (currentModel.length > 0 && !force) {
      mergedAgents[agentName] = current;
      continue;
    }

    mergedAgents[agentName] = {
      ...current,
      model: proposed.model,
      mode: proposed.mode,
      prompt: proposed.prompt
    };
  }

  writeFileAtomic(
    opencodePath,
    `${JSON.stringify({ ...baseConfig, agent: mergedAgents }, null, 2)}\n`
  );

  let consiliumWritten = false;
  const warnings: string[] = [...extraWarnings];
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
    const record = isRecord(mergedAgents[agentName]) ? mergedAgents[agentName] : {};
    const model = typeof record['model'] === 'string' ? record['model'] : '(unchanged)';
    lines.push(`| ${cell(agentName)} | ${cell(model)} |`);
  }
  if (warnings.length > 0) {
    lines.push('');
    lines.push('### Warnings');
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  return toolText(lines.join('\n'));
}

async function toolInitFree(args: Record<string, unknown>): Promise<McpToolResult> {
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

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  progressToken: ProgressToken | undefined,
  requestId?: RequestId
): Promise<McpToolResult> {
  try {
    switch (name) {
      case 'consilium_run':
        return await toolConsiliumRun(args, progressToken, requestId);
      case 'consilium_list_agents':
        return await toolListAgents();
      case 'consilium_free_models':
        return await toolFreeModels(args);
      case 'consilium_doctor':
        return await toolDoctor();
      case 'consilium_init_free':
        return await toolInitFree(args);
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return toolError(describeError(error));
  }
}

function buildInitializeResult(
  params: Record<string, unknown> | undefined,
  version: string
): InitializeResult {
  const requested =
    params !== undefined && typeof params['protocolVersion'] === 'string'
      ? params['protocolVersion']
      : '';
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : FALLBACK_PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      logging: {}
    },
    serverInfo: { name: SERVER_NAME, version },
    instructions:
      'opencode-consilium runs a council of expert AI agents through the OpenCode CLI. Use consilium_run to ask the council a task, consilium_list_agents to inspect configured experts, consilium_free_models to discover free models, consilium_doctor to diagnose setup issues, and consilium_init_free to propose or apply a free-model configuration.'
  };
}

async function dispatchMcpMethod(
  method: string,
  params: Record<string, unknown> | undefined,
  id: RequestId,
  hasId: boolean,
  ctx: { version?: string }
): Promise<object | null> {
  const respond = (result: unknown): object | null =>
    hasId ? jsonRpcSuccess(id, result) : null;

  switch (method) {
    case 'initialize':
      return respond(buildInitializeResult(params, ctx.version ?? DEFAULT_VERSION));

    case 'notifications/initialized':
      return hasId ? jsonRpcSuccess(id, {}) : null;

    case 'ping':
      return respond({});

    case 'tools/list':
      return respond({ tools: getMcpTools() });

    case 'tools/call': {
      if (params === undefined) {
        return hasId ? jsonRpcError(id, -32602, 'Invalid params: expected an object') : null;
      }

      const name = params['name'];
      if (typeof name !== 'string' || !MCP_TOOL_NAMES.has(name)) {
        return hasId
          ? jsonRpcError(
              id,
              -32602,
              `Unknown tool: ${typeof name === 'string' ? name : '(missing)'}`
            )
          : null;
      }

      const rawArguments = params['arguments'];
      if (rawArguments !== undefined && !isRecord(rawArguments)) {
        return hasId
          ? jsonRpcError(id, -32602, 'Invalid params: "arguments" must be an object')
          : null;
      }

      const args = isRecord(rawArguments) ? rawArguments : {};
      const result = await executeTool(name, args, extractProgressToken(params), id);
      return respond(result);
    }

    case 'resources/list':
      return respond({ resources: [] });

    case 'prompts/list':
      return respond({ prompts: [] });

    case 'logging/setLevel':
      return respond({});

    default:
      return hasId ? jsonRpcError(id, -32601, `Method not found: ${method}`) : null;
  }
}

export async function handleMcpRequest(
  request: unknown,
  ctx: { version?: string } = {}
): Promise<object | null> {
  if (!isRecord(request)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }

  const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
  const id = normalizeRequestId(request['id']);
  const method = request['method'];

  if (typeof method !== 'string') {
    return jsonRpcError(id, -32600, 'Invalid Request: method must be a string');
  }

  const rawParams = request['params'];
  const params = isRecord(rawParams) ? rawParams : undefined;

  try {
    return await dispatchMcpMethod(method, params, id, hasId, ctx);
  } catch (error) {
    if (!hasId) return null;
    return jsonRpcError(id, -32603, 'Internal error', describeError(error));
  }
}

function writeJsonLine(stream: NodeJS.WritableStream, message: unknown): void {
  try {
    stream.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    process.stderr.write(`MCP write failed: ${describeError(error)}\n`);
  }
}

async function processInputLine(
  line: string,
  stdout: NodeJS.WritableStream,
  version: string
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    writeJsonLine(stdout, jsonRpcError(null, -32700, 'Parse error'));
    return;
  }

  const response = await handleMcpRequest(parsed, { version });
  if (response !== null) {
    writeJsonLine(stdout, response);
  }
}

function readLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onOversizedLine: () => void
): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    let buffer = '';
    let discarding = false;
    let finished = false;
    const decoder = new StringDecoder('utf8');

    function cleanup(): void {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onClose);
      stream.off('error', onError);
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      cleanup();
      resolvePromise();
    }

    function reportOversized(): void {
      if (discarding) return;
      discarding = true;
      onOversizedLine();
    }

    function handleLine(rawLine: string): void {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length === 0) return;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        onOversizedLine();
        return;
      }
      onLine(line);
    }

    function onData(chunk: Buffer | string): void {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

      for (;;) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
            reportOversized();
            buffer = '';
          }
          return;
        }

        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (discarding) {
          discarding = false;
          continue;
        }

        handleLine(rawLine);
      }
    }

    function onEnd(): void {
      buffer += decoder.end();
      if (buffer.length > 0 && !discarding) {
        handleLine(buffer);
      }
      finish();
    }

    function onClose(): void {
      finish();
    }

    function onError(error: unknown): void {
      process.stderr.write(`MCP stdin error: ${describeError(error)}\n`);
      finish();
    }

    const state = stream as NodeJS.ReadableStream & {
      readableEnded?: boolean;
      destroyed?: boolean;
    };
    if (state.readableEnded === true || state.destroyed === true) {
      resolvePromise();
      return;
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onClose);
    stream.on('error', onError);
  });
}

function stringifyConsoleValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  return safeJson(value);
}

function redirectConsoleLogs(): () => void {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  const writeToStderr = (...data: unknown[]): void => {
    try {
      const text = data.map(stringifyConsoleValue).join(' ');
      process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
    } catch {
      // Logging must never break the protocol.
    }
  };

  console.log = writeToStderr;
  console.info = writeToStderr;
  console.debug = writeToStderr;

  return (): void => {
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
  };
}

export async function startMcpServer(opts: StartMcpServerOptions = {}): Promise<void> {
  const version = opts.version ?? DEFAULT_VERSION;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  const previousSink = notificationSink;
  notificationSink = (message: Record<string, unknown>): void => {
    writeJsonLine(stdout, message);
  };

  const restoreConsole = redirectConsoleLogs();

  const onOutputError = (error: unknown): void => {
    process.stderr.write(`MCP stdout error: ${describeError(error)}\n`);
  };

  try {
    stdout.on('error', onOutputError);
  } catch {
    // A custom stream may not support event listeners.
  }

  let queue: Promise<void> = Promise.resolve();
  let transportClosed = false;

  const enqueueToolCall = (line: string): void => {
    queue = queue
      .then(async () => {
        if (transportClosed) return;
        await processInputLine(line, stdout, version);
      })
      .catch((error: unknown) => {
        process.stderr.write(`MCP handler error: ${describeError(error)}\n`);
      });
  };

  const cancelActiveRun = (): void => {
    try {
      activeConsilium?.cancel();
    } catch {
      // Cancellation is best-effort.
    }
  };

  const handleLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeJsonLine(stdout, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }

    if (isRecord(parsed)) {
      const method = parsed['method'];
      if (method === 'notifications/cancelled') {
        const cancelParams = isRecord(parsed['params']) ? parsed['params'] : undefined;
        const target = cancelParams?.['requestId'];
        if (target === undefined || target === activeRunRequestId) {
          cancelActiveRun();
        }
        return;
      }
      const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id');
      if (hasId && method === 'tools/call') {
        enqueueToolCall(line);
        return;
      }
    }

    // Control methods and notifications never wait behind a long council run.
    void processInputLine(line, stdout, version);
  };

  function cleanup(): void {
    notificationSink = previousSink;
    restoreConsole();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    try {
      stdout.off('error', onOutputError);
    } catch {
      // Ignore streams without removeListener support.
    }
  }

  function onSignal(): void {
    transportClosed = true;
    try {
      activeConsilium?.cancel();
    } catch {
      // Cancellation is best-effort during shutdown.
    }
    cleanup();
    process.exit(0);
  }

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await readLines(stdin, handleLine, () => {
      writeJsonLine(
        stdout,
        jsonRpcError(null, -32700, 'Parse error: input line exceeds 4 MiB')
      );
    });
    // Транспорт закрыт — отменяем активный запуск, не начинаем новые и не висим дольше таймаута.
    transportClosed = true;
    cancelActiveRun();
    await Promise.race([
      queue,
      new Promise<void>(resolveTimeout => {
        const timer = setTimeout(resolveTimeout, 5000);
        timer.unref();
      })
    ]);
  } finally {
    cleanup();
  }
}
