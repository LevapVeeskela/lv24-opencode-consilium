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
