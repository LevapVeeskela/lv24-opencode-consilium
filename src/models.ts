/**
 * @fileoverview Каталог бесплатных моделей и подбор состава консилиума
 * @module lv24-opencode-consilium
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { DEFAULT_EXPERT_PROMPTS } from './defaults.js';

/** Источник каталога моделей */
export type FreeModelSource = 'models.dev' | 'openrouter' | 'builtin';

/** Нормализованная бесплатная модель */
export interface FreeModel {
  /** Полный id OpenCode: `${providerID}/${modelID}` */
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  context: number;
  outputLimit: number;
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput: boolean;
  releaseDate?: string;
  canonicalID?: string;
  score: number;
  available: boolean;
  source: FreeModelSource;
  env?: string[];
}

/** Результат загрузки каталога */
export interface FreeModelFetchResult {
  models: FreeModel[];
  sources: Array<{ source: string; ok: boolean; error?: string; count: number }>;
  fromCache: boolean;
  fetchedAt: number;
}

/** Опции загрузки каталога */
export interface FetchFreeModelsOptions {
  forceRefresh?: boolean;
  timeoutMs?: number;
  cacheTtlMs?: number;
  minContext?: number;
  includeUnavailable?: boolean;
}

interface SourceStatus {
  source: string;
  ok: boolean;
  error?: string;
  count: number;
}

interface CacheFile {
  fetchedAt: number;
  models: FreeModel[];
  sources: SourceStatus[];
}

interface LoadResult {
  models: FreeModel[];
  count: number;
}

type JsonRecord = Record<string, unknown>;

const MODELS_DEV_URL = 'https://models.dev/api.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MIN_CONTEXT = 32_768;
const EXCLUDED_PROVIDER = /coding-plan|code-plan|subscription/i;
/** Провайдеры платных подписок не участвуют в подборе бесплатных моделей */
export function isExcludedFreeProvider(providerID: string): boolean {
  return EXCLUDED_PROVIDER.test(providerID);
}
const ALPHA_PATTERN = /alpha|preview|stealth|experimental/i;
const AUDIO_PATTERN = /audio|whisper|tts|transcrib|speech/i;
const CHAIR_PROMPT = 'Ты председатель консилиума. Синтезируй мнения экспертов и дай итоговый план.';
const DEFAULT_AGENT_NAMES = ['arch', 'ux', 'ba', 'sec', 'consilium'];
const GENERIC_FAMILY_TOKENS = new Set([
  'free',
  'preview',
  'alpha',
  'beta',
  'stealth',
  'experimental',
  'latest',
  'chat',
  'instruct'
]);

const FAMILY_PRIOR: ReadonlyArray<readonly [string, number]> = [
  ['claude', 1],
  ['gpt', 1],
  ['gemini', 0.95],
  ['deepseek', 0.95],
  ['qwen', 0.9],
  ['glm', 0.9],
  ['kimi', 0.9],
  ['minimax', 0.85],
  ['llama', 0.8],
  ['mistral', 0.8],
  ['nemotron', 0.8],
  ['mimo', 0.75],
  ['gemma', 0.75]
];

const SOURCE_ORDER: Record<FreeModelSource, number> = {
  'models.dev': 0,
  openrouter: 1,
  builtin: 2
};

/** Теневые цены платных аналогов: ключ → приор качества */
const shadowPrices = new Map<string, number>();
/** Модели с alpha/preview-статусом: ключ → штраф */
const penalizedModels = new Set<string>();

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? 1 : value;
}

function bumpMax(map: Map<string, number>, key: string, value: number): void {
  const previous = map.get(key);
  if (previous === undefined || value > previous) map.set(key, value);
}

function registryKeys(model: FreeModel): string[] {
  const keys: string[] = [];
  if (model.canonicalID) keys.push(model.canonicalID.toLowerCase());
  if (model.modelID) keys.push(model.modelID.toLowerCase());
  if (model.id) keys.push(model.id.toLowerCase());
  return keys;
}

function rememberShadow(model: FreeModel, prior: number): void {
  if (prior <= 0) return;
  for (const key of registryKeys(model)) bumpMax(shadowPrices, key, prior);
}

function rememberPenalty(model: FreeModel): void {
  for (const key of registryKeys(model)) penalizedModels.add(key);
}

