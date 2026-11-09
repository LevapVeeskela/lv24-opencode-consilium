import { StringDecoder } from 'node:string_decoder';
import { describeError } from './format.js';
import { isRecord } from './validation.js';

export const DEFAULT_VERSION = '1.9.0';
export const SERVER_NAME = 'lv24-opencode-consilium';
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18'
];

export type ProgressToken = string | number;
export type RequestId = string | number | null;
export type NotificationSink = (message: Record<string, unknown>) => void;

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: RequestId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: { listChanged: boolean };
    logging: Record<string, never>;
  };
  serverInfo: { name: string; version: string };
  instructions: string;
}

let notificationSink: NotificationSink | null = null;

export function getNotificationSink(): NotificationSink | null {
  return notificationSink;
}

export function setNotificationSink(sink: NotificationSink | null): void {
  notificationSink = sink;
}

export function emitNotification(message: Record<string, unknown>): void {
  const sink = notificationSink;
  if (sink === null) return;
  try {
    sink(message);
  } catch {
    // Progress notifications are best-effort.
  }
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function jsonRpcSuccess(id: RequestId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(
  id: RequestId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return data === undefined
    ? { jsonrpc: '2.0', id, error: { code, message } }
    : { jsonrpc: '2.0', id, error: { code, message, data } };
}

export function normalizeRequestId(value: unknown): RequestId {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

export function extractProgressToken(
  params: Record<string, unknown>
): ProgressToken | undefined {
  const meta = params['_meta'];
  if (!isRecord(meta)) return undefined;
  const token = meta['progressToken'];
  if (typeof token === 'string' || typeof token === 'number') return token;
  return undefined;
}

export function readLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onOversizedLine: () => void
): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    let buffer = '';
    let discarding = false;
    let finished = false;
    const decoder = new StringDecoder('utf8');

    function cleanup(): void {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onClose);
      stream.off('error', onError);
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      cleanup();
      resolvePromise();
    }

    function reportOversized(): void {
      if (discarding) return;
      discarding = true;
      onOversizedLine();
    }

    function handleLine(rawLine: string): void {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length === 0) return;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        onOversizedLine();
        return;
      }
      onLine(line);
    }

    function onData(chunk: Buffer | string): void {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

      for (;;) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
            reportOversized();
            buffer = '';
          }
          return;
        }

        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (discarding) {
          discarding = false;
          continue;
        }

        handleLine(rawLine);
      }
    }

    function onEnd(): void {
      buffer += decoder.end();
      if (buffer.length > 0 && !discarding) {
        handleLine(buffer);
      }
      finish();
    }

    function onClose(): void {
      finish();
    }

    function onError(error: unknown): void {
      process.stderr.write(`MCP stdin error: ${describeError(error)}\n`);
      finish();
    }

    const state = stream as NodeJS.ReadableStream & {
      readableEnded?: boolean;
      destroyed?: boolean;
    };
    if (state.readableEnded === true || state.destroyed === true) {
      resolvePromise();
      return;
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onClose);
    stream.on('error', onError);
  });
}
