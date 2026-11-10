import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMcpServerEntry,
  describeConfigFlavor,
  detectConfigFlavor,
  findLegacyV1Fields,
  parseOpenCodeVersion,
  readAgentDefinition,
  readAgentSection,
  readMcpSection,
  splitModelRef,
  toModelRef,
  upsertAgents,
  upsertMcpServer
} from '../dist/compat.js';
import {
  loadConfig,
  loadOpenCodeAgents,
  resolveOpenCodeAgent,
  resolveOpenCodeAgentModel
} from '../dist/config.js';

test('parseOpenCodeVersion понимает v2, v1 и мусор', () => {
  assert.deepEqual(parseOpenCodeVersion('opencode v2.2.6'), {
    raw: 'opencode v2.2.6',
    version: '2.2.6',
    major: 2
  });
  assert.equal(parseOpenCodeVersion('1.18.3').major, 1);
  assert.equal(parseOpenCodeVersion('  opencode 2.0.0-beta  ').version, '2.0.0');
  assert.deepEqual(parseOpenCodeVersion('dev'), { raw: 'dev', version: null, major: null });
  assert.deepEqual(parseOpenCodeVersion(null), { raw: null, version: null, major: null });
});

test('detectConfigFlavor распознаёт нативные V2-ключи', () => {
  assert.equal(detectConfigFlavor({}), 'v1');
  assert.equal(detectConfigFlavor({ agent: { arch: {} } }), 'v1');
  assert.equal(detectConfigFlavor({ agents: {} }), 'v2');
  assert.equal(detectConfigFlavor({ commands: {} }), 'v2');
  assert.equal(detectConfigFlavor({ mcp: { servers: {} } }), 'v2');
  assert.equal(detectConfigFlavor({ skills: ['./skills'] }), 'v2');
  assert.equal(detectConfigFlavor({ mcp: { flat: { type: 'local' } } }), 'v1');
  assert.equal(describeConfigFlavor('v1'), 'V1 (совместим с V1 и V2)');
});

test('toModelRef и splitModelRef поддерживают строку и объект V2', () => {
  assert.equal(toModelRef('opencode/glm-5.3-flash-free'), 'opencode/glm-5.3-flash-free');
  assert.equal(
    toModelRef({ providerID: 'anthropic', model: 'claude-sonnet-5-5', variant: 'high' }),
    'anthropic/claude-sonnet-5-5#high'
  );
  assert.equal(toModelRef({ provider: 'p', model: 'm' }), 'p/m');
  assert.equal(toModelRef({ providerID: 'p' }), undefined);
  assert.equal(toModelRef('   '), undefined);
  assert.deepEqual(splitModelRef('p/m#high'), { model: 'p/m', variant: 'high' });
  assert.deepEqual(splitModelRef('p/m'), { model: 'p/m' });
});

test('readAgentDefinition понимает V1 и V2 поля', () => {
  const v1 = readAgentDefinition({ mode: 'primary', model: 'a/b', prompt: 'p' });
  assert.equal(v1.prompt, 'p');
  assert.equal(v1.nativeV2, false);
  assert.equal(v1.disabled, false);

  const v2 = readAgentDefinition({
    mode: 'subagent',
    model: { providerID: 'a', model: 'b' },
    system: 's',
    disabled: true,
    permissions: []
  });
  assert.equal(v2.prompt, 's');
  assert.equal(v2.nativeV2, true);
  assert.equal(v2.disabled, true);
  assert.equal(v2.model, 'a/b');

  assert.equal(readAgentDefinition({ disable: true }).disabled, true);
});