function releaseRecency(releaseDate: string | undefined, now: number): number {
  if (!releaseDate) return 0.5;
  const timestamp = Date.parse(releaseDate);
  if (!Number.isFinite(timestamp)) return 0.5;
  const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
  return clamp01(Math.exp(-ageDays / 240));
}

function familyPriorFor(text: string): number {
  const lower = text.toLowerCase();
  let prior = 0.6;
  for (const [family, value] of FAMILY_PRIOR) {
    if (lower.includes(family) && value > prior) prior = value;
  }
  return prior;
}

function shadowPriceFor(model: FreeModel): number {
  for (const key of registryKeys(model)) {
    const value = shadowPrices.get(key);
    if (value !== undefined) return value;
  }
  return 0;
}

function isPenalized(model: FreeModel): boolean {
  if (ALPHA_PATTERN.test(model.name) || ALPHA_PATTERN.test(model.id) || ALPHA_PATTERN.test(model.modelID)) {
    return true;
  }
  return registryKeys(model).some(key => penalizedModels.has(key));
}

function computeScore(model: FreeModel, now: number): number {
  const contextNorm = clamp01(Math.log2(Math.max(model.context, 1) / 8192) / 7);
  const outputNorm = clamp01(Math.log2(Math.max(model.outputLimit, 1) / 8192) / 4);
  const recency = releaseRecency(model.releaseDate, now);
  const familyPrior = familyPriorFor(`${model.name} ${model.modelID}`);
  const shadow = shadowPriceFor(model);

  let score =
    0.30 * contextNorm +
    0.20 * (model.toolCall ? 1 : 0) +
    0.10 * (model.structuredOutput ? 1 : 0) +
    0.10 * (model.reasoning ? 1 : 0) +
    0.10 * recency +
    0.10 * outputNorm +
    0.10 * familyPrior +
    0.15 * shadow;

  if (isPenalized(model)) score -= 0.25;
  if (model.available) score += 0.05;

  return Math.round(score * 1_000_000) / 1_000_000;
}

function canonicalKey(model: FreeModel): string {
  const key = model.canonicalID && model.canonicalID.length > 0 ? model.canonicalID : model.modelID;
  return key.toLowerCase();
}

function compareRanked(a: FreeModel, b: FreeModel): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.available !== b.available) return a.available ? -1 : 1;
  if (b.context !== a.context) return b.context - a.context;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function isBetter(candidate: FreeModel, current: FreeModel): boolean {
  if (candidate.score !== current.score) return candidate.score > current.score;
  if (candidate.available !== current.available) return candidate.available;
  const sourceDelta = SOURCE_ORDER[candidate.source] - SOURCE_ORDER[current.source];
  if (sourceDelta !== 0) return sourceDelta < 0;
  return candidate.id < current.id;
}

function sortRanked(models: FreeModel[], includeUnavailable: boolean): FreeModel[] {
  const filtered = includeUnavailable ? models : models.filter(model => model.available);
  const best = new Map<string, FreeModel>();
  for (const model of filtered) {
    const key = canonicalKey(model);
    const current = best.get(key);
    if (!current || isBetter(model, current)) best.set(key, model);
  }
  return Array.from(best.values()).sort(compareRanked);
}

/**
 * Оценить и отсортировать бесплатные модели
 */
export function rankFreeModels(
  models: FreeModel[],
  opts: { includeUnavailable?: boolean } = {}
): FreeModel[] {
  const now = Date.now();
  const scored = models.map(model => ({ ...model, score: computeScore(model, now) }));
  return sortRanked(scored, opts.includeUnavailable ?? true);
}

