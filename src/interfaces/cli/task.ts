/**
 * @fileoverview Подготовка задачи CLI consilium (stdin, файл, git diff)
 * @module lv24-opencode-consilium/cli/task
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { CLIOptions } from '../../domain/types.js';
import { getGitDiff, formatDiffForPrompt } from '../../infrastructure/git.js';
import { UsageError } from './args.js';

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

export async function buildTask(options: CLIOptions): Promise<string> {
  let task = options.task;

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
      const diffText = formatDiffForPrompt(diff);
      task = task
        ? `${task}\n\n${diffText}`
        : `Проведи ревью изменений в коде: найди баги, риски безопасности и предложи улучшения.\n\n${diffText}`;
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }

  return task.trim();
}
