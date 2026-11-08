/**
 * @fileoverview Управление агентами OpenCode — публичный вход слайса
 * @module lv24-opencode-consilium
 */

export { parseJsonOutput } from './stream.js';

export {
  callAgent,
  callChair,
  callExpertsParallel,
  cancel,
  createRunController,
  getAvailableAgents,
  isCancelled,
  resetCancel
} from './runner.js';
export type { RunController } from './runner.js';

export { sanitizeTimeout } from './retry.js';

export { buildRunArgs } from './args.js';

export { buildAgentSession, buildChairSession } from '../../domain/council/sessions.js';

export { checkOpenCodeAvailable, getOpenCodeVersion } from './version.js';