const BUILTIN_FREE_MODELS_RAW: FreeModel[] = [
  {
    id: 'opencode/beam-free',
    providerID: 'opencode',
    modelID: 'beam-free',
    name: 'Beam Free',
    context: 1_048_576,
    outputLimit: 131_072,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    releaseDate: '2026-10-05',
    score: 0,
    available: true,
    source: 'builtin'
  },
  {
    id: 'opencode/inkling-2-small-free',
    providerID: 'opencode',
    modelID: 'inkling-2-small-free',
    name: 'Inkling 2 Small Free',
    context: 1_048_576,
    outputLimit: 131_072,
    reasoning: true,
    toolCall: true,
    structuredOutput: false,
    releaseDate: '2026-11-05',
    score: 0,
    available: true,
    source: 'builtin'
  },
  {
    id: 'opencode/flint-40b-free',
    providerID: 'opencode',
    modelID: 'flint-40b-free',
    name: 'Flint 40B Free',
    context: 262_144,
    outputLimit: 65_536,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    releaseDate: '2026-10-21',
    score: 0,
    available: true,
    source: 'builtin'
  },
  {
    id: 'opencode/deepseek-v4.1-flash-free',
    providerID: 'opencode',
    modelID: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    context: 200_000,
    outputLimit: 32_768,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    releaseDate: '2026-09-10',
    score: 0,
    available: true,
    source: 'builtin'
  },
  {
    id: 'opencode/iceman-free',
    providerID: 'opencode',
    modelID: 'iceman-free',
    name: 'Iceman Free',
    context: 262_144,
    outputLimit: 131_072,
    reasoning: true,
    toolCall: true,
    structuredOutput: false,
    releaseDate: '2026-11-06',
    score: 0,
    available: true,
    source: 'builtin'
  },
  {
    id: 'opencode/nemotron-3.5-super-vl-free',
    providerID: 'opencode',
    modelID: 'nemotron-3.5-super-vl-free',
    name: 'Nemotron 3.5 Super VL Free',
    context: 1_048_576,
    outputLimit: 131_072,
    reasoning: true,
    toolCall: true,
    structuredOutput: false,
    releaseDate: '2026-10-15',
    score: 0,
    available: true,
    source: 'builtin'
  },
  {
    id: 'opencode/crouton-alpha-free',
    providerID: 'opencode',
    modelID: 'crouton-alpha-free',
    name: 'Crouton Alpha Free',
    context: 1_048_576,
    outputLimit: 270_000,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    releaseDate: '2026-11-03',
    score: 0,
    available: true,
    source: 'builtin'
  },
  {
    id: 'opencode/glm-5.3-flash-free',
    providerID: 'opencode',
    modelID: 'glm-5.3-flash-free',
    name: 'GLM 5.3 Flash Free',
    context: 200_000,
    outputLimit: 32_768,
    reasoning: true,
    toolCall: true,
    structuredOutput: true,
    releaseDate: '2026-08-26',
    score: 0,
    available: true,
    source: 'builtin'
  }
];

/** Проверенный офлайн-набор бесплатных моделей */
export const BUILTIN_FREE_MODELS: FreeModel[] = rankFreeModels(BUILTIN_FREE_MODELS_RAW, {
  includeUnavailable: true
});

function familyKey(model: FreeModel): string {
  const raw = (model.modelID || model.name).toLowerCase();
  const last = raw.slice(raw.lastIndexOf('/') + 1);
  const cleaned = stripFreeSuffix(last).replace(/-free$/, '');
  const tokens = cleaned.split(/[^a-z0-9]+/).filter(token => token.length > 0);
  const meaningful = tokens.filter(token => !GENERIC_FAMILY_TOKENS.has(token));
  const first = meaningful[0] ?? tokens[0] ?? cleaned;
  const second = meaningful[1];
  const family = first.length <= 2 && second ? `${first}${second}` : first;
  return `${model.providerID}:${family}`;
}

/**
 * Выбрать N моделей с разными семействами провайдеров
 */
export function selectCouncilModels(models: FreeModel[], size = 5): FreeModel[] {
  const limit = Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 5;
  if (limit === 0 || models.length === 0) return [];

  const ranked = sortRanked(models, true);
  const available = ranked.filter(model => model.available);
  const pool = available.length > 0 ? available : ranked;

  const selected: FreeModel[] = [];
  const seenFamilies = new Set<string>();
  for (const model of pool) {
    const key = familyKey(model);
    if (seenFamilies.has(key)) continue;
    seenFamilies.add(key);
    selected.push(model);
    if (selected.length >= limit) break;
  }

  if (selected.length < limit) {
    const selectedIds = new Set(selected.map(model => model.id));
    for (const model of pool) {
      if (selectedIds.has(model.id)) continue;
      selected.push(model);
      selectedIds.add(model.id);
      if (selected.length >= limit) break;
    }
  }

  if (!selected.some(model => model.toolCall)) {
    const candidate = pool.find(model => model.toolCall && !selected.includes(model));
    if (candidate) {
      if (selected.length === 0) selected.push(candidate);
      else selected[selected.length - 1] = candidate;
    }
  }

  return selected;
}

