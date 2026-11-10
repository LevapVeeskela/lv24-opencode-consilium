// Shared run state, coercion helpers and result helpers for MCP tool handlers.
import type { Consilium } from '../../../application/consilium.js';
import { canonicalizePath, resolveInside } from '../../../shared/paths.js';
import type { RequestId } from '../protocol.js';

export type { McpToolResult } from '../format.js';
export { describeError, toolError, toolText } from '../format.js';
export {
  ToolInputError,
  isRecord,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalNonNegativeNumber,
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

/**
 * Резолвит путь внутри workspace. Возвращает ошибку без абсолютных путей,
 * чтобы не раскрывать файловую систему за пределами проекта.
 */
export function resolveWorkspaceOutput(
  value: string | undefined,
  label: string
): { value?: string; error?: string } {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }
  const workspace = canonicalizePath(process.cwd());
  try {
    const resolved = resolveInside(workspace, value, label);
    if (resolved === workspace) {
      return { error: `"${label}" must stay inside the workspace` };
    }
    return { value: resolved };
  } catch {
    return { error: `"${label}" must stay inside the workspace` };
  }
}
