/**
 * @fileoverview Каталог бесплатных моделей и подбор состава консилиума
 * @module lv24-opencode-consilium
 */

export type {
  FetchFreeModelsOptions,
  FreeModel,
  FreeModelFetchResult,
  FreeModelSource
} from './catalog.js';
export { BUILTIN_FREE_MODELS, isExcludedFreeProvider } from './catalog.js';
export {
  buildConsiliumConfigFromModels,
  buildCouncilAgents,
  rankFreeModels,
  selectCouncilModels
} from './ranking.js';
export { fetchFreeModels, getCouncilModels } from './sources.js';
