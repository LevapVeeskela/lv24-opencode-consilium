/**
 * @fileoverview Хранение артефактов запусков консилиума
 * @module lv24-opencode-consilium
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../../../shared/fs.js';
import { isRecord } from '../../../shared/record.js';
import { formatArtifact } from './format.js';
import { ID_PATTERN, type ArtifactRef, type ArtifactRun } from './types.js';

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

  let finalId = run.id;
  let counter = 2;
  while (existsSync(path.join(root, finalId))) {
    finalId = `${run.id}-${counter}`;
    counter += 1;
  }

  const stored: ArtifactRun = finalId === run.id ? run : { ...run, id: finalId };
  const dir = path.join(root, finalId);
  const expertsDir = path.join(dir, 'experts');
  mkdirSync(expertsDir, { recursive: true });

  writeFileAtomic(path.join(dir, 'report.md'), formatArtifact(stored));

  const usedNames = new Set<string>();
  for (const expert of stored.experts) {
    let base = sanitizeAgentName(expert.agent);
    let name = base;
    let dup = 2;
    while (usedNames.has(name)) {
      name = `${base}-${dup}`;
      dup += 1;
    }
    usedNames.add(name);
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
function tryReadRef(dir: string): ArtifactRef | null {
  const runFile = path.join(dir, 'run.json');
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
    void createdAt;
    return { id, dir: path.resolve(dir) };
  } catch {
    return null;
  }
}

/**
 * Перечисляет артефакты в корне (прямые подкаталоги с `run.json`).
 * Битые каталоги молча пропускаются. Сортировка — новые сверху.
 */
export function listArtifacts(root: string): ArtifactRef[] {
  const resolved = path.resolve(root);
  let entries: string[];
  try {
    entries = readdirSync(resolved);
  } catch {
    return [];
  }
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
    const ref = tryReadRef(dir);
    if (ref === null) {
      continue;
    }
    let createdAt = '';
    try {
      const data: unknown = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8'));
      if (isRecord(data) && typeof data['createdAt'] === 'string') {
        createdAt = data['createdAt'];
      }
    } catch {
      continue;
    }
    refs.push({ ref, createdAt });
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
  const looksLikePath =
    idOrPath.includes('/') ||
    idOrPath.includes('\\') ||
    idOrPath === '.' ||
    idOrPath === '..' ||
    idOrPath.endsWith('.json');

  if (!looksLikePath && ID_PATTERN.test(idOrPath) && idOrPath !== '..' && !idOrPath.includes('..')) {
    const file = path.join(resolvedRoot, idOrPath, 'run.json');
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

  // Читать можно только внутри каталога артефактов: id-форма это уже гарантирует,
  // а форма пути — нет.
  const relative = path.relative(resolvedRoot, path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Путь вне каталога артефактов: "${idOrPath}" (разрешён только ${resolvedRoot})`
    );
  }

  let file = candidate;
  try {
    const st = statSync(candidate);
    if (st.isDirectory()) {
      file = path.join(candidate, 'run.json');
    }
  } catch {
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
