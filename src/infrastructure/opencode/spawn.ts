/**
 * @fileoverview Запуск процесса OpenCode: spawn, захват stdout/stderr, разбор NDJSON, хуки
 * @module lv24-opencode-consilium
 */

import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import type { AgentErrorCode, AgentResult, ConsiliumConfig } from '../../domain/types.js';
import { createEventDecoder, type ParsedStream, type StreamError } from './stream.js';
import { buildRunArgs } from './args.js';
import {
  getControllerState,
  killProcessTree,
  killTimers,
  type RunController
} from './controller.js';

/** Ограничение захвата stdout/stderr (1 МиБ) */
const MAX_CAPTURE_LENGTH = 1024 * 1024;

export function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logWarn(config: ConsiliumConfig, message: string): void {
  try {
    config.hooks?.onLog?.('warn', message);
  } catch {
    // Хук логов не должен ломать запуск
  }
}

export async function invokeHook(
  config: ConsiliumConfig,
  hook: () => unknown,
  name: string
): Promise<void> {
  try {
    await hook();
  } catch (error) {
    logWarn(config, `Ошибка хука ${name}: ${errorToMessage(error)}`);
  }
}

export async function invokeErrorHook(
  config: ConsiliumConfig,
  isChair: boolean,
  result: AgentResult
): Promise<void> {
  const hook = isChair ? config.hooks?.onChairError : config.hooks?.onExpertError;
  if (!hook) return;
  try {
    await hook(result);
  } catch (error) {
    logWarn(
      config,
      `Ошибка хука ${isChair ? 'onChairError' : 'onExpertError'}: ${errorToMessage(error)}`
    );
  }
}

interface SpawnSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** Готовит команду запуска (на Windows — через cmd.exe для .cmd-шимов) */
function buildSpawnSpec(opencodePath: string, args: string[]): SpawnSpec {
  if (process.platform !== 'win32') {
    return { command: opencodePath, args };
  }

  const comspec = process.env.ComSpec || 'cmd.exe';
  const safePath = opencodePath.replace(/"/g, '');
  const commandLine = `"${safePath}" ` + args.map(quoteCmdArg).join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

/** Путь к исполняемому файлу opencode из конфигурации */
export function resolveOpenCodePath(config?: Pick<ConsiliumConfig, 'opencodePath'>): string {
  const configured = config?.opencodePath?.trim();
  return configured !== undefined && configured.length > 0 ? configured : 'opencode';
}

/** Рабочий каталог запуска из конфигурации */
export function resolveCwd(config?: Pick<ConsiliumConfig, 'cwd'>): string {
  const configured = config?.cwd?.trim();
  return configured !== undefined && configured.length > 0 ? configured : process.cwd();
}

function appendCapped(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_CAPTURE_LENGTH) return current;
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  return (current + text).slice(0, MAX_CAPTURE_LENGTH);
}

function tailText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(trimmed.length - maxLength);
}

