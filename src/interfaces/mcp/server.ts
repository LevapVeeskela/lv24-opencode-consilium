import { describeError } from './format.js';
import {
  cancelActiveConsilium,
  getActiveRunRequestId,
  handleMcpRequest
} from './handlers.js';
import {
  DEFAULT_VERSION,
  getNotificationSink,
  jsonRpcError,
  normalizeRequestId,
  readLines,
  safeJson,
  setNotificationSink
} from './protocol.js';
import { isRecord } from './validation.js';

/** Максимум одновременно принятых (ожидающих или выполняющихся) tool-call. */
const MAX_PENDING_TOOL_CALLS = 16;
const MAX_CANCELLED_IDS = 256;

function requestIdKey(value: unknown): string | null {
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') return `n:${value}`;
  return null;
}

export interface StartMcpServerOptions {
  version?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

function writeJsonLine(stream: NodeJS.WritableStream, message: unknown): void {
  try {
    stream.write(`${JSON.stringify(message)}\n`);
  } catch (error) {
    process.stderr.write(`MCP write failed: ${describeError(error)}\n`);
  }
}

async function processInputLine(
  line: string,
  stdout: NodeJS.WritableStream,
  version: string
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    writeJsonLine(stdout, jsonRpcError(null, -32700, 'Parse error'));
    return;
  }

  const response = await handleMcpRequest(parsed, { version });
  if (response !== null) {
    writeJsonLine(stdout, response);
  }
}

function stringifyConsoleValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  return safeJson(value);
}

function redirectConsoleLogs(): () => void {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  const writeToStderr = (...data: unknown[]): void => {
    try {
      const text = data.map(stringifyConsoleValue).join(' ');
      process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
    } catch {
      // Logging must never break the protocol.
    }
  };

  console.log = writeToStderr;
  console.info = writeToStderr;
  console.debug = writeToStderr;

  return (): void => {
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
  };
}

export async function startMcpServer(opts: StartMcpServerOptions = {}): Promise<void> {
  const version = opts.version ?? DEFAULT_VERSION;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  const previousSink = getNotificationSink();
  setNotificationSink((message: Record<string, unknown>): void => {
    writeJsonLine(stdout, message);
  });

  const restoreConsole = redirectConsoleLogs();

  const onOutputError = (error: unknown): void => {
    process.stderr.write(`MCP stdout error: ${describeError(error)}\n`);
  };

  try {
    stdout.on('error', onOutputError);
  } catch {
    // A custom stream may not support event listeners.
  }

  let queue: Promise<void> = Promise.resolve();
  let transportClosed = false;
  let pendingToolCalls = 0;
  const queuedIds = new Set<string>();
  const cancelledIds = new Set<string>();

  const enqueueToolCall = (line: string, id: unknown): void => {
    if (pendingToolCalls >= MAX_PENDING_TOOL_CALLS) {
      writeJsonLine(
        stdout,
        jsonRpcError(normalizeRequestId(id), -32000, 'Server busy: too many pending tool calls')
      );
      return;
    }

    const key = requestIdKey(id);
    if (key !== null) queuedIds.add(key);
    pendingToolCalls += 1;

    queue = queue
      .then(async () => {
        if (key !== null) {
          queuedIds.delete(key);
          // Отменённый до старта запрос не должен выполнять инструмент.
          if (cancelledIds.delete(key)) return;
        }
        if (transportClosed) return;
        await processInputLine(line, stdout, version);
      })
      .catch((error: unknown) => {
        process.stderr.write(`MCP handler error: ${describeError(error)}\n`);
      })
      .finally(() => {
        pendingToolCalls -= 1;
      });
  };

  const handleLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeJsonLine(stdout, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }

    if (isRecord(parsed)) {
      const method = parsed['method'];
      if (method === 'notifications/cancelled') {
        const cancelParams = isRecord(parsed['params']) ? parsed['params'] : undefined;
        const target = cancelParams?.['requestId'];
        const key = requestIdKey(target);
        if (key !== null && queuedIds.has(key)) {
          cancelledIds.add(key);
          if (cancelledIds.size > MAX_CANCELLED_IDS) {
            const oldest = cancelledIds.values().next().value;
            if (typeof oldest === 'string') cancelledIds.delete(oldest);
          }
        }
        if (target === undefined || target === getActiveRunRequestId()) {
          cancelActiveConsilium();
        }
        return;
      }
      if (method === 'tools/call') {
        const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id');
        if (!hasId) {
          writeJsonLine(
            stdout,
            jsonRpcError(null, -32600, 'Invalid Request: tools/call requires an id')
          );
          return;
        }
        enqueueToolCall(line, parsed['id']);
        return;
      }
    }

    // Control methods and notifications never wait behind a long council run.
    void processInputLine(line, stdout, version);
  };

  function cleanup(): void {
    setNotificationSink(previousSink);
    restoreConsole();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    try {
      stdout.off('error', onOutputError);
    } catch {
      // Ignore streams without removeListener support.
    }
  }

  function onSignal(): void {
    transportClosed = true;
    cancelActiveConsilium();
    cleanup();
    process.exit(0);
  }

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await readLines(stdin, handleLine, () => {
      writeJsonLine(
        stdout,
        jsonRpcError(null, -32700, 'Parse error: input line exceeds 4 MiB')
      );
    });
    // Транспорт закрыт — отменяем активный запуск, не начинаем новые и не висим дольше таймаута.
    transportClosed = true;
    cancelActiveConsilium();
    await Promise.race([
      queue,
      new Promise<void>(resolveTimeout => {
        const timer = setTimeout(resolveTimeout, 5000);
        timer.unref();
      })
    ]);
  } finally {
    cleanup();
  }
}
