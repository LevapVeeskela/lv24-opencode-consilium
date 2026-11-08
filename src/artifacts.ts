/**
 * @fileoverview Хранение и сравнение артефактов запусков консилиума
 * @module lv24-opencode-consilium
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import * as path from 'node:path';
import type { AgentUsage } from './types.js';

/** Ссылка на сохранённый артефакт */
export interface ArtifactRef {
  id: string;
  dir: string;
}

/** Результат одного эксперта внутри артефакта */
export interface ArtifactExpert {
  agent: string;
  model?: string;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  duration?: number;
  text: string;
  usage?: AgentUsage;
}

/** Сохранённый запуск консилиума */
export interface ArtifactRun {
  version: 1;
  id: string;
  createdAt: string;
  task: string;
  success: boolean;
  text: string;
  experts: ArtifactExpert[];
  models: Record<string, string | undefined>;
  /** Агент-председатель, чтобы replay восстановил именно его */
  chairAgent?: string;
  usage?: AgentUsage;
  consensus?: unknown;
  metadata?: Record<string, unknown>;
}

/** Допустимые символы идентификатора артефакта */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Максимальная длина текста эксперта в отчёте */
const MAX_EXPERT_TEXT_CHARS = 4000;

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

/** Атомарно записывает файл (tmp + rename) */
function writeFileAtomic(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${Math.floor(Math.random() * 0xffffffff).toString(16)}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Уборка tmp не должна маскировать исходную ошибку
    }
    throw new Error(`Не удалось записать ${target}: ${(error as Error).message}`);
  }
}