test('readAgentSection объединяет agent и agents, нативный V2 побеждает', () => {
  const section = readAgentSection({
    agent: {
      same: { model: 'v1/model', prompt: 'v1' },
      onlyV1: { model: 'v1/only' }
    },
    agents: {
      same: { model: 'v2/model', system: 'v2' },
      onlyV2: { model: 'v2/only' }
    }
  });

  assert.equal(section.flavor, 'v2');
  assert.equal(section.key, 'agents');
  assert.deepEqual(section.duplicated, ['same']);
  assert.equal(readAgentDefinition(section.entries.same).model, 'v2/model');
  assert.equal(section.entries.same.prompt, 'v1');
  assert.equal(section.entries.same.system, 'v2');
  assert.equal(readAgentDefinition(section.entries.onlyV1).model, 'v1/only');
  assert.equal(readAgentDefinition(section.entries.onlyV2).model, 'v2/only');
});

test('upsertAgents пишет V1-формат в agent с prompt', () => {
  const result = upsertAgents(
    { agent: { arch: { description: 'keep me', model: 'old/model' } } },
    { arch: { model: 'new/model', prompt: 'role prompt', mode: 'primary' } }
  );

  const arch = result.config.agent.arch;
  assert.equal(result.flavor, 'v1');
  assert.equal(result.written.arch, 'agent');
  assert.equal(arch.model, 'new/model');
  assert.equal(arch.prompt, 'role prompt');
  assert.equal(arch.description, 'keep me');
  assert.equal('system' in arch, false);
  assert.equal('agents' in result.config, false);
});

test('upsertAgents пишет V2-формат в agents с system', () => {
  const result = upsertAgents(
    { agents: { arch: { model: 'old/model', system: 'old' } } },
    { arch: { model: 'new/model', prompt: 'new' } }
  );

  const arch = result.config.agents.arch;
  assert.equal(result.flavor, 'v2');
  assert.equal(result.written.arch, 'agents');
  assert.equal(arch.model, 'new/model');
  assert.equal(arch.system, 'new');
  assert.equal('prompt' in arch, false);
});

test('upsertAgents обновляет обе записи, чтобы V2 не перекрыл V1', () => {
  const result = upsertAgents(
    {
      agent: { arch: { model: 'v1/old', prompt: 'v1' } },
      agents: { arch: { model: 'v2/old', system: 'v2' } }
    },
    { arch: { model: 'new/model', prompt: 'new' } }
  );

  assert.equal(result.written.arch, 'both');
  assert.equal(result.config.agent.arch.model, 'new/model');
  assert.equal(result.config.agents.arch.model, 'new/model');
  assert.equal(result.config.agent.arch.prompt, 'new');
  assert.equal(result.config.agents.arch.system, 'new');
  assert.equal(result.warnings.length, 1);
});

test('upsertAgents с migrate переносит агента в agents', () => {
  const result = upsertAgents(
    { agent: { arch: { model: 'old', prompt: 'p' }, other: { model: 'keep' } } },
    { arch: { model: 'new', prompt: 'p2' } },
    { flavor: 'v2', migrate: true }
  );

  assert.equal(result.config.agents.arch.model, 'new');
  assert.equal('arch' in result.config.agent, false);
  assert.equal(result.config.agent.other.model, 'keep');
  assert.ok(result.warnings.some(warning => warning.includes('перенесён')));
});

test('upsertAgents переносит disable в disabled при миграции', () => {
  const result = upsertAgents(
    { agent: { arch: { model: 'm', prompt: 'p', disable: true } } },
    { arch: { model: 'm2' } },
    { flavor: 'v2', migrate: true }
  );

  assert.equal(result.config.agents.arch.disabled, true);
  assert.equal('disable' in result.config.agents.arch, false);

  const back = upsertAgents(
    { agents: { arch: { model: 'm', system: 's', disabled: true } } },
    { arch: { model: 'm2' } },
    { flavor: 'v1' }
  );
  assert.equal(back.config.agents.arch.disabled, true);
});

