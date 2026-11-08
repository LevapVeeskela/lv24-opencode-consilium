/**
 * @fileoverview Загрузка каталога бесплатных моделей: models.dev, OpenRouter, кэш
 * @module lv24-opencode-consilium
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { errorMessage } from '../../shared/errors.js';
import { isRecord, type JsonRecord } from '../../shared/record.js';
import { BUILTIN_FREE_MODELS, isExcludedFreeProvider } from '../../domain/models/catalog.js';
import type {
  FetchFreeModelsOptions,
  FreeModel,
  FreeModelFetchResult
} from '../../domain/models/catalog.js';
import {
  bumpMax,
  rankFreeModels,
  rememberPenalty,
  rememberShadow,
  selectCouncilModels,
  sortRanked,
  stripFreeSuffix
} from '../../domain/models/ranking.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MIN_CONTEXT = 32_768;
const AUDIO_PATTERN = /audio|whisper|tts|transcrib|speech/i;

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
