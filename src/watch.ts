/**
 * @fileoverview Watch mode (debounced fs.watch) and git pre-commit hook helpers.
 * @module lv24-opencode-consilium
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Опции createProjectWatcher */
export interface WatchOptions {
  cwd?: string;
  debounceMs?: number;
  ignore?: string[];
  onTrigger: (paths: string[]) => void | Promise<void>;
}

/** Debounce вотчера по умолчанию, мс */
const DEFAULT_DEBOUNCE_MS = 400;

/** Игнорируемые пути/глобы по умолчанию (всегда применяются вместе с пользовательскими) */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  '.consilium',
  'coverage',
  '*.tmp',
  '*.log',
  '.DS_Store'
];

/** Маркер начала блока consilium в hook-файле */
const HOOK_BLOCK_START = '# >>> consilium >>>';

/** Маркер конца блока consilium в hook-файле */
const HOOK_BLOCK_END = '# <<< consilium <<<';

/** Все блоки consilium (upsert заменяет их одним, remove удаляет все) */
const HOOK_BLOCK_RE_ALL = /# >>> consilium >>>[\s\S]*?# <<< consilium <<</g;

/** Нормализует путь: `\` -> `/` */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Преобразует простой `*`-глоб в RegExp, экранируя остальное */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * Проверяет, попадает ли путь под ignore-паттерны.
 * Плоские имена (`.git`, `dist`) матчатся как полный сегмент пути —
 * поэтому работают и для абсолютных путей внутри игнорируемых директорий.
 * Паттерны со `*` (`*.tmp`) матчатся против всего пути и basename.
 * Паттерны со `/` матчатся как префикс/подпуть.
 */
export function shouldIgnore(relativePath: string, ignore?: string[]): boolean {
  const patterns = [...DEFAULT_IGNORE_PATTERNS, ...(ignore ?? [])];
  const normalized = normalizeSlashes(relativePath)
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (normalized.length === 0 || normalized === '.') {
    return false;
  }
  const segments = normalized.split('/').filter(s => s.length > 0 && s !== '.');
  if (segments.length === 0) {
    return false;
  }
  const basename = segments[segments.length - 1];

  for (const raw of patterns) {
    const pattern = normalizeSlashes(raw).replace(/\/+$/, '');
    if (pattern.length === 0 || pattern === '.') {
      continue;
    }
    if (pattern.includes('*')) {
      const re = globToRegExp(pattern);
      if (re.test(normalized) || re.test(basename)) {
        return true;
      }
      continue;
    }
    if (pattern.includes('/')) {
      const clean = pattern.replace(/^\.\//, '');
      if (
        normalized === clean ||
        normalized.startsWith(`${clean}/`) ||
        normalized.endsWith(`/${clean}`) ||
        normalized.includes(`/${clean}/`)
      ) {
        return true;
      }
      continue;
    }
    if (segments.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Создаёт дебаунсер: собирает пути в Set, сбрасывает таймер на каждый push,
 * вызывает fn один раз с отсортированным массивом. flush срабатывает сразу,
 * cancel всё сбрасывает; повторный вызов без новых данных ничего не делает.
 */
export function createDebouncer(
  ms: number,
  fn: (paths: string[]) => void
): {
  push(path: string): void;
  cancel(): void;
  flush(): void;
} {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fire = (): void => {
    timer = undefined;
    if (pending.size === 0) {
      return;
    }
    const paths = [...pending].sort();
    pending.clear();
    fn(paths);
  };

  return {
    push(filePath: string): void {
      pending.add(filePath);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(fire, ms);
    },
    cancel(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending.clear();
    },
    flush(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      fire();
    }
  };
}

/**
 * Создаёт вотчер проекта: `fs.watch(cwd, { recursive: true })`,
 * при исключении — обычный (нерекурсивный) watch cwd.
 * Игнорируемые пути отфильтровываются, срабатывания дебаунсятся
 * (400 мс по умолчанию). Ошибки onTrigger логируются в console.error
 * и никогда не роняют процесс. Возвращает `{ close }`.
 */
export function createProjectWatcher(options: WatchOptions): { close(): void } {
  const cwd = options.cwd ?? process.cwd();
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const ignore = [...DEFAULT_IGNORE_PATTERNS, ...(options.ignore ?? [])];
  let stopped = false;

  const debouncer = createDebouncer(debounceMs, (paths: string[]) => {
    if (stopped) {
      return;
    }
    try {
      const result = options.onTrigger(paths);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          console.error(error);
        });
      }
    } catch (error) {
      console.error(error);
    }
  });

  const onFilename = (filename: string | Buffer | null): void => {
    if (stopped || filename === null) {
      return;
    }
    const name = typeof filename === 'string' ? filename : filename.toString('utf8');
    if (name.length === 0) {
      return;
    }
    const normalized = normalizeSlashes(name);
    if (shouldIgnore(normalized, ignore)) {
      return;
    }
    debouncer.push(normalized);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(cwd, { recursive: true }, (_event, filename) => onFilename(filename));
  } catch {
    watcher = watch(cwd, (_event, filename) => onFilename(filename));
  }
  watcher.on('error', (error: unknown) => {
    if (!stopped) {
      console.error(error);
    }
  });

  return {
    close(): void {
      stopped = true;
      debouncer.cancel();
      watcher.close();
    }
  };
}

/** Возвращает полный текст standalone pre-commit hook для команды */
export function buildPreCommitHook(command: string): string {
  return `#!/bin/sh\nset -e\n${command}\n`;
}

/** Допустимые интерпретаторы для существующего pre-commit hook */
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);

