/**
 * @fileoverview Загрузчик конфигурации
 * @module lv24-opencode-consilium
 */

export {
  stripJsonComments,
  readJsonFile
} from './jsonc.js';
export {
  listOpenCodeConfigPaths,
  findOpenCodeConfigPath,
  loadOpenCodeAgents,
  resolveOpenCodeAgent,
  resolveOpenCodeAgentModel,
  type OpenCodeAgentSnapshot
} from './opencode.js';
export {
  type ConfigLoadResult,
  cloneConfig,
  mergeWithDefaults,
  isValidModelId,
  validateConfig,
  loadConfig
} from './load.js';
export {
  createMinimalConfig,
  generateExampleConfig,
  configDirectory
} from './generate.js';
