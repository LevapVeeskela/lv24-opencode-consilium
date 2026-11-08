/**
 * @fileoverview Совместимость с OpenCode V1 и V2
 * @module lv24-opencode-consilium
 *
 * Модуль не работает с файловой системой: все функции чистые, чтобы их можно
 * было покрыть тестами и переиспользовать в CLI, MCP и doctor.
 *
 * Правила совместимости:
 * - OpenCode V2 читает V1-конфигурацию, поэтому V1-форма остаётся базовой.
 * - Нативные V2-поля (`agents`, `commands`, `providers`, `permissions`,
 *   `mcp.servers`) в V1 не работают, поэтому писать их можно только в файл,
 *   который уже ведётся в нативном V2-формате.
 * - Внутри одной записи агента нельзя смешивать V1-поля (`prompt`, `disable`,
 *   `permission`) и V2-поля (`system`, `disabled`, `permissions`).
 * - `opencode run --agent` в V2 не применяет модель агента из конфигурации,
 *   поэтому модель всегда нужно передавать через `--model`.
 */

export {
  LEGACY_V1_FIELDS,
  detectConfigFlavor,
  describeConfigFlavor,
  findLegacyV1Fields,
  parseOpenCodeVersion,
  splitModelRef,
  toModelRef,
  type ConfigFlavor,
  type OpenCodeCliInfo,
  type OpenCodeMajor
} from './readers.js';

export {
  readAgentDefinition,
  readAgentSection,
  upsertAgents,
  type AgentDefinitionView,
  type AgentSectionView,
  type AgentWrite,
  type UpsertAgentsResult
} from './agents.js';

export {
  buildMcpServerEntry,
  describeMcpShellCommand,
  readMcpSection,
  upsertMcpServer,
  type McpLocalServerSpec,
  type McpSectionView,
  type UpsertMcpResult
} from './mcp.js';
