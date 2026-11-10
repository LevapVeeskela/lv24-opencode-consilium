/**
 * @fileoverview Аргументы запуска `opencode run`
 * @module lv24-opencode-consilium
 */

import type { ConsiliumConfig } from '../../domain/types.js';
import { isValidSessionId } from '../../domain/council/sessions.js';

/** Допустимое имя агента OpenCode */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/;

/** Допустимый идентификатор модели OpenCode */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@\/#+-]*$/;

/** Проверяет, что имя агента допустимо для `--agent` */
export function isValidAgentName(value: string): boolean {
  return AGENT_NAME_PATTERN.test(value);
}

/** Проверяет, что идентификатор модели допустим для `--model` */
export function isValidModelName(value: string): boolean {
  return MODEL_PATTERN.test(value);
}

/** Ошибка небезопасного аргумента при запуске через cmd.exe */
export class UnsafeWindowsArgumentError extends Error {
  /** Аргумент, который не прошёл проверку */
  readonly argument: string;

  constructor(argument: string) {
    super(
      `Небезопасный аргумент Windows "${argument}": при запуске .cmd/.bat через cmd.exe ` +
        'запрещены кавычки, %, !, ^, &, |, <, >, переводы строк и пробелы. ' +
        'Разрешены обычные флаги и значения вида --model=provider/model.'
    );
    this.name = 'UnsafeWindowsArgumentError';
    this.argument = argument;
  }
}

/** Символы, которые cmd.exe интерпретирует даже внутри кавычек */
const WINDOWS_CMD_FORBIDDEN = /["'%!^&|<>]/;

/** Управляющие символы и любые пробелы ломают разбиение командной строки */
const WINDOWS_CMD_WHITESPACE = /[\s\0]/;

/**
 * Проверяет аргумент перед подстановкой в командную строку cmd.exe.
 * Возвращает исходное значение или бросает типизированную ошибку.
 */
export function validateWindowsArg(argument: string): string {
  if (WINDOWS_CMD_FORBIDDEN.test(argument) || WINDOWS_CMD_WHITESPACE.test(argument)) {
    throw new UnsafeWindowsArgumentError(argument);
  }
  return argument;
}

/**
 * Формирует аргументы `opencode run`.
 * Невалидные agent/model отбрасываются.
 *
 * Изоляция в worktree выполняется самим Consilium через `cwd` дочернего
 * процесса: нативный `--worktree` не передаётся, иначе OpenCode создал бы
 * вложенный worktree, который Consilium не может убрать.
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
  if (agent !== undefined && agent.length > 0 && isValidAgentName(agent)) {
    args.push(`--agent=${agent}`);
  }

  const model = opts.model?.trim();
  if (model !== undefined && model.length > 0 && isValidModelName(model)) {
    args.push(`--model=${model}`);
  }

  const session = opts.session?.trim();
  if (session !== undefined && session.length > 0 && isValidSessionId(session)) {
    args.push(`--session=${session}`);
  }

  return args;
}
