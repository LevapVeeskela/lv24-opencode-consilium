/**
 * @fileoverview Принудительный read-only режим OpenCode: временный слой
 * `.opencode/opencode.json` с deny-правилами и его безопасное восстановление.
 *
 * OpenCode читает проектный слой `.opencode/opencode.json` позже прямого
 * `opencode.json`, поэтому временный слой перекрывает разрешения агентов.
 * Слой содержит нативный V2 `agents.<name>.permissions` (упорядоченный массив,
 * побеждает последнее совпадение) и V1-совместимый `agent.<name>.tools`.
 *
 * @module lv24-opencode-consilium
 */

import { createHash } from 'crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'fs';
import { dirname, join, resolve } from 'path';
import { isRecord, recordOf, type JsonRecord } from '../../shared/record.js';
import { stripJsonComments } from '../config/jsonc.js';

/** Правило разрешений OpenCode V2 */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny';
}

/**
 * Разрешены только read/glob/grep; всё остальное (shell, edit, patch,
 * subagent, webfetch, websearch, skill, question, MCP-инструменты) запрещено
 * широким первым правилом. `.env` остаётся закрытым, `.env.example` — открыт.
 */
export const READ_ONLY_PERMISSIONS: readonly PermissionRule[] = Object.freeze([
  { action: '*', resource: '*', effect: 'deny' as const },
  { action: 'read', resource: '*', effect: 'allow' as const },
  { action: 'glob', resource: '*', effect: 'allow' as const },
  { action: 'grep', resource: '*', effect: 'allow' as const },
  { action: 'read', resource: '*.env', effect: 'deny' as const },
  { action: 'read', resource: '*.env.*', effect: 'deny' as const },
  { action: 'read', resource: '*.env.example', effect: 'allow' as const }
]);

/** V1-фолбэк: инструменты, которые обязаны быть выключены */
const READ_ONLY_V1_TOOLS: Readonly<Record<string, false>> = Object.freeze({
  write: false,
  edit: false,
  patch: false,
  bash: false,
  webfetch: false,
  task: false
});

/**
 * Встроенные primary-агенты OpenCode. Consilium передаёт `--agent` явно, но
 * при AGENT_NOT_FOUND OpenCode повторяет запуск default-агентом; эти записи
 * не дают read-only прогону потерять ограничения на таком фолбэке.
 */
const BUILTIN_DEFAULT_AGENTS = ['build', 'plan', 'general', 'explore'];

/** Копия правил read-only (без общего изменяемого массива) */
export function buildReadOnlyPermissions(): PermissionRule[] {
  return READ_ONLY_PERMISSIONS.map(rule => ({ ...rule }));
}

/**
 * Возвращает объект слоя с read-only правилами для указанных агентов.
 * Существующие permissions заменяются целиком: ослаблять чужие правила нельзя.
 *
 * @throws если `agent`/`agents` в исходном слое не объект — fail closed.
 */
export function buildReadOnlyOverlayConfig(
  base: JsonRecord | undefined,
  agentNames: string[]
): JsonRecord {
  const overlay: JsonRecord = base === undefined ? {} : { ...base };
  const agents = cloneRecordField(overlay, 'agents');
  const agent = cloneRecordField(overlay, 'agent');

  const names = new Set([
    ...BUILTIN_DEFAULT_AGENTS,
    ...agentNames,
    ...Object.keys(agents),
    ...Object.keys(agent)
  ]);
  for (const name of names) {
    const v2Entry = recordOf(agents[name]);
    agents[name] = { ...v2Entry, permissions: buildReadOnlyPermissions() };

    const v1Entry = recordOf(agent[name]);
    agent[name] = {
      ...v1Entry,
      tools: { ...recordOf(v1Entry.tools), ...READ_ONLY_V1_TOOLS }
    };
  }

  overlay.agents = agents;
  overlay.agent = agent;
  return overlay;
}

function cloneRecordField(parent: JsonRecord, key: string): JsonRecord {
  const value = parent[key];
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(
      `Не удалось включить read-only: поле "${key}" в .opencode/opencode.json ` +
        'должно быть объектом.'
    );
  }
  return { ...value };
}

/** Состояние lock-файла; переживает падение процесса для восстановления */
interface ReadOnlyLockState {
  version: 1;
  pid: number;
  startedAt: string;
  target: string;
  backupPath: string;
  hadOriginal: boolean;
  writtenHash?: string;
}

