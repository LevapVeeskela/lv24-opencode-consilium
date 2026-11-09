/**
 * @fileoverview Хранение артефактов запусков консилиума
 * @module lv24-opencode-consilium
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../../shared/fs.js';
import {
  PathContainmentError,
  canonicalizePath,
  resolveInside
} from '../../shared/paths.js';
import { redactSecrets } from '../../shared/redact.js';
import { isRecord } from '../../shared/record.js';
import { formatArtifact } from '../../domain/artifacts/artifacts/format.js';
import { ID_PATTERN, type ArtifactRef, type ArtifactRun } from '../../domain/artifacts/artifacts/types.js';

export { PathContainmentError };

/** Дополняет число ведущим нулём */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Создаёт идентификатор артефакта вида `YYYYMMDD-HHMMSS-<4 hex>` (UTC)
 */
export function createArtifactId(now?: Date): string {
  const d = now ?? new Date();
  const date =
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${date}-${hex}`;
}

/**
 * Определяет корневой каталог артефактов.
 * `false` запрещает сохранение и бросает ошибку.
 */
export function resolveArtifactRoot(config: { artifacts?: string | boolean; cwd?: string }): string {
  const cwd = config.cwd ?? process.cwd();
  const artifacts = config.artifacts;
  if (artifacts === false) {
    throw new Error('Сохранение артефактов отключено (artifacts: false)');
  }
  if (typeof artifacts === 'string') {
    return path.resolve(cwd, artifacts);
  }
  return path.resolve(cwd, '.consilium', 'runs');
}

/** Очищает имя агента для безопасного имени файла */
function sanitizeAgentName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (clean.length === 0 || clean === '.' || clean === '..') {
    return '_';
  }
  return clean;
}

/** Возвращает канонический (с разрешёнными симлинками) корень артефактов */
function realArtifactRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return realpathSync.native(resolved);
  } catch {
    return canonicalizePath(resolved);
  }
}

/** Проверяет, что путь артефакта не выходит из корня через симлинк */
function assertArtifactPath(root: string, target: string, source: string): string {
  try {
    return resolveInside(root, target, 'Artifact path');
  } catch (error) {
    if (error instanceof PathContainmentError) {
      throw new PathContainmentError(
        `Путь вне каталога артефактов: "${source}"`,
        error.base,
        error.candidate
      );
    }
    throw error;
  }
}

/** Создаёт .consilium/.gitignore при первой записи артефакта */
function ensureArtifactGitignore(root: string): void {
  const parent = path.dirname(root);
  const targetDir =
    path.basename(root) === 'runs' && path.basename(parent) === '.consilium' ? parent : root;
  const target = path.join(targetDir, '.gitignore');
  if (existsSync(target)) return;
  try {
    writeFileAtomic(target, '*\n!.gitignore\n');
  } catch {
    // Артефакт важнее декоративного .gitignore: запись не должна ломаться.
  }
}

/** Копия запуска с замаскированными секретами */
function redactRun(run: ArtifactRun): ArtifactRun {
  return {
    ...run,
    task: redactSecrets(run.task),
    text: redactSecrets(run.text),
    experts: run.experts.map(expert => ({
      ...expert,
      text: redactSecrets(expert.text),
      errorMessage:
        expert.errorMessage === undefined ? undefined : redactSecrets(expert.errorMessage)
    }))
  };
}

/** Проверяет и приводит сырой JSON к ArtifactRun */
function validateArtifactRun(data: unknown, source: string): ArtifactRun {
  if (!isRecord(data)) {
    throw new Error(`Некорректный артефакт ${source}: корень должен быть объектом`);
  }
  if (typeof data['id'] !== 'string' || data['id'].length === 0) {
    throw new Error(`Некорректный артефакт ${source}: поле "id" должно быть непустой строкой`);
  }
  if (typeof data['createdAt'] !== 'string' || data['createdAt'].length === 0) {
    throw new Error(`Некорректный артефакт ${source}: поле "createdAt" должно быть непустой строкой`);
  }
  if (typeof data['task'] !== 'string') {
    throw new Error(`Некорректный артефакт ${source}: поле "task" должно быть строкой`);
  }
  if (typeof data['success'] !== 'boolean') {
    throw new Error(`Некорректный артефакт ${source}: поле "success" должно быть boolean`);
  }
  if (typeof data['text'] !== 'string') {
    throw new Error(`Некорректный артефакт ${source}: поле "text" должно быть строкой`);
  }
  if (!Array.isArray(data['experts'])) {
    throw new Error(`Некорректный артефакт ${source}: поле "experts" должно быть массивом`);
  }
  if (!isRecord(data['models'])) {
    throw new Error(`Некорректный артефакт ${source}: поле "models" должно быть объектом`);
  }
  for (const item of data['experts']) {
    if (!isRecord(item) || typeof item['agent'] !== 'string' || typeof item['text'] !== 'string') {
      throw new Error(`Некорректный артефакт ${source}: каждый эксперт должен иметь строковые "agent" и "text"`);
    }
    if (typeof item['success'] !== 'boolean') {
      throw new Error(`Некорректный артефакт ${source}: поле эксперта "success" должно быть boolean`);
    }
  }
  return data as unknown as ArtifactRun;
}

/**
 * Сохраняет запуск в `<root>/<id>/`.
 * Структура: `run.json`, `report.md`, `experts/<agent>.md`.
 * При коллизии id добавляет суффикс `-2`, `-3`, … и обновляет `run.id`.
 * Возвращает ссылку с абсолютным `dir`.
 */
export function saveArtifact(run: ArtifactRun, options: { root?: string }): ArtifactRef {
  const root = path.resolve(options.root ?? resolveArtifactRoot({}));
  if (!ID_PATTERN.test(run.id) || run.id === '.' || run.id === '..') {
    throw new Error(`Некорректный id артефакта: "${run.id}"`);
  }

  mkdirSync(root, { recursive: true });
  ensureArtifactGitignore(root);

  // Каталог запуска создаётся атомарно: mkdir без recursive либо создаёт его,
  // либо сообщает EEXIST, и тогда пробуем следующий суффикс.
  let finalId = run.id;
  let counter = 2;
  let dir: string;
  for (;;) {
    dir = path.join(root, finalId);
    try {
      mkdirSync(dir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        finalId = `${run.id}-${counter}`;
        counter += 1;
        continue;
      }
      throw error;
    }
  }

  const expertsDir = path.join(dir, 'experts');
  mkdirSync(expertsDir, { recursive: true });

  const stored: ArtifactRun = redactRun(finalId === run.id ? run : { ...run, id: finalId });
  writeFileAtomic(path.join(dir, 'report.md'), formatArtifact(stored));

  const usedNames = new Set<string>();
  for (const expert of stored.experts) {
    const base = sanitizeAgentName(expert.agent);
    let name = base;
    let dup = 2;
    // Ключ в нижнем регистре: Arch и arch не должны перезаписать друг друга.
    while (usedNames.has(name.toLowerCase())) {
      name = `${base}-${dup}`;
      dup += 1;
    }
    usedNames.add(name.toLowerCase());
    const header =
      `# Эксперт: ${expert.agent}\n\n` +
      `- Модель: ${expert.model ?? '—'}\n` +
      `- Статус: ${expert.success ? 'успех' : 'ошибка'}\n` +
      (expert.errorCode !== undefined ? `- Код ошибки: ${expert.errorCode}\n` : '') +
      (expert.errorMessage !== undefined ? `- Ошибка: ${expert.errorMessage}\n` : '') +
      (expert.duration !== undefined ? `- Длительность: ${expert.duration} мс\n` : '') +
      `\n---\n\n`;
    writeFileAtomic(path.join(expertsDir, `${name}.md`), `${header}${expert.text}\n`);
  }

  // run.json пишем последним: недописанный каталог не должен выглядеть артефактом.
  writeFileAtomic(path.join(dir, 'run.json'), `${JSON.stringify(stored, null, 2)}\n`);

  return { id: finalId, dir: path.resolve(dir) };
}

