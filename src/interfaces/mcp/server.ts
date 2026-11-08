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
  readLines,
  safeJson,
  setNotificationSink
} from './protocol.js';
import { isRecord } from './validation.js';

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

  const enqueueToolCall = (line: string): void => {
    queue = queue
      .then(async () => {
        if (transportClosed) return;
        await processInputLine(line, stdout, version);
      })
      .catch((error: unknown) => {
        process.stderr.write(`MCP handler error: ${describeError(error)}\n`);
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
        if (target === undefined || target === getActiveRunRequestId()) {
          cancelActiveConsilium();
        }
        return;
      }
      const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id');
      if (hasId && method === 'tools/call') {
        enqueueToolCall(line);
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
