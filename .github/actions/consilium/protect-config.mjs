#!/usr/bin/env node
/**
 * Take the files that control the review from the base ref, not from the pull
 * request under review.
 *
 * A pull request can otherwise weaken its own check: point experts at another
 * model or prompt in consilium.config.json, accept its own findings in
 * .consilium/baseline.json, or add MCP servers, plugins and providers through
 * opencode.json. This script restores those files to their base-ref content in
 * the workspace (and removes the ones the pull request added) before Consilium
 * runs. The pull request's changes to them are therefore not reviewed either;
 * the notice below lists every file so a human can look at them.
 *
 * Usage: node protect-config.mjs <base-ref>   (cwd = repository checkout)
 * Exit codes: 0 done (including "nothing to do"), 2 could not protect.
 */

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Files and directories that steer the council or the policy gate. */
export const PROTECTED_PATHS = [
  'consilium.config.json',
  'consilium.json',
  '.consiliumrc',
  '.consiliumrc.json',
  '.consilium/baseline.json',
  'opencode.json',
  'opencode.jsonc',
  '.opencode'
];

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024
  });
}

function lines(output) {
  return output
    .split('\0')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function existsInBase(cwd, base, file) {
  try {
    git(cwd, ['cat-file', '-e', `${base}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

function insideWorkspace(cwd, file) {
  const rel = relative(cwd, resolve(cwd, file));
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Restores protected files to their base-ref state.
 * @returns {{ restored: string[], removed: string[] }}
 */
export function protectConfig(cwd, base) {
  if (typeof base !== 'string' || base.length === 0 || base.startsWith('-')) {
    throw new Error(`Invalid base ref: ${JSON.stringify(base)}`);
  }
  git(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);

  const changed = new Set([
    // Tracked files that differ between the base commit and the working tree.
    ...lines(git(cwd, ['diff', '--name-only', '-z', base, '--', ...PROTECTED_PATHS])),
    // Untracked files a build step or the pull request left in protected places.
    ...lines(
      git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...PROTECTED_PATHS])
    )
  ]);

  const restored = [];
  const removed = [];
  for (const file of [...changed].sort()) {
    if (!insideWorkspace(cwd, file)) {
      throw new Error(`Refusing to touch a path outside the workspace: ${file}`);
    }
    if (existsInBase(cwd, base, file)) {
      git(cwd, ['checkout', base, '--', file]);
      restored.push(file);
    } else {
      rmSync(resolve(cwd, file), { force: true });
      try {
        git(cwd, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', file]);
      } catch {
        // The file was untracked: nothing to drop from the index.
      }
      removed.push(file);
    }
  }
  return { restored, removed };
}

function commandEscape(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function main() {
  const base = process.argv[2];
  const cwd = process.cwd();
  let result;
  try {
    result = protectConfig(cwd, base);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::error::${commandEscape(
        `Could not take the review configuration from the base ref: ${message}`
      )}`
    );
    process.exitCode = 2;
    return;
  }

  const total = result.restored.length + result.removed.length;
  if (total === 0) {
    console.log('Review configuration is unchanged by this pull request.');
    return;
  }
  const parts = [];
  if (result.restored.length > 0) parts.push(`restored from ${base}: ${result.restored.join(', ')}`);
  if (result.removed.length > 0) parts.push(`added by the pull request and removed: ${result.removed.join(', ')}`);
  console.log(
    `::notice::${commandEscape(
      `Consilium used the review configuration from the base ref (${parts.join('; ')}). ` +
        'These changes were not applied to this run and were not reviewed; check them by hand. ' +
        'Set config-from-base: false to use the pull request versions.'
    )}`
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) main();