function formatExitCode(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit code ${code}`;
  if (signal) return `процесс завершён сигналом ${signal}`;
  return 'exit code неизвестен';
}

function classifyError(message: string): AgentErrorCode {
  if (/Agent not found|agent[-_. ]not[-_. ]found/i.test(message)) return 'AGENT_NOT_FOUND';
  if (isModelUnavailableMessage(message)) return 'MODEL_UNAVAILABLE';
  return 'EXIT_ERROR';
}

/** Типы ошибок OpenCode, означающие исчерпание квоты или rate limit */
const RATE_LIMIT_PATTERN = /(free[-_.]?limit|rate[-_.]?limit|quota|too[-_.]?many[-_.]?requests|resource[-_.]?exhausted)/i;

/** Проверяет, что ошибка потока — rate limit или исчерпание квоты */
function isRateLimitError(detail: StreamError): boolean {
  if (detail.status === 429) return true;
  return RATE_LIMIT_PATTERN.test(`${detail.type ?? ''} ${detail.code ?? ''}`);
}

/** Проверяет текст ошибки на недоступную модель */
function isModelUnavailableMessage(message: string): boolean {
  return /Model unavailable|no-route|model[-_. ]not[-_. ]found|not found in catalog/i.test(message);
}

/** Определяет код ошибки по структурированным событиям потока */
function classifyStreamErrors(parsed: ParsedStream): AgentErrorCode {
  for (const detail of parsed.errorDetails) {
    if (isRateLimitError(detail)) return 'RATE_LIMITED';
    if (isModelUnavailableMessage(detail.message)) return 'MODEL_UNAVAILABLE';
  }
  return 'EXIT_ERROR';
}

/** Форматирует длительность ожидания для сообщения пользователю */
function formatRetryAfter(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} ч`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} мин`;
  return `${Math.max(1, Math.round(ms / 1000))} с`;
}

/** Добавляет к сообщению подсказку о времени повтора */
function withRetryHint(message: string, detail: StreamError | undefined): string {
  if (detail?.retryAfterMs === undefined || detail.retryAfterMs <= 0) return message;
  return `${message} (повтор возможен через ~${formatRetryAfter(detail.retryAfterMs)})`;
}

/** Итог одного запуска процесса */
export interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  timedOut: boolean;
  cancelled: boolean;
}

/** Параметры запуска процесса opencode */
export interface ProcessRunOptions {
  opencodePath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  input?: string;
  controller?: RunController;
}

/** Запускает opencode, пишет промпт в stdin и собирает вывод */
export function executeOpenCode(options: ProcessRunOptions): Promise<ProcessOutcome> {
  return new Promise<ProcessOutcome>(resolve => {
    if (options.controller?.isCancelled()) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: true
      });
      return;
    }

    let child: ChildProcess | undefined;
    try {
      const spec = buildSpawnSpec(options.opencodePath, options.args);
      child = spawn(spec.command, spec.args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: spec.windowsVerbatimArguments
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        spawnError: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
        cancelled: false
      });
      return;
    }

    if (!child) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        spawnError: new Error('Не удалось запустить opencode'),
        timedOut: false,
        cancelled: false
      });
      return;
    }

    const proc = child;
    const state = options.controller ? getControllerState(options.controller) : undefined;
    state?.children.add(proc);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (state) state.children.delete(proc);
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const killTimer = killTimers.get(proc);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimers.delete(proc);
      }
    };

    const settle = (outcome: ProcessOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(proc);
        settle({
          code: null,
          signal: null,
          stdout,
          stderr,
          timedOut: true,
          cancelled: false
        });
      }, options.timeoutMs);
    }

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    proc.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk);
      stdout = appendCapped(stdout, text);
    });

    proc.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk);
      stderr = appendCapped(stderr, text);
    });

    const stdin = proc.stdin;
    if (stdin) {
      stdin.on('error', () => {
        // Обрыв stdin (EPIPE): дочерний процесс уже не получит промпт
        if (!settled) {
          killProcessTree(proc);
        }
      });
      try {
        if (options.input !== undefined) {
          stdin.write(options.input, 'utf8');
        }
        stdin.end();
      } catch (error) {
        killProcessTree(proc);
        try {
          stdin.end();
        } catch {
          // stdin уже закрыт
        }
        settle({
          code: null,
          signal: null,
          stdout,
          stderr,
          spawnError: error instanceof Error ? error : new Error(String(error)),
          timedOut: false,
          cancelled: false
        });
        return;
      }
    }

    proc.on('error', (error: Error) => {
      settle({
        code: null,
        signal: null,
        stdout,
        stderr,
        spawnError: error,
        timedOut: false,
        cancelled: false
      });
    });

    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      stdout = appendCapped(stdout, stdoutDecoder.end());
      stderr = appendCapped(stderr, stderrDecoder.end());
      settle({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        cancelled: false
      });
    });
  });
}

export interface ProcessCallOptions {
  agentName: string;
  agentArg?: string;
  model?: string;
  session?: string;
  prompt: string;
  timeoutMs: number;
  attempt: number;
  controller: RunController;
  config: ConsiliumConfig;
}

/** Один запуск процесса opencode для агента */
export async function runAgentProcess(options: ProcessCallOptions): Promise<AgentResult> {
  const extraArgs = options.config.opencodeArgs ?? [];
  const args = buildRunArgs({
    agent: options.agentArg,
    model: options.model,
    session: options.session,
    config: options.config
  }).concat(extraArgs);

  const outcome = await executeOpenCode({
    opencodePath: resolveOpenCodePath(options.config),
    args,
    cwd: resolveCwd(options.config),
    timeoutMs: options.timeoutMs,
    input: options.prompt,
    controller: options.controller
  });

  const decoder = createEventDecoder();
  decoder.push(outcome.stdout);
  const parsed = decoder.end();
  const text = parsed.text;
  const stderrTail = tailText(outcome.stderr, 500);
  const streamCode = classifyStreamErrors(parsed);
  const rateLimit = parsed.errorDetails.find(isRateLimitError);

  const base: AgentResult = {
    agent: options.agentName,
    text,
    success: false,
    attempt: options.attempt,
    exitCode: outcome.code,
    usage: parsed.usage
  };
  if (options.model !== undefined) {
    base.model = options.model;
  }
  if (rateLimit?.retryAfterMs !== undefined) {
    base.retryAfterMs = rateLimit.retryAfterMs;
  }
  if (parsed.sessionID !== undefined) {
    base.sessionId = parsed.sessionID;
  }

  if (outcome.cancelled) {
    return {
      ...base,
      errorCode: 'CANCELLED',
      errorMessage: 'Запуск отменён',
      exitCode: null
    };
  }

  if (outcome.spawnError) {
    return {
      ...base,
      errorCode: 'SPAWN_ERROR',
      errorMessage: outcome.spawnError.message,
      exitCode: null
    };
  }

  if (outcome.timedOut) {
    return {
      ...base,
      errorCode: 'TIMEOUT',
      errorMessage: `Таймаут ${options.timeoutMs} мс`,
      exitCode: null
    };
  }

  if (outcome.code === 0 && text.trim().length > 0) {
    return { ...base, success: true };
  }

  if (options.controller.isCancelled()) {
    return {
      ...base,
      errorCode: 'CANCELLED',
      errorMessage: 'Запуск отменён'
    };
  }

  if (outcome.code !== 0) {
    const message =
      parsed.errors.join('; ') ||
      stderrTail ||
      formatExitCode(outcome.code, outcome.signal);
    return {
      ...base,
      errorCode: streamCode !== 'EXIT_ERROR' ? streamCode : classifyError(message),
      errorMessage: withRetryHint(message, rateLimit)
    };
  }

  const message =
    parsed.errors.join('; ') ||
    stderrTail ||
    `Пустой ответ агента${parsed.eventCount > 0 ? ` (событий: ${parsed.eventCount})` : ''}`;
  return {
    ...base,
    errorCode: streamCode !== 'EXIT_ERROR' ? streamCode : 'EMPTY_RESPONSE',
    errorMessage: withRetryHint(message, rateLimit)
  };
}