function expertPrompt(name: string): string {
  const template = Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, name)
    ? DEFAULT_EXPERT_PROMPTS[name]
    : undefined;
  if (typeof template === 'function') {
    const text = template('').trim();
    if (text.length > 0) return text;
  } else if (typeof template === 'string' && template.trim().length > 0) {
    return template.trim();
  }
  return `Ты эксперт консилиума (${name}). Анализируй задачу кратко, по делу и в рамках своей роли.`;
}

/**
 * Собрать агентов консилиума (эксперты + председатель)
 */
export function buildCouncilAgents(
  models: FreeModel[],
  names: string[] = DEFAULT_AGENT_NAMES
): Record<string, { name: string; mode: 'primary'; model: string; prompt: string }> {
  const agentNames = names.length > 0 ? names : DEFAULT_AGENT_NAMES;
  const selected = selectCouncilModels(models, agentNames.length);
  if (selected.length === 0) {
    throw new Error('Нет доступных моделей для консилиума');
  }

  const chairIndex = Math.min(4, agentNames.length - 1);
  const agents: Record<string, { name: string; mode: 'primary'; model: string; prompt: string }> = {};

  for (let index = 0; index < selected.length; index += 1) {
    const name = agentNames[index % agentNames.length];
    agents[name] = {
      name,
      mode: 'primary',
      model: selected[index].id,
      prompt: index === chairIndex ? CHAIR_PROMPT : expertPrompt(name)
    };
  }

  return agents;
}

/**
 * Собрать конфигурацию консилиума из моделей
 */
export function buildConsiliumConfigFromModels(models: FreeModel[]): {
  experts: Array<{ name: string; model: string; enabled: true; priority: number }>;
  chair: { agent: string; model: string; maxExpertTextLength: number };
} {
  const selected = selectCouncilModels(models, 5);
  if (selected.length === 0) {
    throw new Error('Нет доступных моделей для консилиума');
  }

  const expertNames = ['arch', 'ux', 'ba', 'sec'];
  const experts = selected.slice(0, expertNames.length).map((model, index) => ({
    name: expertNames[index],
    model: model.id,
    enabled: true as const,
    priority: index + 1
  }));
  const chairModel = selected[4] ?? selected[0];

  return {
    experts,
    chair: {
      agent: 'consilium',
      model: chairModel.id,
      maxExpertTextLength: 3000
    }
  };
}

/**
 * Загрузить модели и сразу выбрать состав консилиума
 */
export async function getCouncilModels(
  opts: FetchFreeModelsOptions = {}
): Promise<{ models: FreeModel[]; council: FreeModel[]; result: FreeModelFetchResult }> {
  const result = await fetchFreeModels(opts);
  return {
    models: result.models,
    council: selectCouncilModels(result.models, 5),
    result
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    result.push(item);
  }
  return result;
}

function stripFreeSuffix(value: string): string {
  return value.replace(/:free$/i, '');
}

function normalizeReleaseDate(value: unknown): string | undefined {
  const date = str(value);
  if (!date) return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(date);
  return match ? match[0] : undefined;
}

