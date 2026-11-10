/**
 * @fileoverview Изолированные git worktree для агентов: создание, безопасная
 * уборка и консервативная очистка «осиротевших» каталогов.
 *
 * Worktree создаётся детач-коммитом от `git stash create` (HEAD + отслеживаемые
 * незакоммиченные изменения) или от HEAD. Untracked-файлы не копируются — это
 * осознанное ограничение изоляции. Каталог живёт в `.consilium/worktrees` и
 * удаляется через `git worktree remove --force` + `git worktree prune`.
 *
 * @module lv24-opencode-consilium
 */

import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from 'fs';
import { basename, join, resolve } from 'path';

/** Каталог изолированных worktree относительно корня репозитория */
export const ISOLATE_WORKTREES_RELATIVE_PATH = '.consilium/worktrees';

/** Стабильный код: `.opencode/opencode.jsonc` несовместим с isolate+read-only */
export const ISOLATION_JSONC_UNSUPPORTED = 'ISOLATION_JSONC_UNSUPPORTED';

/** Коды ошибок конфигурации изоляции */
export type IsolationConfigErrorCode = typeof ISOLATION_JSONC_UNSUPPORTED;

/**
 * Ошибка конфигурации изоляции: запуск невозможен без правки проекта или флагов.
 * CLI отображает её как ошибку использования (код 2), library/MCP/plugin
 * получают типизированную ошибку со стабильным `code`.
 */
export class IsolationConfigError extends Error {
  /** Стабильный машинно-читаемый код */
  readonly code: IsolationConfigErrorCode;
  /** Путь, из-за которого запуск отклонён */
  readonly path?: string;

  constructor(code: IsolationConfigErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'IsolationConfigError';
    this.code = code;
    this.path = path;
  }
}

/** Сужает неизвестное значение до IsolationConfigError */
export function isIsolationConfigError(error: unknown): error is IsolationConfigError {
  return error instanceof IsolationConfigError;
}

/** Через сколько считать каталог worktree устаревшим (1 час) */
const DEFAULT_STALE_WORKTREE_MS = 60 * 60 * 1000;

/** Таймаут одной git-команды, мс */
const GIT_TIMEOUT_MS = 30_000;

/** Максимальная длина безопасной части имени каталога */
const MAX_LABEL_LENGTH = 40;

/** Причина lock-файла worktree: `consilium:<pid>:<startedAtMs>` */
const OWNER_REASON_PATTERN = /^consilium:(\d+):(\d+)$/;

/** Уровень диагностики */
type LogLevel = 'info' | 'warn';

export interface IsolatedWorktree {
  /** Абсолютный путь к рабочему каталогу worktree */
  readonly path: string;
  /** Корень основного репозитория */
  readonly root: string;
  /** Коммит, от которого создан worktree */
  readonly base: string;
  /** Удаляет worktree и administrative-записи; идемпотентно, не бросает */
  remove(): void;
}

export interface CreateIsolatedWorktreeOptions {
  /** Рабочая директория проекта (как у дочернего opencode) */
  cwd: string;
  /** Имя агента или роли для читаемого имени каталога */
  label?: string;
  /** Диагностика создания и уборки */
  onLog?: (level: LogLevel, message: string) => void;
}

export interface CleanupStaleWorktreesOptions {
  /** Корень репозитория (не рабочий каталог проекта) */
  root: string;
  /** Возраст, после которого каталог считается устаревшим, мс */
  staleAfterMs?: number;
  /** Текущее время для детерминированных тестов */
  now?: number;
  onLog?: (level: LogLevel, message: string) => void;
}

interface RegisteredWorktree {
  path: string;
  lockedReason?: string;
}

/**
 * Возвращает корень git-репозитория для рабочего каталога проекта.
 *
 * @throws если каталог не является git-репозиторием или git недоступен:
 * изоляция без git невозможна, запуск должен упасть до вызова моделей.
 */
export function resolveIsolateRoot(cwd: string): string {
  const directory = resolve(cwd);
  if (!existsSync(directory)) {
    throw new Error(
      `--isolate требует существующий рабочий каталог: "${directory}" не найден.`
    );
  }
  let top: string;
  try {
    top = runGit(['rev-parse', '--show-toplevel'], directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        '--isolate требует git: команда git не найдена в PATH. ' +
          'Установите git или запустите без --isolate.'
      );
    }
    throw new Error(
      `--isolate требует git-репозиторий: "${directory}" не является рабочим ` +
        'каталогом git. Запустите без --isolate или выполните git init.'
    );
  }
  if (top.length === 0) {
    throw new Error(
      `--isolate требует git-репозиторий: git не вернул корень для "${directory}".`
    );
  }
  return resolve(top);
}

export interface IsolatedReadOnlyPreflightOptions {
  /** Рабочая директория проекта (как у дочернего opencode) */
  cwd: string;
  /** Включён ли read-only (--read-only) */
  readOnly: boolean;
  /** Включена ли изоляция worktree (--isolate) */
  isolate: boolean;
}

