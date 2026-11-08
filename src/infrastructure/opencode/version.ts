/**
 * @fileoverview Версия и доступность OpenCode CLI
 * @module lv24-opencode-consilium
 */

import type { ConsiliumConfig } from '../../domain/types.js';
import { executeOpenCode, resolveCwd, resolveOpenCodePath } from './runner.js';

/** Таймаут проверки доступности CLI (мс) */
const AVAILABILITY_TIMEOUT = 10000;

/**
 * Проверяет доступность OpenCode CLI (таймаут 10 с)
 */
export async function checkOpenCodeAvailable(
  config?: Pick<ConsiliumConfig, 'opencodePath' | 'cwd'>
): Promise<boolean> {
  const outcome = await executeOpenCode({
    opencodePath: resolveOpenCodePath(config),
    args: ['--version'],
    cwd: resolveCwd(config),
    timeoutMs: AVAILABILITY_TIMEOUT
  });

  return outcome.spawnError === undefined && !outcome.timedOut && outcome.code === 0;
}

/**
 * Возвращает версию OpenCode CLI или null
 */
export async function getOpenCodeVersion(
  config?: Pick<ConsiliumConfig, 'opencodePath' | 'cwd'>
): Promise<string | null> {
  const outcome = await executeOpenCode({
    opencodePath: resolveOpenCodePath(config),
    args: ['--version'],
    cwd: resolveCwd(config),
    timeoutMs: AVAILABILITY_TIMEOUT
  });

  if (outcome.spawnError !== undefined || outcome.timedOut || outcome.code !== 0) {
    return null;
  }

  const version = outcome.stdout.trim() || outcome.stderr.trim();
  return version.length > 0 ? version : null;
}