/** Проверяет запись каталога как артефакт (id + createdAt), ошибки гасит */
function tryReadRef(
  dir: string,
  realRoot: string
): { ref: ArtifactRef; createdAt: string } | null {
  const safeDir = assertArtifactPath(realRoot, dir, path.basename(dir));
  const runFile = assertArtifactPath(realRoot, path.join(safeDir, 'run.json'), path.basename(dir));
  if (!existsSync(runFile)) {
    return null;
  }
  try {
    const st = statSync(runFile);
    if (!st.isFile()) {
      return null;
    }
    const raw = readFileSync(runFile, 'utf8');
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data)) {
      return null;
    }
    const { id, createdAt } = data;
    if (typeof id !== 'string' || typeof createdAt !== 'string') {
      return null;
    }
    return { ref: { id, dir: path.resolve(safeDir) }, createdAt };
  } catch {
    return null;
  }
}

/**
 * Перечисляет артефакты в корне (прямые подкаталоги с `run.json`).
 * Битые каталоги молча пропускаются, симлинк-побег отклоняется.
 * Сортировка — новые сверху.
 */
export function listArtifacts(root: string): ArtifactRef[] {
  const resolved = path.resolve(root);
  let entries: string[];
  try {
    entries = readdirSync(resolved);
  } catch {
    return [];
  }
  const realRoot = realArtifactRoot(resolved);
  const refs: Array<{ ref: ArtifactRef; createdAt: string }> = [];
  for (const entry of entries) {
    const dir = path.join(resolved, entry);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const ref = tryReadRef(dir, realRoot);
    if (ref === null) {
      continue;
    }
    refs.push(ref);
  }
  refs.sort((x, y) => (y.createdAt < x.createdAt ? -1 : y.createdAt > x.createdAt ? 1 : 0));
  return refs.map(item => item.ref);
}

