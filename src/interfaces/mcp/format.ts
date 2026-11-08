export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

export function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function formatTimestamp(milliseconds: number): string {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? String(milliseconds) : date.toISOString();
}

export function toolText(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

export function toolError(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