test('upsertAgents переводит V1 tools/permission в V2 permissions', () => {
  const result = upsertAgents(
    {
      agent: {
        arch: {
          model: 'old',
          prompt: 'p',
          tools: { write: false, edit: false, bash: false, webfetch: false, task: false },
          permission: { read: 'allow', bash: { 'git push *': 'ask' }, edit: 'deny' }
        }
      }
    },
    { arch: { model: 'new' } },
    { flavor: 'v2', migrate: true }
  );

  const arch = result.config.agents.arch;
  assert.equal(result.written.arch, 'agents');
  assert.equal(result.config.agent, undefined);
  assert.equal('tools' in arch, false);
  assert.equal('permission' in arch, false);
  assert.equal(arch.system, 'p');

  const rules = arch.permissions;
  assert.ok(Array.isArray(rules));
  const has = (action, resource, effect) =>
    rules.some(rule => rule.action === action && rule.resource === resource && rule.effect === effect);

  assert.ok(has('edit', '*', 'deny'), 'write/edit -> edit deny');
  assert.ok(has('shell', '*', 'deny'), 'bash -> shell deny');
  assert.ok(has('webfetch', '*', 'deny'));
  assert.ok(has('subagent', '*', 'deny'), 'task -> subagent deny');
  assert.ok(has('read', '*', 'allow'));
  assert.ok(has('shell', 'git push *', 'ask'));
  assert.equal(
    rules.filter(rule => rule.action === 'edit' && rule.resource === '*' && rule.effect === 'deny')
      .length,
    1,
    'duplicate edit deny is deduped'
  );

  assert.ok(result.warnings.some(warning => warning.includes('permissions')));
  assert.ok(!result.warnings.some(warning => warning.includes('не перенесён')));
});

test('upsertAgents переводит массивы V1 permission', () => {
  const result = upsertAgents(
    {
      agent: {
        arch: {
          model: 'old',
          permission: {
            bash: [
              ['git push *', 'deny'],
              ['git status *', 'allow']
            ],
            edit: ['*.env', 'ask']
          }
        }
      }
    },
    { arch: { model: 'new' } },
    { flavor: 'v2', migrate: true }
  );

  const rules = result.config.agents.arch.permissions;
  assert.ok(Array.isArray(rules));
  const has = (action, resource, effect) =>
    rules.some(rule => rule.action === action && rule.resource === resource && rule.effect === effect);

  assert.ok(has('shell', 'git push *', 'deny'));
  assert.ok(has('shell', 'git status *', 'allow'));
  assert.ok(has('edit', '*.env', 'ask'));
});

test('upsertAgents переводит permission, заданный массивом правил', () => {
  const result = upsertAgents(
    {
      agent: {
        arch: {
          model: 'old',
          permission: [
            { action: 'bash', resource: 'rm *', effect: 'deny' },
            ['task', 'reviewer', 'ask']
          ]
        }
      }
    },
    { arch: { model: 'new' } },
    { flavor: 'v2', migrate: true }
  );

  const rules = result.config.agents.arch.permissions;
  assert.ok(Array.isArray(rules));
  assert.deepEqual(rules, [
    { action: 'shell', resource: 'rm *', effect: 'deny' },
    { action: 'subagent', resource: 'reviewer', effect: 'ask' }
  ]);
});

test('upsertAgents сохраняет нативные V2 permissions после переведённых', () => {
  const result = upsertAgents(
    {
      agent: { arch: { model: 'old', tools: { bash: false } } },
      agents: {
        arch: {
          model: 'old',
          system: 's',
          permissions: [{ action: 'shell', resource: 'git status *', effect: 'allow' }]
        }
      }
    },
    { arch: { model: 'new' } },
    { flavor: 'v2', migrate: true }
  );

  const rules = result.config.agents.arch.permissions;
  assert.deepEqual(rules[0], { action: 'shell', resource: '*', effect: 'deny' });
  assert.deepEqual(rules[1], { action: 'shell', resource: 'git status *', effect: 'allow' });
});

test('upsertAgents не мигрирует агента с temperature и предупреждает', () => {
  const result = upsertAgents(
    { agent: { arch: { model: 'old', prompt: 'p', temperature: 0.2 } } },
    { arch: { model: 'new' } },
    { flavor: 'v2', migrate: true }
  );

  assert.equal(result.written.arch, 'agent');
  assert.equal(result.config.agents, undefined);
  assert.equal(result.config.agent.arch.model, 'new');
  assert.equal(result.config.agent.arch.temperature, 0.2);
  assert.ok(result.warnings.some(warning => warning.includes('не перенесён')));
  assert.ok(result.warnings.some(warning => warning.includes('temperature')));
});

