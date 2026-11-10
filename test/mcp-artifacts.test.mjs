import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMcpTools, handleMcpRequest } from '../dist/mcp.js';

function tempProject(prefix = 'consilium-mcp-artifacts-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.consilium', 'runs'), { recursive: true });
  return dir;
}

function runFixture(id, createdAt, overrides = {}) {
  return {
    version: 1,
    id,
    createdAt,
    task: `task ${id}`,
    success: true,
    text: `text ${id}`,
    experts: [],
    models: {},
    ...overrides
  };
}

function writeRun(project, run) {
  const dir = join(project, '.consilium', 'runs', run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2), 'utf8');
  return dir;
}

function callTool(name, args = {}) {
  return handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  });
}

async function withCwd(directory, run) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

function resultJson(response) {
  assert.notEqual(response.result?.isError, true, response.result?.content?.[0]?.text);
  return JSON.parse(response.result.content[0].text);
}

function errorText(response) {
  assert.equal(response.result?.isError, true, JSON.stringify(response));
  return response.result.content[0].text;
}

const FINDINGS_METADATA = {
  findings: {
    items: [
      { claim: 'SQL injection in login', severity: 'high', category: 'security' },
      { claim: 'Missing regression test', severity: 'medium', category: 'tests' }
    ]
  }
};

test('consilium_list_runs: новые первыми, limit и сводка находок', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  writeRun(project, runFixture('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z'));
  writeRun(project, runFixture('20260102-000000-bbbb', '2026-01-02T00:00:00.000Z'));
  writeRun(
    project,
    runFixture('20260103-000000-cccc', '2026-01-03T00:00:00.000Z', {
      metadata: FINDINGS_METADATA
    })
  );

  await withCwd(project, async () => {
    const response = await callTool('consilium_list_runs', { limit: 2 });
    const payload = resultJson(response);

    assert.deepEqual(
      payload.runs.map(run => run.id),
      ['20260103-000000-cccc', '20260102-000000-bbbb']
    );
    assert.equal(payload.runs[0].task, 'task 20260103-000000-cccc');
    assert.equal(payload.runs[0].success, true);
    assert.equal(
      payload.runs[0].path,
      join(project, '.consilium', 'runs', '20260103-000000-cccc')
    );
    assert.deepEqual(payload.runs[0].findings, {
      total: 2,
      counts: { critical: 0, high: 1, medium: 1, low: 0, info: 0 }
    });
    assert.equal('findings' in payload.runs[1], false);
  });
});

test('consilium_list_runs: пустой каталог и неверный limit', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  await withCwd(project, async () => {
    const payload = resultJson(await callTool('consilium_list_runs'));
    assert.deepEqual(payload, { runs: [] });

    for (const limit of [0, 101, 1.5, '5']) {
      const text = errorText(await callTool('consilium_list_runs', { limit }));
      assert.match(text, /limit/);
    }
  });
});

test('consilium_get_run: latest, id и ошибки без побега из каталога', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  writeRun(project, runFixture('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z'));
  const newest = runFixture('20260102-000000-bbbb', '2026-01-02T00:00:00.000Z', {
    text: 'newest text'
  });
  writeRun(project, newest);

  await withCwd(project, async () => {
    const latest = resultJson(await callTool('consilium_get_run'));
    assert.equal(latest.id, '20260102-000000-bbbb');
    assert.equal(latest.text, 'newest text');

    const byId = resultJson(
      await callTool('consilium_get_run', { run: '20260101-000000-aaaa' })
    );
    assert.equal(byId.id, '20260101-000000-aaaa');

    assert.match(errorText(await callTool('consilium_get_run', { run: 'missing' })), /Cannot load run/);
    assert.match(
      errorText(await callTool('consilium_get_run', { run: '../outside' })),
      /saved run id or "latest"/
    );
    assert.match(errorText(await callTool('consilium_get_run', { run: 42 })), /must be a string/);
  });
});

test('consilium_get_run: пустой каталог даёт понятную ошибку', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  await withCwd(project, async () => {
    assert.match(errorText(await callTool('consilium_get_run')), /No saved runs found/);
    assert.match(errorText(await callTool('consilium_sarif')), /No saved runs found/);
  });
});

test('consilium_sarif: пустые находки дают валидный SARIF 2.1.0', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  writeRun(project, runFixture('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z'));

  await withCwd(project, async () => {
    const response = await callTool('consilium_sarif', { run: '20260101-000000-aaaa' });
    const document = resultJson(response);

    assert.equal(document.version, '2.1.0');
    assert.match(document.$schema, /sarif-2\.1\.0/);
    assert.equal(document.runs.length, 1);
    assert.deepEqual(document.runs[0].results, []);
    assert.ok(document.runs[0].tool.driver.version);
  });
});

