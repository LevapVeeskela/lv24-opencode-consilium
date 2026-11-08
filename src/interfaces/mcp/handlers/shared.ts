// Shared run state, coercion helpers and result helpers for MCP tool handlers.
import type { Consilium } from '../../../application/consilium.js';
import type { RequestId } from '../protocol.js';

export type { McpToolResult } from '../format.js';
export { describeError, toolError, toolText } from '../format.js';
export {
  ToolInputError,
  isRecord,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalPositiveNumber,
  optionalString,
  optionalStringArray,
  requireNonEmptyString
} from '../validation.js';

let activeConsilium: Consilium | null = null;
let activeRunRequestId: RequestId | undefined;

export function setActiveConsilium(consilium: Consilium, requestId?: RequestId): void {
  activeConsilium = consilium;
  activeRunRequestId = requestId;
}

export function clearActiveConsilium(consilium: Consilium): void {
  if (activeConsilium === consilium) activeConsilium = null;
  if (activeConsilium === null) activeRunRequestId = undefined;
}

export function cancelActiveConsilium(): void {
  try {
    activeConsilium?.cancel();
  } catch {
    // Cancellation is best-effort.
  }
}

export function getActiveRunRequestId(): RequestId | undefined {
  return activeRunRequestId;
}