test('upsertAgents не мигрирует нераспознанную форму tools', () => {
  const result = upsertAgents(
    { agent: { arch: { model: 'old', tools: { write: 'no' } } } },
    { arch: { model: 'new' } },
    { flavor: 'v2', migrate: true }
  );

  assert.equal(result.written.arch, 'agent');
  assert.equal(result.config.agents, undefined);
  assert.deepEqual(result.config.agent.arch.tools, { write: 'no' });
  assert.ok(result.warnings.some(warning => warning.includes('tools')));
});

test('upsertAgents не мутирует исходный конфиг', () => {
  const original = { agent: { arch: { model: 'old' } } };
  const snapshot = JSON.parse(JSON.stringify(original));
  upsertAgents(original, { arch: { model: 'new' } });
  assert.deepEqual(original, snapshot);
});

test('upsertAgents не смешивает prompt и system внутри записи', () => {
  const toV2 = upsertAgents({ agents: { arch: { model: 'old', prompt: 'v1 field' } } }, {
    arch: { prompt: 'new' }
  });
  assert.equal(toV2.config.agents.arch.system, 'new');
  assert.equal('prompt' in toV2.config.agents.arch, false);

  const toV1 = upsertAgents({ agent: { arch: { model: 'old', system: 'v2 field' } } }, {
    arch: { prompt: 'new' }
  });
  assert.equal(toV1.config.agent.arch.prompt, 'new');
  assert.equal('system' in toV1.config.agent.arch, false);
});

test('readMcpSection разделяет плоские записи и mcp.servers', () => {
  const section = readMcpSection({
    mcp: {
      timeout: { startup: 1000 },
      flat: { type: 'local', command: ['x'] },
      servers: { native: { type: 'local', command: ['y'] } }
    }
  });

  assert.equal(section.flavor, 'v2');
  assert.deepEqual(Object.keys(section.flat), ['flat']);
  assert.deepEqual(Object.keys(section.servers), ['native']);
  assert.deepEqual(section.duplicated, []);
});

test('buildMcpServerEntry использует enabled в V1 и disabled в V2', () => {
  const v1 = buildMcpServerEntry('v1', { command: ['npx', 'x'], enabled: false });
  assert.equal(v1.enabled, false);
  assert.equal('disabled' in v1, false);

  const v2 = buildMcpServerEntry('v2', { command: ['npx', 'x'], enabled: false });
  assert.equal(v2.disabled, true);
  assert.equal('enabled' in v2, false);
  assert.equal(v2.type, 'local');
});

test('upsertMcpServer сохраняет существующие настройки сервера', () => {
  const result = upsertMcpServer(
    {
      mcp: {
        servers: {
          consilium: {
            type: 'local',
            command: ['old'],
            environment: { OPENROUTER_API_KEY: '{env:OPENROUTER_API_KEY}' },
            timeout: { execution: 600000 }
          }
        }
      }
    },
    'consilium',
    { command: ['npx', 'new'] }
  );

  const entry = result.config.mcp.servers.consilium;
  assert.deepEqual(entry.command, ['npx', 'new']);
  assert.deepEqual(entry.environment, { OPENROUTER_API_KEY: '{env:OPENROUTER_API_KEY}' });
  assert.deepEqual(entry.timeout, { execution: 600000 });
});

