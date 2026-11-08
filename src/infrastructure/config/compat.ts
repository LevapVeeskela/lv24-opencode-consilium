/**
 * @fileoverview Barrel совместимости с OpenCode V1 и V2
 * @module lv24-opencode-consilium
 *
 * Реализация разнесена по модулям `./compat/`:
 * - `readers.ts` — помощники формы значений и низкоуровневое чтение секций;
 * - `agents.ts` — раздел агентов (`agent` / `agents`);
 * - `mcp.ts` — раздел MCP-серверов (`mcp` / `mcp.servers`).
 */

export * from './compat/index.js';