function dateFromUnixSeconds(value: unknown): string | undefined {
  const seconds = num(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function isExpired(value: unknown, now: number): boolean {
  const expiration = str(value);
  if (!expiration) return false;
  const timestamp = Date.parse(expiration);
  return Number.isFinite(timestamp) && timestamp < now;
}

function providerAvailable(providerID: string, env?: string[]): boolean {
  if (providerID === 'opencode') return true;
  if (!env || env.length === 0) return true;
  return env.some(key => Boolean(process.env[key]));
}

function parseModelsDev(data: unknown, minContext: number): LoadResult {
  if (!isRecord(data)) return { models: [], count: 0 };

  interface ProviderBlock {
    id: string;
    env?: string[];
    models: JsonRecord;
  }

  const providers: ProviderBlock[] = [];
  for (const [id, value] of Object.entries(data)) {
    if (isExcludedFreeProvider(id) || !isRecord(value)) continue;
    const models = value.models;
    if (!isRecord(models)) continue;
    providers.push({ id, env: strArray(value.env), models });
  }

  const byCanonical = new Map<string, number>();
  const byFamily = new Map<string, number>();
  for (const provider of providers) {
    for (const value of Object.values(provider.models)) {
      if (!isRecord(value)) continue;
      const cost = isRecord(value.cost) ? value.cost : undefined;
      const output = cost ? num(cost.output) : undefined;
      if (output === undefined || output <= 0) continue;
      const prior = Math.log1p(output) / Math.log1p(50);
      const canonical = str(value.canonical_model_id);
      if (canonical) bumpMax(byCanonical, canonical.toLowerCase(), prior);
      const family = str(value.family);
      if (family) bumpMax(byFamily, family.toLowerCase(), prior);
    }
  }

  const models: FreeModel[] = [];
  for (const provider of providers) {
    const available = providerAvailable(provider.id, provider.env);
    for (const [modelID, value] of Object.entries(provider.models)) {
      if (!isRecord(value)) continue;
      const status = str(value.status);
      if (status === 'deprecated') continue;
      const type = str(value.type);
      if (type !== undefined && type !== 'chat') continue;
      if (value.tool_call !== true) continue;

      const cost = isRecord(value.cost) ? value.cost : undefined;
      if (!cost) continue;
      if (num(cost.input) !== 0 || num(cost.output) !== 0) continue;

      const limit = isRecord(value.limit) ? value.limit : undefined;
      const context = limit ? num(limit.context) : undefined;
      if (context === undefined || context < minContext) continue;
      const outputLimit = limit ? num(limit.output) : undefined;

      const name = str(value.name) ?? str(value.id) ?? modelID;
      const releaseDate = normalizeReleaseDate(value.release_date);
      const canonicalID = str(value.canonical_model_id) ?? stripFreeSuffix(modelID);
      const family = str(value.family) ?? '';
      const canonicalPrior = byCanonical.get(canonicalID.toLowerCase());
      const familyPrior = family ? byFamily.get(family.toLowerCase()) : undefined;
      const prior = canonicalPrior ?? familyPrior ?? 0;

      const model: FreeModel = {
        id: `${provider.id}/${modelID}`,
        providerID: provider.id,
        modelID,
        name,
        context,
        outputLimit: outputLimit !== undefined && outputLimit > 0 ? outputLimit : 0,
        reasoning: value.reasoning === true,
        toolCall: true,
        structuredOutput: value.structured_output === true,
        releaseDate,
        canonicalID,
        score: 0,
        available,
        source: 'models.dev',
        env: provider.env
      };

      rememberShadow(model, prior);
      if (status === 'alpha' || value.experimental === true) rememberPenalty(model);
      models.push(model);
    }
  }

  return { models, count: models.length };
}

function parseOpenRouter(data: unknown, minContext: number, now: number): LoadResult {
  const root = isRecord(data) ? data : undefined;
  const list = root && Array.isArray(root.data) ? root.data : [];

  const entries: Array<{ id: string; raw: JsonRecord }> = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = str(item.id);
    if (!id) continue;
    entries.push({ id, raw: item });
  }

  const paid = new Map<string, number>();
  for (const entry of entries) {
    const pricing = isRecord(entry.raw.pricing) ? entry.raw.pricing : undefined;
    if (!pricing) continue;
    const completion = Number(pricing.completion);
    if (!Number.isFinite(completion) || completion <= 0) continue;
    const perMillion = completion * 1_000_000;
    const prior = Math.log1p(perMillion) / Math.log1p(50);
    const canonical = str(entry.raw.canonical_slug);
    if (canonical) bumpMax(paid, canonical.toLowerCase(), prior);
    bumpMax(paid, stripFreeSuffix(entry.id).toLowerCase(), prior);
  }

  const available = Boolean(process.env.OPENROUTER_API_KEY);
  const models: FreeModel[] = [];

  for (const entry of entries) {
    if (entry.id.toLowerCase() === 'openrouter/free') continue;
    const raw = entry.raw;

    const pricing = isRecord(raw.pricing) ? raw.pricing : undefined;
    if (!pricing) continue;
    if (String(pricing.prompt) !== '0' || String(pricing.completion) !== '0') continue;

    const architecture = isRecord(raw.architecture) ? raw.architecture : undefined;
    const outputs = architecture ? strArray(architecture.output_modalities) : undefined;
    if (!outputs || !outputs.includes('text')) continue;

    const supported = strArray(raw.supported_parameters) ?? [];
    if (!supported.includes('tools')) continue;

    const name = str(raw.name) ?? entry.id;
    if (AUDIO_PATTERN.test(entry.id) || AUDIO_PATTERN.test(name)) continue;
    if (isExpired(raw.expiration_date, now)) continue;

    const topProvider = isRecord(raw.top_provider) ? raw.top_provider : undefined;
    const topContext = topProvider ? num(topProvider.context_length) : undefined;
    const context = topContext ?? num(raw.context_length);
    if (context === undefined || context < minContext) continue;

    const outputLimit = topProvider ? num(topProvider.max_completion_tokens) : undefined;
    const canonicalID = str(raw.canonical_slug) ?? stripFreeSuffix(entry.id);
    const prior = paid.get(canonicalID.toLowerCase()) ?? paid.get(stripFreeSuffix(entry.id).toLowerCase()) ?? 0;

    const model: FreeModel = {
      id: `openrouter/${entry.id}`,
      providerID: 'openrouter',
      modelID: entry.id,
      name,
      context,
      outputLimit: outputLimit !== undefined && outputLimit > 0 ? outputLimit : 0,
      reasoning: supported.includes('reasoning') || supported.includes('include_reasoning'),
      toolCall: true,
      structuredOutput:
        supported.includes('structured_outputs') ||
        supported.includes('structured_output') ||
        supported.includes('response_format'),
      releaseDate: dateFromUnixSeconds(raw.created),
      canonicalID,
      score: 0,
      available,
      source: 'openrouter',
      env: ['OPENROUTER_API_KEY']
    };

    rememberShadow(model, prior);
    models.push(model);
  }

  return { models, count: models.length };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'lv24-opencode-consilium/1.0'
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const data: unknown = await response.json();
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loadModelsDev(timeoutMs: number, minContext: number): Promise<LoadResult> {
  const data = await fetchJson(MODELS_DEV_URL, timeoutMs);
  return parseModelsDev(data, minContext);
}

async function loadOpenRouter(timeoutMs: number, minContext: number): Promise<LoadResult> {
  const data = await fetchJson(OPENROUTER_URL, timeoutMs);
  return parseOpenRouter(data, minContext, Date.now());
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function toSourceStatus(source: string, settled: PromiseSettledResult<LoadResult>): SourceStatus {
  if (settled.status === 'fulfilled') {
    return { source, ok: true, count: settled.value.count };
  }
  return { source, ok: false, count: 0, error: errorMessage(settled.reason) };
}

function isFreeModel(value: unknown): value is FreeModel {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.providerID !== 'string' || typeof value.modelID !== 'string') {
    return false;
  }
  if (typeof value.name !== 'string') return false;
  if (typeof value.context !== 'number' || !Number.isFinite(value.context)) return false;
  if (typeof value.outputLimit !== 'number' || !Number.isFinite(value.outputLimit)) return false;
  if (typeof value.reasoning !== 'boolean' || typeof value.toolCall !== 'boolean') return false;
  if (typeof value.structuredOutput !== 'boolean' || typeof value.available !== 'boolean') return false;
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) return false;
  if (value.source !== 'models.dev' && value.source !== 'openrouter' && value.source !== 'builtin') return false;
  if (value.releaseDate !== undefined && typeof value.releaseDate !== 'string') return false;
  if (value.canonicalID !== undefined && typeof value.canonicalID !== 'string') return false;
  if (value.env !== undefined) {
    if (!Array.isArray(value.env) || !value.env.every(item => typeof item === 'string')) return false;
  }
  return true;
}

function isSourceStatus(value: unknown): value is SourceStatus {
  if (!isRecord(value)) return false;
  if (typeof value.source !== 'string' || typeof value.ok !== 'boolean' || typeof value.count !== 'number') {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== 'string') return false;
  return true;
}

function resolveCachePath(): string {
  const fromEnv = process.env.CONSILIUM_MODELS_CACHE;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return join(tmpdir(), 'lv24-opencode-consilium', 'models-cache.json');
}

function readCache(cachePath: string): CacheFile | null {
  try {
    const text = readFileSync(cachePath, 'utf-8');
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const fetchedAt = num(parsed.fetchedAt);
    if (fetchedAt === undefined) return null;
    const modelsRaw = Array.isArray(parsed.models) ? parsed.models : [];
    const models = modelsRaw.filter(isFreeModel).map(model => ({ ...model }));
    if (models.length === 0) return null;
    const sourcesRaw = Array.isArray(parsed.sources) ? parsed.sources : [];
    const sources = sourcesRaw.filter(isSourceStatus).map(source => ({ ...source }));
    return { fetchedAt, models, sources };
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, cache: CacheFile): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const payload = JSON.stringify(cache);
    const temporary = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(temporary, payload, 'utf-8');
    renameSync(temporary, cachePath);
  } catch {
    // Кэш необязателен
  }
}