test('upsertMcpServer пишет в формат файла и предупреждает о плоской записи', () => {
  const v1 = upsertMcpServer({ mcp: {} }, 'consilium', { command: ['npx', 'x'] });
  assert.equal(v1.key, 'mcp');
  assert.deepEqual(v1.config.mcp.consilium.command, ['npx', 'x']);
  assert.equal('servers' in v1.config.mcp, false);

  const v2 = upsertMcpServer(
    { mcp: { servers: {}, consilium: { type: 'local', command: ['old'] } } },
    'consilium',
    { command: ['npx', 'y'] }
  );
  assert.equal(v2.key, 'mcp.servers');
  assert.deepEqual(v2.config.mcp.servers.consilium.command, ['npx', 'y']);
  assert.equal(v2.config.mcp.consilium.command[0], 'old');
  assert.equal(v2.warnings.length, 1);
});

test('findLegacyV1Fields перечисляет V1-поля без прямого эффекта в V2', () => {
  const fields = findLegacyV1Fields({
    theme: 'consilium',
    autoupdate: true,
    logLevel: 'info',
    model: 'a/b',
    agent: {}
  });
  assert.deepEqual(fields, ['theme', 'autoupdate', 'logLevel']);
});

test('loadOpenCodeAgents читает .opencode и родительские каталоги', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-compat-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    writeFileSync(
      join(root, '.opencode', 'opencode.json'),
      JSON.stringify({
        agents: {
          arch: { mode: 'primary', model: { providerID: 'opencode', model: 'glm-5.3-flash-free' }, system: 's' },
          hidden: { mode: 'subagent', model: 'a/b' }
        }
      }),
      'utf-8'
    );

    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });

    const snapshot = loadOpenCodeAgents({ cwd: nested });
    assert.ok(snapshot.path.endsWith(join('.opencode', 'opencode.json')));
    assert.equal(snapshot.section.flavor, 'v2');
    assert.equal(
      readAgentDefinition(snapshot.section.entries.arch).model,
      'opencode/glm-5.3-flash-free'
    );
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadOpenCodeAgents сливает слои: stub .opencode не скрывает агентов из корня', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-layers-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({
        agent: { arch: { mode: 'primary', model: 'root/model', prompt: 'root' } }
      }),
      'utf-8'
    );
    writeFileSync(
      join(root, '.opencode', 'opencode.json'),
      JSON.stringify({ $schema: 'https://opencode.ai/config.json' }),
      'utf-8'
    );

    const snapshot = loadOpenCodeAgents({ cwd: root });
    assert.ok(snapshot.files.includes(join(root, 'opencode.json')));
    assert.equal(snapshot.section.entries.arch.model, 'root/model');
    assert.equal(snapshot.section.flavor, 'v1');
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadOpenCodeAgents: .opencode родителя приоритетнее прямого файла ребёнка', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-precedence-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    const child = join(root, 'packages', 'app');
    mkdirSync(join(root, '.opencode'), { recursive: true });
    mkdirSync(child, { recursive: true });

    writeFileSync(
      join(child, 'opencode.json'),
      JSON.stringify({ model: 'child/root' }),
      'utf-8'
    );
    writeFileSync(
      join(root, '.opencode', 'opencode.json'),
      JSON.stringify({ agents: { arch: { model: 'parent/model', system: 's' } } }),
      'utf-8'
    );

    const snapshot = loadOpenCodeAgents({ cwd: child });
    assert.equal(snapshot.section.entries.arch.model, 'parent/model');
    assert.equal(snapshot.path, join(root, '.opencode', 'opencode.json'));
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadOpenCodeAgents не блокируется несуществующим opencodeConfigPath', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-fallback-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({ agents: { arch: { model: 'found/model', system: 's' } } }),
      'utf-8'
    );

    const snapshot = loadOpenCodeAgents({ cwd: root, opencodeConfigPath: 'missing.json' });
    assert.equal(snapshot.section.entries.arch.model, 'found/model');
    assert.match(snapshot.warning ?? '', /не найден/);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveOpenCodeAgent видит файловых агентов и встроенные', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-fileagent-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    mkdirSync(join(root, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'agents', 'custom.md'), '---\nmode: primary\n---\nbody', 'utf-8');

    assert.equal(resolveOpenCodeAgent('custom', { cwd: root }).exists, true);
    assert.equal(resolveOpenCodeAgent('missing', { cwd: root }).exists, false);
    assert.equal(resolveOpenCodeAgent('build', { cwd: root }).exists, true);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveOpenCodeAgentModel находит модель агента', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-model-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({
        agents: { arch: { model: { providerID: 'opencode', model: 'glm-5.3-flash-free' }, system: 's' } }
      }),
      'utf-8'
    );

    assert.equal(
      resolveOpenCodeAgentModel('arch', { cwd: root }),
      'opencode/glm-5.3-flash-free'
    );
    assert.equal(resolveOpenCodeAgentModel('missing', { cwd: root }), undefined);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadOpenCodeAgents: проектный agent перекрывает глобальный agents по имени', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-cross-layer-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const xdg = join(root, 'xdg');
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    writeFileSync(
      join(xdg, 'opencode', 'opencode.json'),
      JSON.stringify({
        agents: {
          arch: { mode: 'primary', model: 'global/agents-model', system: 'global' }
        }
      }),
      'utf-8'
    );
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({
        agent: { arch: { model: 'project/agent-model', prompt: 'project' } }
      }),
      'utf-8'
    );

    const snapshot = loadOpenCodeAgents({ cwd: root });
    assert.equal(snapshot.section.entries.arch.model, 'project/agent-model');
    assert.equal(snapshot.section.entries.arch.prompt, 'project');
    // mode из глобального слоя сохраняется: поля сливаются, модель побеждает по слою.
    assert.equal(snapshot.section.entries.arch.mode, 'primary');
    // Ключи из разных файлов — не дубликаты.
    assert.deepEqual(snapshot.section.duplicated, []);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadOpenCodeAgents: в одном файле agents побеждает agent, поля сливаются', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-same-layer-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({
        agent: {
          arch: { mode: 'primary', model: 'v1/model', prompt: 'v1' }
        },
        agents: {
          arch: { model: 'v2/model', system: 'v2' }
        }
      }),
      'utf-8'
    );

    const snapshot = loadOpenCodeAgents({ cwd: root });
    assert.equal(snapshot.section.entries.arch.model, 'v2/model');
    assert.equal(snapshot.section.entries.arch.mode, 'primary');
    assert.equal(snapshot.section.entries.arch.system, 'v2');
    assert.deepEqual(snapshot.section.duplicated, ['arch']);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadOpenCodeAgents возвращает ошибки отдельных файлов и продолжает со слоями', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-layer-error-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const xdg = join(root, 'xdg');
  const projectPath = join(root, 'opencode.json');
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    writeFileSync(
      join(xdg, 'opencode', 'opencode.json'),
      JSON.stringify({
        agents: { arch: { mode: 'primary', model: 'global/model', system: 's' } }
      }),
      'utf-8'
    );
    writeFileSync(projectPath, '{ "agent": { "arch": ', 'utf-8');

    const snapshot = loadOpenCodeAgents({ cwd: root });
    assert.equal(snapshot.section.entries.arch.model, 'global/model');
    assert.ok(snapshot.errors.some(error => error.includes(projectPath)));
    assert.equal(snapshot.config.agents.arch.model, 'global/model');
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig видит V2-агентов и не берёт subagent в эксперты', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-load-'));
  const previous = process.cwd();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'xdg');
  try {
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({
        agents: {
          arch: { mode: 'primary', model: 'opencode/glm-5.3-flash-free', system: 's' },
          hidden: { mode: 'subagent', model: 'a/b' },
          consilium: { mode: 'primary', model: 'opencode/deepseek-v4.1-flash-free', system: 'chair' }
        }
      }),
      'utf-8'
    );

    process.chdir(root);
    const loaded = loadConfig();
    assert.deepEqual(loaded.config.experts.map(expert => expert.name), ['arch']);
    assert.equal(loaded.config.experts[0].model, 'opencode/glm-5.3-flash-free');
    assert.equal(loaded.config.chair.model, 'opencode/deepseek-v4.1-flash-free');
  } finally {
    process.chdir(previous);
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(root, { recursive: true, force: true });
  }
});
