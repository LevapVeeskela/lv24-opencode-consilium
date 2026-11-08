/**
 * @fileoverview Управление агентами OpenCode
 * @module opencode-consilium
 */

import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import type {
  AgentErrorCode,
  AgentResult,
  AgentUsage,
  ConsiliumConfig,
  ExpertConfig
} from './types.js';
import { DEFAULT_EXPERT_PROMPTS } from './defaults.js';
import { createEventDecoder, type ParsedStream, type StreamError } from './stream.js';
import { resolveOpenCodeAgent } from './config.js';
import { analyzeConsensus, buildConsensusPromptSection } from './consensus.js';
import { buildFallbackChain, shouldFallback } from './fallback.js';

export { parseJsonOutput } from './stream.js';

/** Ограничение захвата stdout/stderr (1 МиБ) */
const MAX_CAPTURE_LENGTH = 1024 * 1024;
const DEFAULT_TIMEOUT = 300000;
const DEFAULT_CHAIR_TIMEOUT = 600000;
const DEFAULT_RETRY_DELAY = 1000;
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_EXPERT_TEXT = 3000;
const AVAILABILITY_TIMEOUT = 10000;

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@\/#+-]*$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@\/_-]*$/;
const MAX_RETRIES = 10;
const MAX_CONCURRENCY = 8;

/** Контроллер запуска: отмена и учёт дочерних процессов */
export interface RunController {
  cancel(): void;
  reset(): void;
  isCancelled(): boolean;
}

interface ControllerState {
  cancelled: boolean;
  children: Set<ChildProcess>;
}

const controllerStates = new WeakMap<RunController, ControllerState>();
const killTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();

/** Создаёт независимый контроллер запуска */
export function createRunController(): RunController {
  const state: ControllerState = {
    cancelled: false,
    children: new Set<ChildProcess>()
  };

  const controller: RunController = {
    cancel(): void {
      state.cancelled = true;
      for (const child of [...state.children]) {
        killProcessTree(child);
      }
      state.children.clear();
    },
    reset(): void {
      state.cancelled = false;
    },
    isCancelled(): boolean {
      return state.cancelled;
    }
  };

  controllerStates.set(controller, state);
  return controller;
}

function getControllerState(controller: RunController): ControllerState {
  let state = controllerStates.get(controller);
  if (!state) {
    state = { cancelled: false, children: new Set<ChildProcess>() };
    controllerStates.set(controller, state);
  }
  return state;
}

const defaultController = createRunController();

/** Отменяет запуск по умолчанию и убивает его процессы */
export function cancel(): void {
  defaultController.cancel();
}

/** Сбрасывает флаг отмены запуска по умолчанию */
export function resetCancel(): void {
  defaultController.reset();
}

/** Проверяет, отменён ли запуск по умолчанию */
export function isCancelled(): boolean {
  return defaultController.isCancelled();
}

/** Убивает процесс и его дерево */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;

  if (process.platform === 'win32') {
    if (pid === undefined) {
      try {
        child.kill();
      } catch {
        // Игнорируем
      }
      return;
    }

    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true
      });
      killer.on('error', () => {
        // taskkill недоступен — пробуем убить хотя бы сам процесс
        try {
          child.kill();
        } catch {
          // Игнорируем
        }
      });
      killer.on('close', code => {
        if (code !== 0) {
          try {
            child.kill();
          } catch {
            // Игнорируем
          }
        }
      });
      killer.unref();
    } catch {
      try {
        child.kill();
      } catch {
        // Игнорируем
      }
    }
    return;
  }

  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (pid !== undefined) {
        process.kill(-pid, signal);
        return;
      }
    } catch {
      // Группа недоступна — убиваем сам процесс
    }
    try {
      child.kill(signal);
    } catch {
      // Игнорируем
    }
  };

  signalGroup('SIGTERM');

  if (killTimers.has(child)) return;
  const killerTimer = setTimeout(() => {
    killTimers.delete(child);
    signalGroup('SIGKILL');
  }, 2000);
  killerTimer.unref();
  killTimers.set(child, killerTimer);
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric <= 0 || !Number.isInteger(numeric)) {
    return undefined;
  }
  return numeric;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || !Number.isInteger(numeric)) {
    return undefined;
  }
  return numeric;
}

