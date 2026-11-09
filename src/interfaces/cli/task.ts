/**
 * @fileoverview Подготовка задачи CLI consilium (stdin, файл, git diff, контекст)
 * @module lv24-opencode-consilium/cli/task
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { CLIOptions, ConsiliumConfig } from '../../domain/types.js';
import { buildContextPack } from '../../infrastructure/context.js';
import { getGitDiff, formatDiffForPrompt } from '../../infrastructure/git.js';
import { UsageError } from './args.js';
import { log } from './output.js';

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1_000_000) {
      throw new UsageError('stdin превышает 1 МБ');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export async function readTaskFromFile(path: string): Promise<string> {
  if (path === '-') {
    return readStdin();
  }
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    throw new UsageError(`Файл с задачей не найден: ${path}`);
  }
  return readFileSync(resolved, 'utf-8').trim();
}

export async function buildTask(
  options: CLIOptions,
  config?: ConsiliumConfig
): Promise<string> {
  let task = options.task;
  let diffText: string | undefined;

  if (options.taskFile) {
    const fromFile = await readTaskFromFile(options.taskFile);
    task = task ? `${fromFile}\n\n${task}` : fromFile;
  }

  if (options.diff || options.diffStaged || options.diffBase) {
    try {
      const diff = await getGitDiff({
        staged: options.diffStaged,
        base: options.diffBase
      });
      diffText = diff.diff;
      const diffTextForPrompt = formatDiffForPrompt(diff);
      task = task
        ? `${task}\n\n${diffTextForPrompt}`
        : `Проведи ревью изменений в коде: найди баги, риски безопасности и предложи улучшения.\n\n${diffTextForPrompt}`;
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }

  task = await appendTaskContext(options, config, task, diffText);
  return task.trim();
}

/**
 * Добавляет context pack к задаче, когда включён режим `context: auto`.
 * При `off` (по умолчанию) возвращает задачу без изменений.
 */
export async function appendTaskContext(
  options: CLIOptions,
  config: ConsiliumConfig | undefined,
  task: string,
  diff: string | undefined
): Promise<string> {
  const mode = options.context ?? config?.context ?? 'off';
  if (mode !== 'auto') {
    return task;
  }

  const cwd = config?.cwd ?? process.cwd();
  try {
    const pack = await buildContextPack({ cwd, diff, task });
    log(
      options,
      `🧩 Контекст (context): files=${pack.files.length}, ` +
        `rules=${pack.rulesFile ?? 'none'}, tests=${pack.testFiles.length}, chars=${pack.chars}`
    );

    if (pack.text.trim().length === 0) {
      return task;
    }

    const block = `<context>\n${pack.text.trimEnd()}\n</context>`;
    return task.length > 0 ? `${task}\n\n${block}` : block;
  } catch (error) {
    log(options, `⚠️ Не удалось собрать контекст: ${(error as Error).message}`);
    return task;
  }
}
