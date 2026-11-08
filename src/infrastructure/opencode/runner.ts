/**
 * @fileoverview Публичный фасад запуска агентов OpenCode
 * @module lv24-opencode-consilium
 *
 * Реализация разделена по слоям:
 * - `controller.ts` — отмена и учёт дочерних процессов;
 * - `spawn.ts` — запуск процесса, захват вывода, разбор NDJSON, хуки;
 * - `calls.ts` — попытки вызова, повторы, эксперты и председатель.
 */

export { cancel, createRunController, isCancelled, resetCancel } from './controller.js';
export type { RunController } from './controller.js';

export { executeOpenCode, resolveCwd, resolveOpenCodePath } from './spawn.js';
export type { ProcessOutcome, ProcessRunOptions } from './spawn.js';

export {
  callAgent,
  callChair,
  callExpertsParallel,
  getAvailableAgents
} from './calls.js';
