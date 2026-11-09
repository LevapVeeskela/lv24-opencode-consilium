/**
 * @fileoverview Баррель проверок диагностики Consilium
 * @module lv24-opencode-consilium
 */

export {
  checkConfigFile,
  checkChair,
  checkExperts,
  checkFeatures,
  checkModelsFormat,
  checkOutputFile,
  checkTimeouts
} from './config.js';

export {
  checkAutoApprove,
  checkConcurrency,
  checkLocalProviders,
  checkModelsCache,
  checkNodeVersion,
  checkOpenCodeCli,
  checkStandalone
} from './environment.js';
export type { LocalProvidersProbe } from './environment.js';

export {
  checkOpenCodeConfig,
  checkOpenCodeV2Compat
} from './opencode.js';