export interface ReadOnlyOverlayOptions {
  /** Рабочая директория проекта (та же, что у дочернего opencode) */
  cwd: string;
  /** Выбранные эксперты и председатель */
  agents: string[];
  /** Сколько ждать освобождения lock другого запуска, мс */
  lockTimeoutMs?: number;
  /** Диагностика: восстанавливали ли слой после падения прошлого запуска */
  onLog?: (level: 'warn' | 'info', message: string) => void;
}

export interface ReadOnlyOverlay {
  /** Абсолютный путь к временному слою */
  readonly path: string;
  /** Восстанавливает исходные байты и снимает lock; идемпотентно */
  restore(): void;
}

/** Каталог служебных файлов Consilium */
const CONFIG_DIR = '.consilium';
/** Относительный путь временного слоя (posix-разделители для ignore) */
export const READ_ONLY_OVERLAY_RELATIVE_PATH = '.opencode/opencode.json';
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_WAIT_SLICE_MS = 100;

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readLockState(lockPath: string): ReadOnlyLockState | null {
  try {
    if (!existsSync(lockPath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!isRecord(parsed)) return null;
    const pid = parsed.pid;
    const target = parsed.target;
    const backupPath = parsed.backupPath;
    if (typeof pid !== 'number' || typeof target !== 'string' || typeof backupPath !== 'string') {
      return null;
    }
    return {
      version: 1,
      pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      target,
      backupPath,
      hadOriginal: parsed.hadOriginal === true,
      writtenHash: typeof parsed.writtenHash === 'string' ? parsed.writtenHash : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Восстанавливает состояние после падения процесса, оставившего lock.
 * Без валидного lock действует по путям по умолчанию.
 */
function recoverStaleState(
  cwd: string,
  lockPath: string,
  state: ReadOnlyLockState | null,
  onLog: ReadOnlyOverlayOptions['onLog']
): void {
  // Пути из lock не доверяем слепо: восстанавливаем только ожидаемый слой.
  const expectedTarget = resolve(cwd, READ_ONLY_OVERLAY_RELATIVE_PATH);
  const expectedBackup = resolve(cwd, CONFIG_DIR, 'read-only.backup');
  const target = state?.target === expectedTarget ? state.target : expectedTarget;
  const backupPath =
    state?.backupPath === expectedBackup ? state.backupPath : expectedBackup;

  let restored = false;
  if (state?.hadOriginal === true && existsSync(backupPath)) {
    writeFileSync(target, readFileSync(backupPath));
    onLog?.('warn', 'Восстановлен .opencode/opencode.json после прерванного read-only запуска.');
    restored = true;
  }
  if (!restored && state?.writtenHash !== undefined && existsSync(target)) {
    const current = readFileSync(target);
    if (sha256(current) === state.writtenHash) {
      unlinkSync(target);
      onLog?.('warn', 'Удалён временный read-only слой после прерванного запуска.');
    }
  }

  rmSync(backupPath, { force: true });
  rmSync(lockPath, { force: true });
}

async function acquireLock(
  cwd: string,
  lockPath: string,
  timeoutMs: number,
  onLog: ReadOnlyOverlayOptions['onLog']
): Promise<ReadOnlyLockState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      const state: ReadOnlyLockState = {
        version: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        target: resolve(cwd, READ_ONLY_OVERLAY_RELATIVE_PATH),
        backupPath: resolve(cwd, CONFIG_DIR, 'read-only.backup'),
        hadOriginal: false
      };
      try {
        writeSync(fd, JSON.stringify(state));
      } finally {
        closeSync(fd);
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const state = readLockState(lockPath);
      if (state !== null && isProcessAlive(state.pid)) {
        if (Date.now() >= deadline) {
          throw new Error(
            'Не удалось включить read-only: другой запуск consilium удерживает ' +
              `.consilium/read-only.lock (pid ${state.pid}). ` +
              'Дождитесь его завершения или удалите lock после проверки.'
          );
        }
        await sleep(LOCK_WAIT_SLICE_MS);
        continue;
      }
      // Частично записанный свежий lock может принадлежать живому процессу:
      // не отбираем его сразу, даём владельцу дописать JSON.
      if (state === null) {
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age < 2000 && Date.now() < deadline) {
            await sleep(LOCK_WAIT_SLICE_MS);
            continue;
          }
        } catch {
          // Lock уже удалён — пробуем создать заново.
        }
      }
      // Мёртвый/битый lock: сначала возвращаем проект в исходное состояние.
      recoverStaleState(cwd, lockPath, state, onLog);
    }
  }
}

function writeLockState(lockPath: string, state: ReadOnlyLockState): void {
  writeFileSync(lockPath, JSON.stringify(state), 'utf8');
}

