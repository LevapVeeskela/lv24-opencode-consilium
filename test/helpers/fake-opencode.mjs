// Shared test harness: a fake `opencode` binary driven by a small script body.
// No network and no real OpenCode: the fake reads the prompt from stdin and
// prints NDJSON `text` events, like `opencode run --format json`.
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRUSTED_PROJECT_CONFIG } from '../../dist/infrastructure/config/load.js';

/**
 * @param {string} body JavaScript statements with `agent`, `prompt`, `args` and `emit(text)`
 *   in scope. Example: `emit(agent === 'build' ? 'A' : 'B');`
 * @returns {{ dir: string, opencodePath: string }}
 */
export function createFakeOpenCode(body) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'consilium-fake-')));
  const script = join(dir, 'fake-opencode.mjs');
  writeFileSync(
    script,
    `const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-opencode 1.0.0\\n');
} else {
  const agentArg = args.find(arg => arg.startsWith('--agent='));
  const agent = agentArg === undefined ? 'default' : agentArg.slice('--agent='.length);
  const prompt = await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
  const emit = text =>
    process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text } }) + '\\n');
${body}
}
`,
    'utf8'
  );

  let opencodePath;
  if (process.platform === 'win32') {
    opencodePath = join(dir, 'fake-opencode.cmd');
    writeFileSync(opencodePath, `@"${process.execPath}" "%~dp0fake-opencode.mjs" %*\r\n`, 'utf8');
  } else {
    opencodePath = join(dir, 'fake-opencode');
    writeFileSync(
      opencodePath,
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-opencode.mjs" "$@"\n`,
      'utf8'
    );
    chmodSync(opencodePath, 0o755);
  }

  return { dir, opencodePath };
}

/** Trusted in-memory config for a fake OpenCode run (built-in agent names, no retries). */
export function createFakeConfig(opencodePath, cwd, overrides = {}) {
  const config = {
    cwd,
    opencodePath,
    experts: [{ name: 'build' }, { name: 'plan' }],
    chair: { agent: 'general', timeout: 5000 },
    timeouts: { expert: 5000, chair: 5000, shutdown: 1000 },
    retry: {
      expertRetries: 0,
      chairRetries: 0,
      delay: 1,
      exponentialBackoff: false,
      jitter: false,
      maxConcurrency: 3
    },
    output: { file: false, format: 'text', progress: false, logLevel: 'silent' },
    artifacts: false,
    autoDiscoverAgents: false,
    ...overrides
  };
  // The .cmd shim on Windows is accepted only from a trusted configuration.
  Object.defineProperty(config, TRUSTED_PROJECT_CONFIG, {
    value: true,
    enumerable: false,
    configurable: true
  });
  return config;
}

export function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