/**
 * Проверяет, что `--isolate --read-only` не столкнётся с
 * `.opencode/opencode.jsonc` в корне репозитория.
 *
 * В изолированном worktree read-only слой пишется в `.opencode/opencode.json`.
 * Если в корне лежит `opencode.jsonc`, OpenCode предпочитает его, временный
 * слой не действует, и каждый агент падал бы с SPAWN_ERROR. Проверка выполняется
 * один раз до создания worktree, хуков и вызова моделей.
 *
 * Untracked-файлы не копируются в worktree, но проверка намеренно fail closed:
 * `.jsonc` может стать отслеживаемым между проверкой и запуском, а молча
 * ослаблять read-only нельзя. Файлы вне корня репозитория не проверяются.
 *
 * @throws IsolationConfigError (ISOLATION_JSONC_UNSUPPORTED) если файл найден
 * @throws Error если каталог не git-репозиторий (как у `resolveIsolateRoot`)
 */
export function assertIsolatedReadOnlyPreflight(
  options: IsolatedReadOnlyPreflightOptions
): void {
  if (options.readOnly !== true || options.isolate !== true) {
    return;
  }

  const root = resolveIsolateRoot(options.cwd);
  const jsoncPath = resolve(root, '.opencode/opencode.jsonc');
  if (!existsSync(jsoncPath)) {
    return;
  }

  throw new IsolationConfigError(
    ISOLATION_JSONC_UNSUPPORTED,
    `--isolate с --read-only не поддерживает .opencode/opencode.jsonc: "${jsoncPath}". ` +
      'Файл попадает в каждый worktree и перекрывает временный read-only слой, ' +
      'поэтому агенты завершались бы с SPAWN_ERROR. ' +
      'Переименуйте .opencode/opencode.jsonc в .opencode/opencode.json ' +
      'или запустите без --read-only (например, с --allow-write).',
    jsoncPath
  );
}

/**
 * Создаёт одноразовый detached worktree для вызова агента.
 *
 * @throws если git недоступен, каталог не репозиторий или в репозитории нет
 * коммитов.
 */
export function createIsolatedWorktree(
  options: CreateIsolatedWorktreeOptions
): IsolatedWorktree {
  const root = resolveIsolateRoot(options.cwd);
  cleanupStaleWorktrees({ root, onLog: options.onLog });

  const base = resolveBaseCommit(root);
  const worktreesDir = resolve(root, ISOLATE_WORKTREES_RELATIVE_PATH);
  mkdirSync(worktreesDir, { recursive: true });

  const path = resolve(
    worktreesDir,
    `${safeLabel(options.label ?? 'agent')}-${randomBytes(6).toString('hex')}`
  );
  try {
    runGit(['worktree', 'add', '--detach', path, base], root);
  } catch (error) {
    throw new Error(`Не удалось создать изолированный worktree: ${gitErrorMessage(error)}`);
  }

  // Lock помечает worktree как принадлежащий этому процессу. Он не мешает
  // удалению (снимаем перед remove), но позволяет следующему запуску отличить
  // живой worktree от осиротевшего после падения процесса.
  try {
    runGit(
      ['worktree', 'lock', '--reason', `consilium:${process.pid}:${Date.now()}`, path],
      root
    );
  } catch (error) {
    options.onLog?.(
      'warn',
      `Не удалось заблокировать изолированный worktree: ${gitErrorMessage(error)}`
    );
  }

  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    try {
      if (existsSync(path)) {
        try {
          runGitQuiet(['worktree', 'unlock', path], root);
          runGit(['worktree', 'remove', '--force', path], root);
        } catch (error) {
          // Каталог мог быть уже удалён или занят дочерним процессом:
          // добиваем обычным удалением, а prune снимет administrative-запись.
          try {
            rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          } catch {
            options.onLog?.(
              'warn',
              `Не удалось удалить изолированный worktree ${path}: ${gitErrorMessage(error)}`
            );
          }
        }
      }
    } finally {
      try {
        runGit(['worktree', 'prune'], root);
      } catch (error) {
        options.onLog?.(
          'warn',
          `git worktree prune не удался: ${gitErrorMessage(error)}`
        );
      }
    }
  };

  return { path, root, base, remove };
}

/**
 * Удаляет заведомо устаревшие каталоги из `.consilium/worktrees`.
 * Консервативно: живой worktree (lock с живым pid) не трогается никогда;
 * зарегистрированный worktree удаляется только при мёртвом владельце и
 * возрасте больше порога; незарегистрированный каталог — только по возрасту.
 * Возвращает список удалённых путей.
 */