/** Проверяет, что строка — безопасный id (без `..` и разделителей) */
function assertSafeId(id: string): void {
  if (!ID_PATTERN.test(id) || id === '.' || id === '..' || id.includes('..')) {
    throw new Error(`Некорректный идентификатор артефакта: "${id}"`);
  }
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`Некорректный идентификатор артефакта: "${id}"`);
  }
}

/**
 * Загружает артефакт по id или по пути (каталог либо `run.json`).
 * Относительные пути резолвятся против `root`, затем против cwd.
 */
export function loadArtifact(idOrPath: string, root: string): ArtifactRun {
  const resolvedRoot = path.resolve(root);
  const realRoot = realArtifactRoot(resolvedRoot);
  const looksLikePath =
    idOrPath.includes('/') ||
    idOrPath.includes('\\') ||
    idOrPath === '.' ||
    idOrPath === '..' ||
    idOrPath.endsWith('.json');

  if (!looksLikePath && ID_PATTERN.test(idOrPath) && idOrPath !== '..' && !idOrPath.includes('..')) {
    const candidate = path.join(resolvedRoot, idOrPath, 'run.json');
    const file = assertArtifactPath(realRoot, candidate, idOrPath);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw new Error(`Артефакт не найден: "${idOrPath}" (ожидался ${file})`);
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Некорректный JSON артефакта: ${file}`);
    }
    return validateArtifactRun(data, file);
  }

  // Форма пути: сначала проверяем id-подобные без разделителей как traversal-атаку
  if (!looksLikePath) {
    assertSafeId(idOrPath);
  }

  let candidate = idOrPath;
  if (!path.isAbsolute(candidate)) {
    const againstRoot = path.join(resolvedRoot, candidate);
    candidate = existsSync(againstRoot) ? againstRoot : path.resolve(candidate);
  }

  // Лексическая проверка: читать можно только внутри каталога артефактов.
  const relative = path.relative(resolvedRoot, path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Путь вне каталога артефактов: "${idOrPath}" (разрешён только ${resolvedRoot})`
    );
  }

  // После лексической проверки разрешаем симлинки и повторно требуем вложенность.
  const safeCandidate = assertArtifactPath(realRoot, candidate, idOrPath);
  let file = safeCandidate;
  try {
    const st = statSync(safeCandidate);
    if (st.isDirectory()) {
      file = assertArtifactPath(realRoot, path.join(safeCandidate, 'run.json'), idOrPath);
    }
  } catch (error) {
    if (error instanceof PathContainmentError) throw error;
    throw new Error(`Артефакт не найден: "${idOrPath}"`);
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Артефакт не найден: "${idOrPath}" (ожидался ${file})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Некорректный JSON артефакта: ${file}`);
  }
  return validateArtifactRun(data, file);
}
