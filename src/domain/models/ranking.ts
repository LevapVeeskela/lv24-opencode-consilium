/**
 * @fileoverview Ранжирование бесплатных моделей и подбор состава консилиума
 * @module lv24-opencode-consilium
 */

import { DEFAULT_EXPERT_PROMPTS } from '../defaults.js';
import type { FreeModel, FreeModelSource } from './catalog.js';

const ALPHA_PATTERN = /alpha|preview|stealth|experimental/i;
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

export function bumpMax(map: Map<string, number>, key: string, value: number): void {
  const previous = map.get(key);
  if (previous === undefined || value > previous) map.set(key, value);
}

export function stripFreeSuffix(value: string): string {
  return value.replace(/:free$/i, '');
}

function registryKeys(model: FreeModel): string[] {
  const keys: string[] = [];
  if (model.canonicalID) keys.push(model.canonicalID.toLowerCase());
  if (model.modelID) keys.push(model.modelID.toLowerCase());
  if (model.id) keys.push(model.id.toLowerCase());
  return keys;
}

/** Запомнить теневую цену платного аналога (используется парсерами источников) */
export function rememberShadow(model: FreeModel, prior: number): void {
  if (prior <= 0) return;
  for (const key of registryKeys(model)) bumpMax(shadowPrices, key, prior);
}

/** Пометить модель как alpha/preview (используется парсерами источников) */
export function rememberPenalty(model: FreeModel): void {
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
  // Доступный дубль важнее более высокого рейтинга недоступного: иначе
  // фильтр доступности может скрыть единственную рабочую копию модели.
  if (candidate.available !== current.available) return candidate.available;
  if (candidate.score !== current.score) return candidate.score > current.score;
  const sourceDelta = SOURCE_ORDER[candidate.source] - SOURCE_ORDER[current.source];
  if (sourceDelta !== 0) return sourceDelta < 0;
  return candidate.id < current.id;
}

export function sortRanked(models: FreeModel[], includeUnavailable: boolean): FreeModel[] {
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
  opts: { includeUnavailable?: boolean; minContext?: number } = {}
): FreeModel[] {
  const now = Date.now();
  const minContext =
    typeof opts.minContext === 'number' && Number.isFinite(opts.minContext) && opts.minContext > 0
      ? opts.minContext
      : 0;
  const scored = models
    .filter(model => model.context >= minContext)
    .map(model => ({ ...model, score: computeScore(model, now) }));
  return sortRanked(scored, opts.includeUnavailable ?? true);
}

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

  // При 3–4 моделях индекс 4 недостижим: выбираем последнюю доступную модель,
  // иначе ни один агент не получит промпт председателя.
  const chairIndex = Math.min(4, selected.length - 1);
  const agents: Record<string, { name: string; mode: 'primary'; model: string; prompt: string }> = {};

  for (let index = 0; index < selected.length; index += 1) {
    const name = agentNames[index % agentNames.length];
    if (name === 'consilium') continue;
    agents[name] = {
      name,
      mode: 'primary',
      model: selected[index].id,
      prompt: expertPrompt(name)
    };
  }

  // Конфиг всегда ссылается на агента consilium — он обязан существовать,
  // даже если моделей меньше пяти.
  agents.consilium = {
    name: 'consilium',
    mode: 'primary',
    model: selected[chairIndex].id,
    prompt: CHAIR_PROMPT
  };

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
