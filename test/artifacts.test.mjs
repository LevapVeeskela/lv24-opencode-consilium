import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createArtifactId,
  diffArtifacts,
  formatArtifact,
  listArtifacts,
  loadArtifact,
  resolveArtifactRoot,
  saveArtifact
} from '../dist/artifacts.js';

function makeRun(id, overrides = {}) {
  return {
    version: 1,
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    task: 'Задача',
    success: true,
    text: 'Итог',
    experts: [
      { agent: 'alpha', model: 'p/a', success: true, text: 'ответ один' }
    ],
    models: { alpha: 'p/a' },
    ...overrides
  };
}

function makeTemp() {
  return mkdtempSync(path.join(tmpdir(), 'consilium-artifacts-'));
}

test('loadArtifact не читает JSON вне каталога артефактов', () => {
  const root = makeTemp();
  try {
    const outside = path.join(path.dirname(root), `outside-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify(makeRun('outside')), 'utf8');

    assert.throws(() => loadArtifact(outside, root), /вне каталога артефактов/);
    assert.throws(() => loadArtifact(`../${path.basename(outside)}`, root), /вне каталога артефактов/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('createArtifactId возвращает формат UTC YYYYMMDD-HHMMSS-hex', () => {
  const id = createArtifactId(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
  assert.match(id, /^20260102-030405-[0-9a-f]{4}$/);
});

test('resolveArtifactRoot: true/undefined → .consilium/runs, строка → resolve, false → throw', () => {
  const cwd = makeTemp();
  try {
    assert.equal(resolveArtifactRoot({ cwd }), path.resolve(cwd, '.consilium', 'runs'));
    assert.equal(resolveArtifactRoot({ artifacts: true, cwd }), path.resolve(cwd, '.consilium', 'runs'));
    assert.equal(resolveArtifactRoot({ artifacts: 'out', cwd }), path.resolve(cwd, 'out'));
    assert.throws(() => resolveArtifactRoot({ artifacts: false, cwd }), /отключено/);
  } finally {
    cleanup(cwd);
  }
});

test('save/list/load roundtrip', () => {
  const root = makeTemp();
  try {
    const run = makeRun('20260101-000000-ab12');
    const ref = saveArtifact(run, { root });
    assert.equal(ref.id, run.id);
    assert.ok(path.isAbsolute(ref.dir));
    assert.ok(existsSync(path.join(ref.dir, 'run.json')));
    assert.ok(existsSync(path.join(ref.dir, 'report.md')));
    assert.ok(existsSync(path.join(ref.dir, 'experts', 'alpha.md')));

    const refs = listArtifacts(root);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, run.id);

    const loaded = loadArtifact(run.id, root);
    assert.equal(loaded.id, run.id);
    assert.equal(loaded.text, 'Итог');

    const byPath = loadArtifact(ref.dir, root);
    assert.equal(byPath.id, run.id);
    const byFile = loadArtifact(path.join(ref.dir, 'run.json'), root);
    assert.equal(byFile.id, run.id);
  } finally {
    cleanup(root);
  }
});

test('saveArtifact очищает имя агента для файла', () => {
  const root = makeTemp();
  try {
    const run = makeRun('20260101-000000-ab13', {
      experts: [{ agent: '../../evil:x', success: true, text: 't' }]
    });
    const ref = saveArtifact(run, { root });
    const files = existsSync(path.join(ref.dir, 'experts'));
    assert.ok(files);
    const stored = readFileSync(path.join(ref.dir, 'run.json'), 'utf8');
    assert.ok(stored.includes('evil'));
    // В имени файла не должно быть разделителей
    const evilPath = path.join(ref.dir, 'experts', 'evil_x.md');
    const altPath = path.join(ref.dir, 'experts', '.._.._evil_x.md');
    assert.ok(existsSync(evilPath) || existsSync(altPath));
  } finally {
    cleanup(root);
  }
});

test('saveArtifact добавляет суффикс при коллизии id', () => {
  const root = makeTemp();
  try {
    const run = makeRun('20260101-000000-ab14');
    const first = saveArtifact(run, { root });
    const second = saveArtifact(run, { root });
    assert.equal(first.id, '20260101-000000-ab14');
    assert.equal(second.id, '20260101-000000-ab14-2');
    assert.ok(existsSync(second.dir));
    const loaded = loadArtifact(second.id, root);
    assert.equal(loaded.id, second.id);
  } finally {
    cleanup(root);
  }
});

test('loadArtifact отклоняет path traversal', () => {
  const root = makeTemp();
  try {
    assert.throws(() => loadArtifact('..', root), /Некорректный|не найден|вне каталога/);
    assert.throws(() => loadArtifact('../evil', root), /Некорректный|не найден|вне каталога/);
    assert.throws(() => loadArtifact('a/b', root), /Некорректный|не найден|вне каталога/);
  } finally {
    cleanup(root);
  }
});

test('loadArtifact бросает понятную ошибку для отсутствующего', () => {
  const root = makeTemp();
  try {
    assert.throws(() => loadArtifact('no-such-id', root), /не найден/);
  } finally {
    cleanup(root);
  }
});

test('listArtifacts игнорирует битые каталоги и сортирует новые сверху', () => {
  const root = makeTemp();
  try {
    saveArtifact(makeRun('20260101-000000-aa01', { createdAt: '2026-01-01T00:00:00.000Z' }), { root });
    saveArtifact(makeRun('20260102-000000-aa02', { createdAt: '2026-01-02T00:00:00.000Z' }), { root });
    const broken = path.join(root, 'broken-dir');
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, 'run.json'), 'not json{', 'utf8');
    const refs = listArtifacts(root);
    assert.equal(refs.length, 2);
    assert.equal(refs[0].id, '20260102-000000-aa02');
    assert.equal(refs[1].id, '20260101-000000-aa01');
  } finally {
    cleanup(root);
  }
});

test('diffArtifacts показывает changed/added/removed экспертов', () => {
  const a = makeRun('id-a', {
    task: 'Одна задача',
    text: 'старый итог',
    experts: [
      { agent: 'same', success: true, text: 'xxx' },
      { agent: 'changed', success: true, text: 'abc' },
      { agent: 'gone', success: true, text: 'bye' }
    ],
    models: { same: 'm1', changed: 'm1', gone: 'm1' }
  });
  const b = makeRun('id-b', {
    task: 'Другая задача',
    text: 'новый итог подлиннее',
    experts: [
      { agent: 'same', success: true, text: 'xxx' },
      { agent: 'changed', success: true, text: 'abcdef' },
      { agent: 'fresh', success: false, text: 'hi' }
    ],
    models: { same: 'm1', changed: 'm2', fresh: 'm3' }
  });
  const diff = diffArtifacts(a, b);
  assert.ok(diff.includes('ИЗМЕНИЛАСЬ'));
  assert.ok(diff.includes('без изменений')); // эксперт same
  assert.ok(diff.includes('изменён')); // эксперт changed
  assert.ok(diff.includes('добавлен')); // fresh
  assert.ok(diff.includes('удалён')); // gone
});

test('formatArtifact содержит разделы и обрезает длинные тексты', () => {
  const run = makeRun('20260101-000000-ff00', {
    experts: [{ agent: 'e1', model: 'm', success: true, text: 'x'.repeat(5000), usage: { inputTokens: 1, cost: 0.1 } }],
    usage: { inputTokens: 10, outputTokens: 5 }
  });
  const md = formatArtifact(run);
  assert.ok(md.includes('Задача'));
  assert.ok(md.includes('Модели'));
  assert.ok(md.includes('Эксперты'));
  assert.ok(md.includes('Итог'));
  assert.ok(md.includes('Расход'));
  assert.ok(md.includes('обрезано'));
});

test('loadArtifact отклоняет некорректный JSON shape', () => {
  const root = makeTemp();
  try {
    const dir = path.join(root, 'bad-shape');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ id: 'x' }), 'utf8');
    assert.throws(() => loadArtifact('bad-shape', root), /Некорректный/);
  } finally {
    cleanup(root);
  }
});