/**
 * Возвращает каталог hooks с учётом `.git`-файла (worktree/submodule) и
 * настройки `core.hooksPath`. Бросает понятную ошибку, если репозитория нет.
 */
export function resolveHooksDir(cwd: string): string {
  // git сам знает про worktrees, submodules, core.hooksPath и подкаталоги.
  try {
    const resolved = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true
    }).trim();
    if (resolved.length > 0) {
      return path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved);
    }
  } catch {
    // git недоступен или каталог не является репозиторием — пробуем вручную
  }

  const gitPath = path.join(cwd, '.git');
  if (!existsSync(gitPath)) {
    throw new Error(
      `Cannot install pre-commit hook: no .git directory in "${cwd}" (run "git init" first).`
    );
  }

  let gitDir = gitPath;
  if (statSync(gitPath).isFile()) {
    const content = readFileSync(gitPath, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (!match || match[1] === undefined) {
      throw new Error(`Не удалось разобрать .git-файл в "${cwd}"`);
    }
    gitDir = path.resolve(cwd, match[1].trim());
  }

  return path.join(gitDir, 'hooks');
}

/**
 * Вставляет/обновляет блок consilium в существующем hook-файле.
 * Все существующие блоки заменяются одним (дублей нет).
 * Блок вставляется перед первым `exit`/`exec`, чтобы не оказаться мёртвым.
 */
export function upsertHookBlock(existing: string, command: string): string {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const block = `${HOOK_BLOCK_START}${eol}${command}${eol}${HOOK_BLOCK_END}`;

  const firstStart = existing.indexOf(HOOK_BLOCK_START);
  const lastEnd = existing.lastIndexOf(HOOK_BLOCK_END);
  if (firstStart !== -1 && lastEnd > firstStart) {
    // Схлопываем все блоки (включая мусор между ними) в один.
    return (
      existing.slice(0, firstStart) +
      block +
      existing.slice(lastEnd + HOOK_BLOCK_END.length)
    );
  }

  if (existing.trim().length === 0) {
    return `#!/bin/sh${eol}set -e${eol}${block}${eol}`;
  }

  const exitMatch = /^[ \t]*(?:exit|exec)\b.*$/m.exec(existing);
  if (exitMatch && exitMatch.index !== undefined) {
    const before = existing.slice(0, exitMatch.index);
    const after = existing.slice(exitMatch.index);
    const separator = before.endsWith('\n') ? '' : eol;
    return `${before}${separator}${block}${eol}${after}`;
  }

  const prefix = existing.endsWith('\n') ? existing : `${existing}${eol}`;
  return `${prefix}${block}${eol}`;
}

/** Удаляет блок(и) consilium, остальное содержимое оставляет нетронутым */
export function removeHookBlock(existing: string): string {
  const without = existing.replace(HOOK_BLOCK_RE_ALL, () => '');
  if (without === existing) {
    return existing;
  }
  return without;
}

/** Атомарная запись (tmp-файл + rename в той же директории) */
function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.consilium-${process.pid}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Устанавливает pre-commit hook в `<cwd>/.git/hooks/pre-commit`.
 * Существующий hook сохраняется (блок добавляется/обновляется через upsert).
 * Бросает понятную ошибку, если `.git` отсутствует.
 * Возвращает `created=false`, если файл уже существовал.
 */
export function installPreCommitHook(
  cwd: string,
  command: string
): { path: string; created: boolean } {
  const hooksDir = resolveHooksDir(cwd);
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');
  const existed = existsSync(hookPath);
  const existing = existed ? readFileSync(hookPath, 'utf8') : '';

  if (existing.trim().length > 0) {
    const firstLine =
      existing.split(/\r?\n/).find(line => line.trim().length > 0) ?? '';
    if (firstLine.startsWith('#!')) {
      const interpreter = firstLine.slice(2).trim().split(/\s+/)[0] ?? '';
      const base = path.basename(interpreter);
      if (!SHELL_INTERPRETERS.has(base)) {
        throw new Error(
          `Cannot install pre-commit hook: existing hook uses "${interpreter}". ` +
            'Add the consilium block manually or convert the hook to a shell script.'
        );
      }
    }
  }

  writeFileAtomic(hookPath, upsertHookBlock(existing, command));
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // Windows: chmod без эффекта, игнорируем.
  }
  return { path: hookPath, created: !existed };
}

/** Проверяет, не осталось ли в hook-файле только служебного содержимого */
function isEffectivelyEmptyHook(content: string): boolean {
  return content
    .split('\n')
    .every(line => {
      const trimmed = line.trim();
      return trimmed === '' || trimmed.startsWith('#!') || trimmed.startsWith('set ');
    });
}

/**
 * Удаляет блок consilium из pre-commit hook.
 * Если файл стал фактически пустым (только shebang/whitespace/set) —
 * удаляет его. Возвращает true, если блок был удалён, иначе false.
 */
export function uninstallPreCommitHook(cwd: string): boolean {
  let hookPath: string;
  try {
    hookPath = path.join(resolveHooksDir(cwd), 'pre-commit');
  } catch {
    return false;
  }
  if (!existsSync(hookPath)) {
    return false;
  }
  const existing = readFileSync(hookPath, 'utf8');
  const next = removeHookBlock(existing);
  if (next === existing) {
    return false;
  }
  if (isEffectivelyEmptyHook(next)) {
    unlinkSync(hookPath);
    return true;
  }

  const mode = statSync(hookPath).mode & 0o777;
  writeFileAtomic(hookPath, next);
  try {
    // Сохраняем исполняемость: иначе git молча перестанет запускать hook.
    chmodSync(hookPath, mode | 0o100);
  } catch {
    // Windows: chmod без эффекта, игнорируем.
  }
  return true;
}