/** Проверяет, что значение — plain object */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** Форматирует расход токенов одной строкой */
function formatUsageLine(usage: AgentUsage | undefined): string {
  if (usage === undefined) {
    return '—';
  }
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    parts.push(`вход: ${usage.inputTokens}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`выход: ${usage.outputTokens}`);
  }
  if (usage.reasoningTokens !== undefined) {
    parts.push(`рассуждения: ${usage.reasoningTokens}`);
  }
  if (usage.cacheReadTokens !== undefined) {
    parts.push(`кэш-чтение: ${usage.cacheReadTokens}`);
  }
  if (usage.cacheWriteTokens !== undefined) {
    parts.push(`кэш-запись: ${usage.cacheWriteTokens}`);
  }
  if (usage.cost !== undefined) {
    parts.push(`стоимость: $${usage.cost}`);
  }
  return parts.length > 0 ? parts.join(', ') : '—';
}

/** Обрезает текст до лимита с пометкой */
function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n[… обрезано: ${text.length - limit} символов из ${text.length} …]`;
}

/**
 * Форматирует артефакт в читаемый русскоязычный markdown-отчёт
 */
export function formatArtifact(run: ArtifactRun): string {
  const lines: string[] = [];
  lines.push(`# Отчёт консилиума: ${run.id}`);
  lines.push('');
  lines.push(`- Дата: ${run.createdAt}`);
  lines.push(`- Статус: ${run.success ? '✅ успех' : '❌ ошибка'}`);
  lines.push('');
  lines.push('## Задача');
  lines.push('');
  lines.push(run.task);
  lines.push('');
  lines.push('## Модели');
  lines.push('');
  const modelKeys = Object.keys(run.models);
  if (modelKeys.length === 0) {
    lines.push('Модели не указаны.');
  } else {
    for (const name of modelKeys) {
      lines.push(`- ${name}: ${run.models[name] ?? '—'}`);
    }
  }
  lines.push('');
  lines.push(`## Эксперты (${run.experts.length})`);
  lines.push('');
  if (run.experts.length === 0) {
    lines.push('Нет ответов экспертов.');
  } else {
    for (const expert of run.experts) {
      lines.push(`### ${expert.agent}`);
      lines.push('');
      lines.push(`- Модель: ${expert.model ?? '—'}`);
      lines.push(`- Статус: ${expert.success ? '✅ успех' : '❌ ошибка'}`);
      if (expert.errorCode !== undefined) {
        lines.push(`- Код ошибки: ${expert.errorCode}`);
      }
      if (expert.errorMessage !== undefined) {
        lines.push(`- Ошибка: ${expert.errorMessage}`);
      }
      if (expert.duration !== undefined) {
        lines.push(`- Длительность: ${expert.duration} мс`);
      }
      lines.push(`- Расход: ${formatUsageLine(expert.usage)}`);
      lines.push('');
      lines.push(truncateText(expert.text, MAX_EXPERT_TEXT_CHARS));
      lines.push('');
    }
  }
  lines.push('## Итог');
  lines.push('');
  lines.push(run.text);
  lines.push('');
  lines.push('## Расход');
  lines.push('');
  lines.push(`- Суммарно: ${formatUsageLine(run.usage)}`);
  lines.push('');
  return lines.join('\n');
}

/** Сравнивает два артефакта и возвращает markdown-отчёт */
export function diffArtifacts(a: ArtifactRun, b: ArtifactRun): string {
  const lines: string[] = [];
  lines.push(`# Сравнение запусков: ${a.id} ↔ ${b.id}`);
  lines.push('');
  lines.push(`- Задача: ${a.task === b.task ? 'без изменений' : 'ИЗМЕНИЛАСЬ'}`);
  if (a.task !== b.task) {
    lines.push(`  - Было: ${a.task}`);
    lines.push(`  - Стало: ${b.task}`);
  }
  lines.push(`- Даты: ${a.createdAt} → ${b.createdAt}`);
  lines.push(`- Статус: ${a.success ? '✅' : '❌'} → ${b.success ? '✅' : '❌'}`);
  lines.push('');
  lines.push('## Модели');
  lines.push('');
  lines.push('| Агент | Было | Стало |');
  lines.push('| --- | --- | --- |');
  const names = new Set<string>([...Object.keys(a.models), ...Object.keys(b.models)]);
  if (names.size === 0) {
    lines.push('| — | — | — |');
  } else {
    for (const name of [...names].sort()) {
      const before = a.models[name] ?? '—';
      const after = b.models[name] ?? '—';
      const mark = before === after ? '' : ' ⚠';
      lines.push(`| ${name} | ${before} | ${after}${mark} |`);
    }
  }
  lines.push('');
  lines.push('## Эксперты');
  lines.push('');
  lines.push('| Агент | Статус | Δ символов |');
  lines.push('| --- | --- | --- |');
  const mapA = new Map(a.experts.map(e => [e.agent, e]));
  const mapB = new Map(b.experts.map(e => [e.agent, e]));
  const allAgents = new Set<string>([...mapA.keys(), ...mapB.keys()]);
  if (allAgents.size === 0) {
    lines.push('| — | нет экспертов | — |');
  } else {
    for (const name of [...allAgents].sort()) {
      const ea = mapA.get(name);
      const eb = mapB.get(name);
      if (ea !== undefined && eb === undefined) {
        lines.push(`| ${name} | удалён | −${ea.text.length} |`);
      } else if (ea === undefined && eb !== undefined) {
        lines.push(`| ${name} | добавлен | +${eb.text.length} |`);
      } else if (ea !== undefined && eb !== undefined) {
        const delta = eb.text.length - ea.text.length;
        const status =
          ea.text === eb.text && ea.success === eb.success ? 'без изменений' : 'изменён';
        const deltaStr = delta === 0 ? '0' : delta > 0 ? `+${delta}` : `${delta}`;
        lines.push(`| ${name} | ${status} | ${deltaStr} |`);
      }
    }
  }
  lines.push('');
  lines.push('## Итоговый текст');
  lines.push('');
  const delta = b.text.length - a.text.length;
  lines.push(`- Длина: ${a.text.length} → ${b.text.length} (Δ ${delta >= 0 ? `+${delta}` : `${delta}`})`);
  lines.push(`- Текст ${a.text === b.text ? 'без изменений' : 'ИЗМЕНИЛСЯ'}`);
  lines.push('');
  return lines.join('\n');
}
