// MCP tool handler barrel: per-tool handlers plus run state and JSON-RPC entry points.
export {
  cancelActiveConsilium,
  clearActiveConsilium,
  getActiveRunRequestId,
  setActiveConsilium
} from './shared.js';
export { toolConsiliumRun } from './run.js';
export { toolListAgents } from './agents.js';
export { toolFreeModels } from './models.js';
export { toolDoctor } from './doctor.js';
export { toolInitFree } from './init-free.js';
export { executeTool, handleMcpRequest } from './dispatch.js';