export function cleanupStaleWorktrees(options: CleanupStaleWorktreesOptions): string[] {
  const root = resolve(options.root);
  const worktreesDir = resolve(root, ISOLATE_WORKTREES_RELATIVE_PATH);
  if (!existsSync(worktreesDir)) {
    return [];
  }

  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_WORKTREE_MS;
  const now = options.now ?? Date.now();
  const registered = new Map<string, RegisteredWorktree>();
  const registeredByName = new Map<string, RegisteredWorktree>();
  for (const entry of listRegisteredWorktrees(root)) {
    registered.set(comparablePath(entry.path), entry);
    registeredByName.set(basename(comparablePath(entry.path)), entry);
  }

  const removed: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = resolve(worktreesDir, entry.name);
    let age: number;
    try {
      age = now - statSync(candidate).mtimeMs;
    } catch {
      continue;
    }
    if (age < staleAfterMs) continue;

    const registration =
      registered.get(comparablePath(candidate)) ??
      registeredByName.get(basename(comparablePath(candidate)));
    if (registration === undefined) {
      // A live worktree can look unregistered when git reports a canonical
      // path (macOS /private/var, Windows long/8.3 aliases). Never delete a
      // directory that still contains a worktree .git marker; only true
      // crumb directories are age-collected.
      if (existsSync(join(candidate, '.git'))) continue;
      if (removeDirectory(candidate)) removed.push(candidate);
      continue;
    }

    const owner =
      registration.lockedReason === undefined
        ? null
        : OWNER_REASON_PATTERN.exec(registration.lockedReason);
    if (owner === null) continue;
    const ownerPid = Number(owner[1]);
    if (isProcessAlive(ownerPid)) continue;
    if (removeRegisteredWorktree(root, candidate)) removed.push(candidate);
  }

  try {
    runGit(['worktree', 'prune'], root);
  } catch {
    // Prune не критичен для текущего запуска.
  }

  if (removed.length > 0) {
    options.onLog?.(
      'warn',
      `Удалены устаревшие изолированные worktree (${removed.length}): ` +
        removed.map(item => item.replace(/\\/g, '/')).join(', ')
    );
  }
  return removed;
}

/** Коммит-основа: незакоммиченные отслеживаемые изменения или HEAD */
function resolveBaseCommit(root: string): string {
  const stash = runGitQuiet(['stash', 'create'], root);
  if (stash !== undefined && /^[0-9a-f]{7,40}$/i.test(stash)) {
    return stash;
  }
  const head = runGitQuiet(['rev-parse', 'HEAD'], root);
  if (head === undefined || head.length === 0) {
    throw new Error(
      '--isolate требует git-репозиторий хотя бы с одним коммитом: ' +
        'создайте первый коммит или запустите без --isolate.'
    );
  }
  return head;
}

/** Список worktree глазами git (включая причины lock) */
function listRegisteredWorktrees(root: string): RegisteredWorktree[] {
  const output = runGitQuiet(['worktree', 'list', '--porcelain'], root);
  if (output === undefined) return [];

  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current !== undefined) entries.push(current);
      current = { path: resolve(line.slice('worktree '.length).trim()) };
      continue;
    }
    if (current !== undefined && line.startsWith('locked')) {
      const reason = line.slice('locked'.length).trim();
      if (reason.length > 0) current.lockedReason = reason;
    }
  }
  if (current !== undefined) entries.push(current);
  return entries;
}

function removeRegisteredWorktree(root: string, path: string): boolean {
  try {
    runGitQuiet(['worktree', 'unlock', path], root);
    runGit(['worktree', 'remove', '--force', path], root);
    return true;
  } catch {
    return removeDirectory(path);
  }
}

function removeDirectory(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return !existsSync(path);
  } catch {
    return false;
  }
}

/** Имя каталога без спецсимволов и с разумной длиной */
function safeLabel(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_LABEL_LENGTH);
  return cleaned.length > 0 ? cleaned : 'agent';
}

/** Путь для сравнения: абсолютный, с прямыми слэшами, без регистра на Windows */
function comparablePath(value: string): string {
  let normalized = resolve(value);
  try {
    // git may report canonical paths (/private/var on macOS, long paths on
    // Windows) while our candidate uses a symlinked/8.3 alias. Resolve both
    // before comparing so a live worktree is never treated as unregistered.
    normalized = realpathSync(normalized);
  } catch {
    // Path may already be removed; the resolved form is the best fallback.
  }
  normalized = normalized.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM означает, что процесс существует, но принадлежит другому пользователю.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    // stderr перехватываем: служебные сообщения git не должны попадать в
    // stdout/stderr пользователя, а текст ошибки доступен через error.stderr.
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function runGitQuiet(args: string[], cwd: string): string | undefined {
  try {
    return runGit(args, cwd);
  } catch {
    return undefined;
  }
}

function gitErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim().length > 0) {
    return stderr.trim();
  }
  if (Buffer.isBuffer(stderr) && stderr.length > 0) {
    return stderr.toString('utf8').trim();
  }
  return error instanceof Error ? error.message : String(error);
}