/**
 * Включает read-only: пишет временный `.opencode/opencode.json` с deny-правилами
 * и возвращает управление для восстановления исходных байтов.
 *
 * @throws при ошибке разбора существующего `.opencode/opencode.json` —
 * fail closed: запуск без принудительного read-only недопустим.
 */
export async function applyReadOnlyOverlay(
  options: ReadOnlyOverlayOptions
): Promise<ReadOnlyOverlay> {
  const cwd = resolve(options.cwd);
  const configDir = resolve(cwd, CONFIG_DIR);
  const lockPath = resolve(configDir, 'read-only.lock');
  const target = resolve(cwd, READ_ONLY_OVERLAY_RELATIVE_PATH);

  const jsoncTarget = resolve(cwd, '.opencode/opencode.jsonc');
  if (existsSync(jsoncTarget)) {
    throw new Error(
      'Не удалось включить read-only: .opencode/opencode.jsonc не поддерживается, ' +
        'потому что временный слой пишется в .opencode/opencode.json. ' +
        'Переименуйте файл в .opencode/opencode.json или запустите без --read-only.'
    );
  }
  for (const [candidate, label] of [
    [configDir, '.consilium'],
    [dirname(target), '.opencode'],
    [target, READ_ONLY_OVERLAY_RELATIVE_PATH]
  ] as const) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new Error(
          `Не удалось включить read-only: ${label} — символическая ссылка, ` +
            'запись через неё может выйти за пределы проекта.'
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  mkdirSync(configDir, { recursive: true });
  mkdirSync(dirname(target), { recursive: true });

  const state = await acquireLock(
    cwd,
    lockPath,
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    options.onLog
  );

  let originalBytes: Buffer | undefined;
  let restored = false;

  const restore = (): void => {
    if (restored) return;
    try {
      if (originalBytes !== undefined) {
        writeFileSync(target, originalBytes);
      } else if (existsSync(target)) {
        unlinkSync(target);
      }
    } catch (error) {
      // Не удаляем backup/lock: следующий запуск восстановит слой по stale lock.
      options.onLog?.(
        'warn',
        `Не удалось восстановить ${READ_ONLY_OVERLAY_RELATIVE_PATH}: ` +
          `${(error as Error).message}. Бэкап оставлен в .consilium/read-only.backup.`
      );
      return;
    }
    restored = true;
    process.removeListener('exit', onExit);
    rmSync(state.backupPath, { force: true });
    rmSync(lockPath, { force: true });
  };

  // Последний рубеж: process.exit()/SIGINT-обработчик CLI завершает процесс,
  // не дожидаясь finally. Восстанавливаем синхронно на событии exit.
  const onExit = (): void => {
    try {
      restore();
    } catch {
      // На выходе уже нельзя сообщить об ошибке; lock останется для stale-recovery.
    }
  };

  try {
    if (existsSync(target)) {
      const stats = statSync(target);
      if (stats.isDirectory()) {
        throw new Error(`Не удалось включить read-only: ${target} — каталог, а не файл.`);
      }
      originalBytes = readFileSync(target);
      writeFileSync(state.backupPath, originalBytes);
    }
    state.hadOriginal = originalBytes !== undefined;
    writeLockState(lockPath, state);

    let parsedBase: JsonRecord | undefined;
    if (originalBytes !== undefined) {
      try {
        const text = originalBytes.toString('utf8').replace(/^\uFEFF/, '');
        const parsed: unknown = JSON.parse(stripJsonComments(text));
        if (!isRecord(parsed)) {
          throw new Error('ожидается JSON-объект');
        }
        parsedBase = parsed;
      } catch (error) {
        throw new Error(
          `Не удалось включить read-only: ${target} не удалось разобрать как JSON/JSONC ` +
            `(${(error as Error).message}). Исправьте файл или запустите без --read-only.`
        );
      }
    }

    const overlay = buildReadOnlyOverlayConfig(parsedBase, options.agents);
    const content = `${JSON.stringify(overlay, null, 2)}\n`;
    const contentBuffer = Buffer.from(content, 'utf8');
    const temporary = join(dirname(target), `.opencode.json.${process.pid}.tmp`);

    // Хэш записываем до переименования: если процесс умрёт после него,
    // stale-recovery сможет отличить наш слой от пользовательского файла.
    state.writtenHash = sha256(contentBuffer);
    writeLockState(lockPath, state);

    writeFileSync(temporary, contentBuffer);
    try {
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }

    process.once('exit', onExit);
    options.onLog?.(
      'info',
      `Read-only: запрещены write/shell/edit для ${options.agents.join(', ')}.`
    );

    return { path: target, restore };
  } catch (error) {
    restore();
    throw error;
  }
}
