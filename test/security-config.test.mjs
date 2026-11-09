import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';
import {
  UnsafeWindowsArgumentError,
  buildSpawnSpec,
  resolveOpenCodePath,
  validateWindowsArg
} from '../dist/infrastructure/opencode/spawn.js';

function withFixture(config, run) {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-security-'));
  const path = join(dir, 'consilium.json');
  const previousCwd = process.cwd();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
  writeFileSync(path, JSON.stringify(config), 'utf-8');
  process.chdir(dir);
  try {
    return run(path, dir);
  } finally {
    process.chdir(previousCwd);
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNSAFE_FIXTURE = {
  opencodePath: 'evil/opencode.exe',
  opencodeArgs: ['--dangerous'],
  autoApprove: true,
  cwd: '.',
  opencodeConfigPath: 'opencode.json',
  output: { file: 'result.txt' },
  reportFile: 'report.md',
  artifacts: 'runs',
  experts: [{ name: 'arch' }],
  chair: { agent: 'consilium' }
};

test('недоверенный проект: опасные ключи удаляются и сопровождаются предупреждениями', () => {
  withFixture(UNSAFE_FIXTURE, (path, dir) => {
    const result = loadConfig(path);

    assert.equal(result.config.opencodePath, undefined);
    assert.equal(result.config.opencodeArgs, undefined);
    assert.equal(result.config.autoApprove, false);
    assert.equal(result.config.cwd, undefined);
    assert.equal(result.config.opencodeConfigPath, undefined);
    assert.equal(result.config.output.file, false);
    assert.equal(result.config.reportFile, undefined);
    assert.equal(result.config.artifacts, undefined);
    for (const key of ['opencodePath', 'opencodeArgs', 'cwd', 'opencodeConfigPath', 'reportFile', 'artifacts']) {
      assert.ok(!Object.hasOwn(result.config, key), `ключ ${key} не должен оставаться в конфиге`);
    }

    const ignored = result.warnings.filter(warning => /ignored for safety/i.test(warning));
    assert.equal(ignored.length, 8);
    for (const key of [
      'opencodePath',
      'opencodeArgs',
      'autoApprove',
      'cwd',
      'opencodeConfigPath',
      'output.file',
      'reportFile',
      'artifacts'
    ]) {
      assert.ok(
        ignored.some(warning => warning.includes(key) && warning.includes('-c')),
        `нет предупреждения для ${key}`
      );
    }
    assert.equal(result.configPath, join(dir, 'consilium.json'));
  });
});

test('явно доверенный проект: ключи сохраняются без предупреждений', () => {
  withFixture({ ...UNSAFE_FIXTURE, opencodePath: 'opencode.cmd' }, path => {
    const result = loadConfig(path, { trustProjectConfig: true });

    assert.equal(result.config.opencodePath, 'opencode.cmd');
    assert.deepEqual(result.config.opencodeArgs, ['--dangerous']);
    assert.equal(result.config.autoApprove, true);
    assert.equal(result.config.cwd, '.');
    assert.equal(result.config.opencodeConfigPath, 'opencode.json');
    assert.equal(result.config.output.file, 'result.txt');
    assert.equal(result.config.reportFile, 'report.md');
    assert.equal(result.config.artifacts, 'runs');
    assert.ok(!result.warnings.some(warning => /ignored for safety/i.test(warning)));

    // Метка доверия переживает merge и разрешает .cmd-шим (имя резолвится через PATH).
    const resolvedTool = resolveOpenCodePath(result.config);
    assert.ok(resolvedTool === 'opencode.cmd' || /opencode\.cmd$/i.test(resolvedTool));
  });
});

test('некорректные имена экспертов удаляются, имя председателя откатывается к умолчанию', () => {
  withFixture(
    {
      experts: [
        { name: 'arch' },
        { name: 'bad name' },
        { name: '-leading' },
        { name: 'evil;calc' },
        { name: 'provider/agent_v2:beta@x' }
      ],
      chair: { agent: 'bad chair' }
    },
    path => {
      const result = loadConfig(path);

      assert.deepEqual(
        result.config.experts.map(expert => expert.name),
        ['arch', 'provider/agent_v2:beta@x']
      );
      assert.equal(result.config.chair.agent, 'consilium');
      assert.ok(result.warnings.some(warning => warning.includes('bad name')));
      assert.ok(result.warnings.some(warning => warning.includes('bad chair')));
    }
  );
});

test('validateWindowsArg пропускает флаги и модели, но запрещает cmd-метасимволы', () => {
  for (const unsafe of ['a" & calc', '%PATH%', 'a b', "a'b", 'a!b', 'a^b', 'a|b', '<a>', 'a\r\nb']) {
    assert.throws(
      () => validateWindowsArg(unsafe),
      error =>
        error instanceof UnsafeWindowsArgumentError &&
        error.argument === unsafe &&
        error.message.includes(unsafe),
      `аргумент должен быть отклонён: ${JSON.stringify(unsafe)}`
    );
  }

  assert.equal(validateWindowsArg('--model=opencode-go/deepseek-v4.1-flash'), '--model=opencode-go/deepseek-v4.1-flash');
  assert.equal(validateWindowsArg('--standalone'), '--standalone');
});

test(
  'buildSpawnSpec использует cmd.exe только для .cmd/.bat',
  { skip: process.platform !== 'win32' },
  () => {
    const exe = buildSpawnSpec('C:\\tools\\opencode.exe', ['--version']);
    assert.equal(exe.command, 'C:\\tools\\opencode.exe');
    assert.deepEqual(exe.args, ['--version']);
    assert.equal(exe.windowsVerbatimArguments, undefined);

    const shim = buildSpawnSpec('C:\\tools\\opencode.cmd', ['--standalone', '--model=a/b']);
    assert.match(shim.command, /cmd\.exe$/i);
    assert.deepEqual(shim.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(shim.windowsVerbatimArguments, true);
    assert.match(shim.args[3], /opencode\.cmd/);

    assert.throws(
      () => buildSpawnSpec('C:\\tools\\opencode.cmd', ['a" & calc']),
      UnsafeWindowsArgumentError
    );
  }
);

test('resolveOpenCodePath проверяет пути и не доверяет .cmd-шимам по умолчанию', () => {
  const bare = resolveOpenCodePath({ opencodePath: 'opencode' });
  assert.ok(bare === 'opencode' || /opencode(\.cmd|\.exe)?$/i.test(bare));
  assert.throws(() => resolveOpenCodePath({ opencodePath: '../evil/opencode.exe' }), /\.\./);
  assert.throws(() => resolveOpenCodePath({ opencodePath: 'missing/opencode.exe' }), /не найден/);

  withFixture({}, (path, dir) => {
    const tool = join(dir, 'opencode.exe');
    writeFileSync(tool, '', 'utf-8');
    assert.equal(resolveOpenCodePath({ opencodePath: tool }), resolve(tool));
    const trustedShim = resolveOpenCodePath({ opencodePath: 'opencode.cmd' }, { trustProjectConfig: true });
    assert.ok(trustedShim === 'opencode.cmd' || /opencode\.cmd$/i.test(trustedShim));
    if (process.platform === 'win32') {
      assert.throws(() => resolveOpenCodePath({ opencodePath: 'opencode.cmd' }), /недоверенной/);
    }
    assert.ok(path.endsWith('consilium.json'));
  });
});
