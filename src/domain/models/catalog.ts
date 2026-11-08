/**
 * @fileoverview Каталог бесплатных моделей: типы и курируемый офлайн-набор
 * @module lv24-opencode-consilium
 */

import { rankFreeModels } from './ranking.js';

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

const EXCLUDED_PROVIDER = /coding-plan|code-plan|subscription/i;

/** Провайдеры платных подписок не участвуют в подборе бесплатных моделей */
export function isExcludedFreeProvider(providerID: string): boolean {
  return EXCLUDED_PROVIDER.test(providerID);
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