/** Нормализует таймаут: конечное положительное число (мс) либо fallback */
export function sanitizeTimeout(value: unknown, fallback: number): number {
  const toTimeout = (candidate: unknown): number | undefined => {
    const numeric = toFiniteNumber(candidate);
    if (numeric === undefined || numeric <= 0) return undefined;
    return Math.max(1, Math.round(numeric));
  };
  return toTimeout(value) ?? toTimeout(fallback) ?? DEFAULT_TIMEOUT;
}

/**
 * Строит идентификатор сессии OpenCode для конкретного агента.
 * Эксперты не должны делить одну сессию: к контексту добавляется имя агента.
 */
export function buildAgentSession(
  base: string | undefined,
  agentName: string
): string | undefined {
  const trimmed = base?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;

  // OpenCode требует, чтобы session id начинался с "ses".
  const prefixed = trimmed.startsWith('ses') ? trimmed : `ses_${trimmed}`;
  const suffix = `-${agentName.trim().length > 0 ? agentName.trim() : 'default'}`;
  const cleaned = `${prefixed}${suffix}`
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');

  // Обрезаем базу, а не суффикс: иначе разные агенты получат одинаковый id.
  const maxBase = Math.max(8, 128 - suffix.length);
  return cleaned.length <= 128
    ? cleaned
    : `${cleaned.slice(0, Math.min(maxBase, cleaned.length - suffix.length))}${suffix}`;
}

/**
 * Сессия председателя: базовый id используется как есть, чтобы продолжать
 * существующую сессию OpenCode, а не создавать новую.
 */
export function buildChairSession(base: string | undefined): string | undefined {
  const trimmed = base?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;

  const prefixed = trimmed.startsWith('ses') ? trimmed : `ses_${trimmed}`;
  const cleaned = prefixed
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');

  return cleaned.length > 0 ? cleaned.slice(0, 128) : undefined;
}

function sanitizeRetries(value: unknown, fallback: number): number {
  const retries = nonNegativeInteger(value) ?? nonNegativeInteger(fallback) ?? 0;
  return Math.min(MAX_RETRIES, retries);
}

function calculateRetryDelay(
  attempt: number,
  baseDelay: number,
  exponentialBackoff: boolean,
  jitter: boolean
): number {
  const base = exponentialBackoff ? baseDelay * Math.pow(2, attempt) : baseDelay;
  if (!jitter) return base;
  // Полный джиттер 50–100%: параллельные эксперты не упираются в лимит одновременно.
  return Math.max(0, Math.round(base * (0.5 + Math.random() * 0.5)));
}

/** Максимальная задержка rate limit, которую имеет смысл ждать внутри запуска */
const RATE_LIMIT_RETRY_WINDOW_MS = 30_000;

