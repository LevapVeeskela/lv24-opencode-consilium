import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateExampleConfig } from '../dist/config.js';
import { DEFAULT_CONFIG } from '../dist/defaults.js';
import { DEFAULT_VERSION } from '../dist/interfaces/mcp/protocol.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const example = JSON.parse(
  readFileSync(new URL('../consilium.config.example.json', import.meta.url), 'utf8')
);
const workflow = readFileSync(
  new URL('../.github/workflows/container.yml', import.meta.url),
  'utf8'
);
const pyproject = readFileSync(new URL('../python/pyproject.toml', import.meta.url), 'utf8');
const pyInit = readFileSync(
  new URL('../python/src/lv24_opencode_consilium/__init__.py', import.meta.url),
  'utf8'
);
const llms = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const readmeRu = readFileSync(new URL('../docs/README.ru.md', import.meta.url), 'utf8');
const readmeZh = readFileSync(new URL('../docs/README.zh.md', import.meta.url), 'utf8');

test('version is single-sourced across package, config, MCP and docs', () => {
  const version = pkg.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);

  assert.equal(DEFAULT_CONFIG.version, version, 'DEFAULT_CONFIG.version');
  assert.equal(DEFAULT_VERSION, version, 'MCP DEFAULT_VERSION');
  assert.equal(example.version, version, 'consilium.config.example.json');
  assert.equal(JSON.parse(generateExampleConfig()).version, version, 'generateExampleConfig');

  const pyprojectVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert.equal(pyprojectVersion, version, 'python/pyproject.toml version');
  const pyInitVersion = pyInit.match(/^__version__\s*=\s*"([^"]+)"/m)?.[1];
  assert.equal(pyInitVersion, version, 'python __version__');

  assert.ok(llms.includes(`Version: ${version}`), 'llms.txt version');
  assert.ok(llms.includes(`:${version}`), 'llms.txt container tag');
  assert.ok(workflow.includes(`default: "${version}"`), 'container workflow default');
  assert.ok(readme.includes(`:${version}`), 'README container tag');
  assert.ok(readmeRu.includes(`:${version}`), 'ru README container tag');
  assert.ok(readmeZh.includes(`:${version}`), 'zh README container tag');
});