test('consilium_sarif: находки попадают в results, latest по умолчанию', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  writeRun(project, runFixture('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z'));
  writeRun(
    project,
    runFixture('20260102-000000-bbbb', '2026-01-02T00:00:00.000Z', {
      metadata: FINDINGS_METADATA
    })
  );

  await withCwd(project, async () => {
    const document = resultJson(await callTool('consilium_sarif'));
    const results = document.runs[0].results;

    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map(result => result.level),
      ['error', 'warning']
    );
    assert.ok(results.every(result => result.ruleId.startsWith('consilium/')));
  });
});

test('consilium_sarif: output_file пишется атомарно внутри workspace', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  writeRun(
    project,
    runFixture('20260102-000000-bbbb', '2026-01-02T00:00:00.000Z', {
      metadata: FINDINGS_METADATA
    })
  );

  await withCwd(project, async () => {
    const response = await callTool('consilium_sarif', {
      output_file: join('reports', 'consilium.sarif')
    });
    const payload = resultJson(response);
    const expected = join(project, 'reports', 'consilium.sarif');

    assert.equal(payload.path, expected);
    assert.equal(payload.run, '20260102-000000-bbbb');
    assert.equal(payload.findings, 2);
    assert.ok(existsSync(expected));

    const document = JSON.parse(readFileSync(expected, 'utf8'));
    assert.equal(document.version, '2.1.0');
    assert.equal(document.runs[0].results.length, 2);
  });
});

test('consilium_sarif: output_file не выходит за пределы workspace', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  writeRun(project, runFixture('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z'));

  await withCwd(project, async () => {
    for (const output of ['../outside.sarif', join(tmpdir(), 'consilium-outside.sarif')]) {
      const text = errorText(await callTool('consilium_sarif', { output_file: output }));
      assert.match(text, /inside the workspace/);
    }
    assert.equal(existsSync(join(project, '..', 'outside.sarif')), false);
    assert.match(
      errorText(await callTool('consilium_sarif', { output_file: 42 })),
      /must be a string/
    );
  });
});

test('consilium_diff_runs: markdown-сравнение двух запусков', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  writeRun(
    project,
    runFixture('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z', {
      experts: [{ agent: 'arch', success: true, text: 'short' }],
      models: { arch: 'openai/gpt-4o' }
    })
  );
  writeRun(
    project,
    runFixture('20260102-000000-bbbb', '2026-01-02T00:00:00.000Z', {
      task: 'other task',
      experts: [{ agent: 'arch', success: true, text: 'longer text' }],
      models: { arch: 'anthropic/claude-sonnet' }
    })
  );

  await withCwd(project, async () => {
    const response = await callTool('consilium_diff_runs', {
      left: '20260101-000000-aaaa',
      right: '20260102-000000-bbbb'
    });
    assert.notEqual(response.result.isError, true);
    const text = response.result.content[0].text;

    assert.match(text, /# Сравнение запусков: 20260101-000000-aaaa ↔ 20260102-000000-bbbb/);
    assert.match(text, /Задача: ИЗМЕНИЛАСЬ/);
    assert.match(text, /openai\/gpt-4o/);
    assert.match(text, /anthropic\/claude-sonnet/);
  });
});

test('consilium_diff_runs: обязательные и невалидные аргументы', async t => {
  const project = tempProject();
  t.after(() => rmSync(project, { recursive: true, force: true }));

  writeRun(project, runFixture('20260101-000000-aaaa', '2026-01-01T00:00:00.000Z'));

  await withCwd(project, async () => {
    assert.match(
      errorText(await callTool('consilium_diff_runs', { left: '20260101-000000-aaaa' })),
      /"right" is required/
    );
    assert.match(
      errorText(
        await callTool('consilium_diff_runs', {
          left: '20260101-000000-aaaa',
          right: 'missing'
        })
      ),
      /Cannot load run "missing"/
    );
    assert.match(
      errorText(await callTool('consilium_diff_runs', { left: 1, right: 'x' })),
      /"left" must be a string/
    );
  });
});

test('схемы artifact-инструментов и неизвестный tool', async () => {
  const tools = getMcpTools();
  const byName = new Map(tools.map(tool => [tool.name, tool]));

  const list = byName.get('consilium_list_runs');
  assert.equal(list.inputSchema.properties.limit.type, 'integer');
  assert.equal(list.inputSchema.properties.limit.minimum, 1);
  assert.equal(list.inputSchema.properties.limit.maximum, 100);
  assert.equal(list.inputSchema.properties.limit.default, 10);

  const get = byName.get('consilium_get_run');
  assert.equal(get.inputSchema.properties.run.default, 'latest');

  const sarif = byName.get('consilium_sarif');
  assert.equal(sarif.inputSchema.properties.run.default, 'latest');
  assert.ok(sarif.inputSchema.properties.output_file);

  const diff = byName.get('consilium_diff_runs');
  assert.deepEqual(diff.inputSchema.required, ['left', 'right']);

  const unknown = await callTool('consilium_missing_tool');
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /Unknown tool/);
});