/** Проверяет, имеет ли смысл повторять попытку */
function isRetryable(code: AgentErrorCode | undefined, retryAfterMs?: number): boolean {
  if (code === undefined) return true;
  if (code === 'RATE_LIMITED') {
    // Короткий лимит (секунды) пережидаем; длинный — сразу отдаём ошибку.
    return (
      retryAfterMs !== undefined &&
      retryAfterMs > 0 &&
      retryAfterMs <= RATE_LIMIT_RETRY_WINDOW_MS
    );
  }
  return (
    code !== 'CANCELLED' &&
    code !== 'MODEL_UNAVAILABLE' &&
    code !== 'PARSE_ERROR' &&
    code !== 'AGENT_NOT_FOUND' &&
    code !== 'COST_LIMIT'
  );
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logWarn(config: ConsiliumConfig, message: string): void {
  try {
    config.hooks?.onLog?.('warn', message);
  } catch {
    // Хук логов не должен ломать запуск
  }
}

async function invokeHook(
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

async function invokeErrorHook(
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

/**
 * Формирует аргументы `opencode run`.
 * Невалидные agent/model отбрасываются.
 */
export function buildRunArgs(opts: {
  agent?: string;
  model?: string;
  session?: string;
  config?: Pick<ConsiliumConfig, 'standalone' | 'autoApprove'>;
}): string[] {
  const args: string[] = ['run'];

  if (opts.config?.standalone !== false) {
    args.push('--standalone');
  }

  args.push('--format', 'json');

  if (opts.config?.autoApprove) {
    args.push('--auto');
  }

  const agent = opts.agent?.trim();
  if (agent !== undefined && agent.length > 0 && AGENT_NAME_PATTERN.test(agent)) {
    args.push(`--agent=${agent}`);
  }

  const model = opts.model?.trim();
  if (model !== undefined && model.length > 0 && MODEL_PATTERN.test(model)) {
    args.push(`--model=${model}`);
  }

  const session = opts.session?.trim();
  if (session !== undefined && session.length > 0 && SESSION_PATTERN.test(session)) {
    args.push(`--session=${session}`);
  }

  return args;
}

function buildExpertPrompt(expert: ExpertConfig, task: string): string {
  if (typeof expert.prompt === 'function') {
    return expert.prompt(task);
  }
  if (typeof expert.prompt === 'string' && expert.prompt.trim().length > 0) {
    return expert.prompt.replace(/\$\{task\}/g, task);
  }

  const fallback = Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, expert.name)
    ? DEFAULT_EXPERT_PROMPTS[expert.name]
    : DEFAULT_EXPERT_PROMPTS.default;
  if (typeof fallback === 'function') {
    return fallback(task);
  }
  if (typeof fallback === 'string') {
    return fallback.replace(/\$\{task\}/g, task);
  }
  return task;
}

function buildChairPrompt(
  task: string,
  expertResults: AgentResult[],
  maxExpertTextLength: number,
  consensus = false
): string {
  const successful = expertResults.filter(result => result.success);

  let prompt = `Синтезируй мнения экспертов и составь итоговый план. Не вызывай инструменты — ответь только текстом.\n\n`;
  prompt += `## Задача\n${task}\n\n`;
  prompt += `## Мнения экспертов\n`;

  for (const result of successful) {
    const cleanText = result.text.substring(0, maxExpertTextLength);
    prompt += `### ${result.agent.toUpperCase()}\n${cleanText}\n\n`;
  }

  const failedCount = expertResults.length - successful.length;
  if (failedCount > 0) {
    prompt += `<!-- Не ответили экспертов: ${failedCount} -->\n\n`;
  }

  prompt += `## Требования к ответу\n`;
  prompt += `1. **Резюме** (1-2 предложения)\n`;
  prompt += `2. **Топ-3 приоритетных действия** с обоснованием\n`;
  prompt += `3. **Главный риск** и митигация\n`;
  prompt += `4. **Оценка трудозатрат** (если применимо)`;

  if (consensus === true) {
    const report = analyzeConsensus(
      expertResults.map(result => ({
        agent: result.agent,
        text: result.text,
        model: result.model,
        success: result.success
      }))
    );
    prompt += `\n\n${buildConsensusPromptSection(report)}`;
  }

  return prompt;
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

function resolveOpenCodePath(config?: Pick<ConsiliumConfig, 'opencodePath'>): string {
  const configured = config?.opencodePath?.trim();
  return configured !== undefined && configured.length > 0 ? configured : 'opencode';
}

function resolveCwd(config?: Pick<ConsiliumConfig, 'cwd'>): string {
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

interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  timedOut: boolean;
  cancelled: boolean;
}

interface ProcessRunOptions {
  opencodePath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  input?: string;
  controller?: RunController;
}

/** Запускает opencode, пишет промпт в stdin и собирает вывод */
function executeOpenCode(options: ProcessRunOptions): Promise<ProcessOutcome> {
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

interface ProcessCallOptions {
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
async function runAgentProcess(options: ProcessCallOptions): Promise<AgentResult> {
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

interface AgentAttemptOptions {
  agentName: string;
  prompt: string;
  model?: string;
  sessionBase?: string;
  isChair?: boolean;
  fallbackModels?: string[];
  timeoutMs: number;
  attempt: number;
  controller: RunController;
  config: ConsiliumConfig;
}

/** Суммирует usage двух вызовов (токены и стоимость) */
function sumUsagePair(a?: AgentUsage, b?: AgentUsage): AgentUsage | undefined {
  if (a === undefined && b === undefined) return undefined;

  const usage: AgentUsage = {};
  const fields = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens'
  ] as const;
  for (const field of fields) {
    const total = (a?.[field] ?? 0) + (b?.[field] ?? 0);
    if (total > 0) usage[field] = total;
  }
  usage.cost = (a?.cost ?? 0) + (b?.cost ?? 0);
  return usage;
}

/** Суммирует usage двух попыток (токены и стоимость) */
function mergeAttemptUsage(previous: AgentResult, next: AgentResult): AgentResult {
  const usage = sumUsagePair(previous.usage, next.usage);
  return usage === undefined ? next : { ...next, usage };
}

/** Одна попытка вызова агента: fallback по моделям и при отсутствии агента */
async function callAgentOnce(options: AgentAttemptOptions): Promise<AgentResult> {
  const agentName = options.agentName.trim();
  if (agentName.length > 0 && !AGENT_NAME_PATTERN.test(agentName)) {
    return {
      agent: options.agentName,
      text: '',
      success: false,
      errorCode: 'PARSE_ERROR',
      errorMessage: `Недопустимое имя агента: "${options.agentName}"`,
      attempt: options.attempt,
      exitCode: null
    };
  }

  const requestedModel = options.model?.trim();
  let model =
    requestedModel !== undefined && requestedModel.length > 0
      ? requestedModel
      : undefined;

  // OpenCode V2 не применяет модель агента из конфигурации при `run --agent`.
  // Заодно проверяем существование агента: для неизвестного имени сразу идём
  // default-агентом, иначе OpenCode создаст сессию с несуществующим агентом.
  let agentExists = agentName.length === 0;
  if (agentName.length > 0) {
    try {
      const resolved = resolveOpenCodeAgent(agentName, {
        opencodeConfigPath: options.config.opencodeConfigPath,
        cwd: options.config.cwd
      });
      agentExists = resolved.exists;
      if (
        model === undefined &&
        resolved.model !== undefined &&
        MODEL_PATTERN.test(resolved.model)
      ) {
        model = resolved.model;
      }
    } catch {
      // Конфигурация OpenCode недоступна: пусть модель и агента выбирает сам OpenCode
      agentExists = true;
    }
  }

  const agentArg = agentExists && agentName.length > 0 ? agentName : undefined;
  const sessionSuffix =
    agentName.length === 0 ? 'default' : agentExists ? agentName : `default-${agentName}`;
  const session = options.isChair === true
    ? buildChairSession(options.sessionBase)
    : buildAgentSession(options.sessionBase, sessionSuffix);

  if (model !== undefined && !MODEL_PATTERN.test(model)) {
    return {
      agent: options.agentName,
      text: '',
      success: false,
      errorCode: 'PARSE_ERROR',
      errorMessage: `Недопустимая модель: "${model}"`,
      attempt: options.attempt,
      exitCode: null
    };
  }

  let effectiveAgentArg = agentArg;
  let result = await runAgentProcess({
    agentName: options.agentName,
    agentArg: effectiveAgentArg,
    model,
    session,
    prompt: options.prompt,
    timeoutMs: options.timeoutMs,
    attempt: options.attempt,
    controller: options.controller,
    config: options.config
  });

  if (result.errorCode === 'AGENT_NOT_FOUND') {
    // Агент не найден: повторяем без --agent и с default-сессией.
    // Старую сессию не переиспользуем — OpenCode запомнил в ней несуществующего агента.
    const fallback = await runAgentProcess({
      agentName: options.agentName,
      agentArg: undefined,
      model,
      session: buildAgentSession(
        options.sessionBase,
        agentName.length > 0 ? `default-${agentName}` : 'default'
      ),
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
      attempt: options.attempt,
      controller: options.controller,
      config: options.config
    });
    if (model !== undefined) fallback.model = model;
    result = mergeAttemptUsage(result, fallback);
    effectiveAgentArg = undefined;
  }

  // Запасные модели: включаются только для RATE_LIMITED/MODEL_UNAVAILABLE/EMPTY_RESPONSE.
  const chain = buildFallbackChain(model, options.fallbackModels ?? [], { max: 2 });
  for (const candidate of chain) {
    if (result.success || !shouldFallback(result.errorCode)) break;
    if (options.controller.isCancelled()) break;

    const attempt = await runAgentProcess({
      agentName: options.agentName,
      agentArg: effectiveAgentArg,
      model: candidate,
      session,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
      attempt: options.attempt,
      controller: options.controller,
      config: options.config
    });
    attempt.model = candidate;
    result = mergeAttemptUsage(result, attempt);
    if (attempt.success) break;
  }

  return result;
}

function finalizeResult(
  result: AgentResult,
  startedAt: number,
  totalCost: number,
  hasCost: boolean,
  mergedUsage?: AgentUsage
): AgentResult {
  const usage: AgentUsage = { ...(mergedUsage ?? result.usage ?? {}) };
  if (hasCost) {
    usage.cost = totalCost;
  }
  return {
    ...result,
    duration: Date.now() - startedAt,
    usage
  };
}

function cancelledResult(agentName: string, attempt: number, model?: string): AgentResult {
  const result: AgentResult = {
    agent: agentName,
    text: '',
    success: false,
    errorCode: 'CANCELLED',
    errorMessage: 'Запуск отменён',
    attempt,
    exitCode: null
  };
  if (model !== undefined) {
    result.model = model;
  }
  return result;
}

/** Ожидание с проверкой отмены каждые 100 мс; false — отменено */
async function delayWithCancel(
  delayMs: number,
  controller: RunController
): Promise<boolean> {
  let remaining = delayMs;
  while (remaining > 0) {
    if (controller.isCancelled()) return false;
    const chunk = Math.min(100, remaining);
    await new Promise<void>(resolve => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
  return !controller.isCancelled();
}

/**
 * Вызывает одного агента с повторами и контролем отмены
 */
export async function callAgent(
  agentName: string,
  prompt: string,
  config: ConsiliumConfig,
  options: {
    timeout?: number;
    retries?: number;
    isChair?: boolean;
    model?: string;
    session?: string;
    fallbackModels?: string[];
    controller?: RunController;
  } = {}
): Promise<AgentResult> {
  const controller = options.controller ?? defaultController;
  const isChair = options.isChair === true;
  const sessionBase = options.session ?? config.session;
  const fallbackModels = options.fallbackModels ?? config.fallbackModels ?? [];

  const defaultTimeout = isChair
    ? sanitizeTimeout(config.timeouts?.chair, DEFAULT_CHAIR_TIMEOUT)
    : sanitizeTimeout(config.timeouts?.expert, DEFAULT_TIMEOUT);
  const timeoutMs = sanitizeTimeout(options.timeout, defaultTimeout);

  const defaultRetries = isChair
    ? nonNegativeInteger(config.retry?.chairRetries) ?? 1
    : nonNegativeInteger(config.retry?.expertRetries) ?? 1;
  const retries = sanitizeRetries(options.retries, defaultRetries);

  const delayMs = nonNegativeInteger(config.retry?.delay) ?? DEFAULT_RETRY_DELAY;
  const exponential = config.retry?.exponentialBackoff === true;
  const maxAttempts = retries + 1;
  const startedAt = Date.now();

  let totalCost = 0;
  let hasCost = false;
  let lastResult: AgentResult | undefined;
  let mergedUsage: AgentUsage | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (controller.isCancelled()) {
      return finalizeResult(
        cancelledResult(agentName, attempt, options.model),
        startedAt,
        totalCost,
        hasCost,
        mergedUsage
      );
    }

    if (attempt > 0) {
      const rateLimitDelay =
        lastResult?.errorCode === 'RATE_LIMITED' ? lastResult.retryAfterMs : undefined;
      const delay =
        rateLimitDelay !== undefined
          ? Math.min(rateLimitDelay, RATE_LIMIT_RETRY_WINDOW_MS)
          : calculateRetryDelay(
              attempt - 1,
              delayMs,
              exponential,
              config.retry?.jitter === true
            );
      const ready = await delayWithCancel(delay, controller);
      if (!ready) {
        return finalizeResult(
          cancelledResult(agentName, attempt, options.model),
          startedAt,
          totalCost,
          hasCost,
          mergedUsage
        );
      }
    }

    const result = await callAgentOnce({
      agentName,
      prompt,
      model: options.model,
      sessionBase,
      isChair,
      fallbackModels,
      timeoutMs,
      attempt,
      controller,
      config
    });

    const cost = result.usage?.cost;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      totalCost += cost;
      hasCost = true;
    }

    lastResult = result;
    mergedUsage = sumUsagePair(mergedUsage, result.usage);

    if (result.success) {
      return finalizeResult(result, startedAt, totalCost, hasCost, mergedUsage);
    }

    await invokeErrorHook(config, isChair, result);

    if (!isRetryable(result.errorCode, result.retryAfterMs)) {
      return finalizeResult(result, startedAt, totalCost, hasCost, mergedUsage);
    }
  }

  return finalizeResult(
    lastResult ?? {
      agent: agentName,
      text: '',
      success: false,
      errorCode: 'EXIT_ERROR',
      errorMessage: 'Все попытки исчерпаны'
    },
    startedAt,
    totalCost,
    hasCost,
    mergedUsage
  );
}

/**
 * Параллельно вызывает экспертов с ограничением конкурентности
 */
export async function callExpertsParallel(
  experts: ExpertConfig[],
  task: string,
  config: ConsiliumConfig,
  options: { controller?: RunController } = {}
): Promise<AgentResult[]> {
  const enabled = experts.filter(expert => expert.enabled !== false);
  const results: AgentResult[] = new Array<AgentResult>(enabled.length);
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    positiveInteger(config.retry?.maxConcurrency) ?? DEFAULT_MAX_CONCURRENCY
  );
  const controller = options.controller;

  const runExpert = async (expert: ExpertConfig): Promise<AgentResult> => {
    try {
      const prompt = buildExpertPrompt(expert, task);

      await invokeHook(
        config,
        () => config.hooks?.onExpertStart?.(expert.name, task),
        'onExpertStart'
      );

      const result = await callAgent(expert.name, prompt, config, {
        timeout: expert.timeout,
        retries: expert.retries,
        isChair: false,
        model: expert.model,
        controller
      });

      await invokeHook(
        config,
        () => config.hooks?.onExpertEnd?.(result),
        'onExpertEnd'
      );

      return result;
    } catch (error) {
      const result: AgentResult = {
        agent: expert.name,
        text: '',
        success: false,
        errorCode: 'SPAWN_ERROR',
        errorMessage: errorToMessage(error)
      };

      await invokeHook(
        config,
        () => config.hooks?.onExpertError?.(result),
        'onExpertError'
      );

      return result;
    }
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= enabled.length) return;
      results[index] = await runExpert(enabled[index]);
    }
  };

  const workerCount = Math.min(concurrency, enabled.length);
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

/**
 * Вызывает председателя по результатам экспертов
 */
export async function callChair(
  expertResults: AgentResult[],
  task: string,
  config: ConsiliumConfig,
  options: { controller?: RunController } = {}
): Promise<AgentResult> {
  const successful = expertResults.filter(result => result.success);

  if (successful.length === 0) {
    throw new Error(
      'Ни один эксперт не дал ответа — председатель не может синтезировать результат'
    );
  }

  const maxExpertTextLength =
    positiveInteger(config.chair?.maxExpertTextLength) ?? DEFAULT_MAX_EXPERT_TEXT;

  let prompt: string;
  const template = config.chair?.promptTemplate;
  if (template) {
    prompt = template(task, expertResults);
  } else {
    prompt = buildChairPrompt(
      task,
      expertResults,
      maxExpertTextLength,
      config.consensus === true
    );
  }

  await invokeHook(
    config,
    () => config.hooks?.onChairStart?.(task, expertResults),
    'onChairStart'
  );

  const result = await callAgent(config.chair.agent, prompt, config, {
    timeout: config.chair?.timeout,
    retries: config.retry?.chairRetries,
    isChair: true,
    model: config.chair?.model,
    controller: options.controller
  });

  await invokeHook(config, () => config.hooks?.onChairEnd?.(result), 'onChairEnd');

  return result;
}

/**
 * Проверяет доступность OpenCode CLI (таймаут 10 с)
 */
export async function checkOpenCodeAvailable(
  config?: Pick<ConsiliumConfig, 'opencodePath' | 'cwd'>
): Promise<boolean> {
  const outcome = await executeOpenCode({
    opencodePath: resolveOpenCodePath(config),
    args: ['--version'],
    cwd: resolveCwd(config),
    timeoutMs: AVAILABILITY_TIMEOUT
  });

  return outcome.spawnError === undefined && !outcome.timedOut && outcome.code === 0;
}

/**
 * Возвращает версию OpenCode CLI или null
 */
export async function getOpenCodeVersion(
  config?: Pick<ConsiliumConfig, 'opencodePath' | 'cwd'>
): Promise<string | null> {
  const outcome = await executeOpenCode({
    opencodePath: resolveOpenCodePath(config),
    args: ['--version'],
    cwd: resolveCwd(config),
    timeoutMs: AVAILABILITY_TIMEOUT
  });

  if (outcome.spawnError !== undefined || outcome.timedOut || outcome.code !== 0) {
    return null;
  }

  const version = outcome.stdout.trim() || outcome.stderr.trim();
  return version.length > 0 ? version : null;
}

/**
 * Получает список доступных агентов из конфигурации (обратная совместимость)
 */
export async function getAvailableAgents(): Promise<string[]> {
  const { loadConfig } = await import('./config.js');
  const { config } = loadConfig();
  return config.experts.map(expert => expert.name);
}
