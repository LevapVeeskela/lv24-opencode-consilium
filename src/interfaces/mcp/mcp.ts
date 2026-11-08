// MCP stdio server barrel. Implementation is split across focused modules.
export type { McpToolDef } from './tools.js';
export { getMcpTools } from './tools.js';
export type { StartMcpServerOptions } from './server.js';
export { startMcpServer } from './server.js';
export { handleMcpRequest } from './handlers.js';