function prepare(models: FreeModel[], minContext: number, includeUnavailable: boolean): FreeModel[] {
  const merged = models.map(model => ({ ...model }));
  const seen = new Set(merged.map(model => model.id.toLowerCase()));
  for (const builtin of BUILTIN_FREE_MODELS) {
    if (!seen.has(builtin.id.toLowerCase())) {
      merged.push({ ...builtin });
      seen.add(builtin.id.toLowerCase());
    }
  }
  const filtered = merged.filter(
    model => model.context >= minContext && (includeUnavailable || model.available)
  );
  return sortRanked(filtered, true);
}

/**
 * Загрузить бесплатные модели (models.dev + OpenRouter) с кэшем и запасным набором
 */
export async function fetchFreeModels(
  opts: FetchFreeModelsOptions = {}
): Promise<FreeModelFetchResult> {
  const now = Date.now();
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const ttl =
    typeof opts.cacheTtlMs === 'number' && Number.isFinite(opts.cacheTtlMs)
      ? opts.cacheTtlMs
      : DEFAULT_CACHE_TTL_MS;
  const minContext =
    typeof opts.minContext === 'number' && Number.isFinite(opts.minContext) && opts.minContext >= 0
      ? opts.minContext
      : DEFAULT_MIN_CONTEXT;
  const includeUnavailable = opts.includeUnavailable === true;
  const cachePath = resolveCachePath();
  const cached = opts.forceRefresh === true ? null : readCache(cachePath);

  if (cached) {
    const age = now - cached.fetchedAt;
    if (ttl > 0 && age >= 0 && age < ttl) {
      const models = prepare(cached.models, minContext, includeUnavailable);
      if (models.length > 0) {
        return {
          models,
          sources: cached.sources,
          fromCache: true,
          fetchedAt: cached.fetchedAt
        };
      }
    }
  }

  const [modelsDevSettled, openRouterSettled] = await Promise.allSettled([
    loadModelsDev(timeoutMs, minContext),
    loadOpenRouter(timeoutMs, minContext)
  ]);

  const sources: SourceStatus[] = [
    toSourceStatus('models.dev', modelsDevSettled),
    toSourceStatus('openrouter', openRouterSettled)
  ];

  const networkModels: FreeModel[] = [];
  if (modelsDevSettled.status === 'fulfilled') {
    networkModels.push(...modelsDevSettled.value.models);
  }
  if (openRouterSettled.status === 'fulfilled') {
    networkModels.push(...openRouterSettled.value.models);
  }

  // Курируемый офлайн-набор дополняет каталог: бесплатные модели часто
  // ротируются и исчезают из models.dev, хотя остаются доступными в OpenCode.
  const seenIds = new Set(networkModels.map(model => model.id.toLowerCase()));
  for (const builtin of BUILTIN_FREE_MODELS) {
    if (!seenIds.has(builtin.id.toLowerCase())) {
      networkModels.push({ ...builtin });
    }
  }

  if (networkModels.length === 0) {
    if (cached) {
      const fallbackModels = prepare(cached.models, minContext, includeUnavailable);
      if (fallbackModels.length > 0) {
        return {
          models: fallbackModels,
          sources,
          fromCache: true,
          fetchedAt: cached.fetchedAt
        };
      }
    }
    return {
      models: prepare(BUILTIN_FREE_MODELS, minContext, includeUnavailable),
      sources,
      fromCache: false,
      fetchedAt: now
    };
  }

  const fullRanked = rankFreeModels(networkModels, { includeUnavailable: true });
  writeCache(cachePath, { fetchedAt: now, models: fullRanked, sources });

  const models = rankFreeModels(networkModels, { includeUnavailable });
  if (models.length === 0) {
    return {
      models: prepare(BUILTIN_FREE_MODELS, minContext, includeUnavailable),
      sources,
      fromCache: false,
      fetchedAt: now
    };
  }

  return { models, sources, fromCache: false, fetchedAt: now };
}
