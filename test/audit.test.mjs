import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getCommitRangeDiff } from '../dist/infrastructure/git.js';
import {
  DEFAULT_AUDIT_TASK,
  buildAuditRequest,
  formatAuditSummary
} from '../dist/application/audit.js';

function mkTemp(prefix = 'consilium-audit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, relativePath, content) {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function createRepo(t) {
  const root = mkTemp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'audit@example.test']);
  git(root, ['config', 'user.name', 'Audit Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  return root;
}

function createRepoWithCommits(t) {
  const root = createRepo(t);

  writeFile(root, 'src/app.ts', 'export const version = 1;\n');
  writeFile(root, 'keep.txt', 'keep\n');
  git(root, ['add', '-f', '.']);
  git(root, ['commit', '-qm', 'initial']);

  writeFile(
    root,
    'src/app.ts',
    'export const version = 2;\nexport const hello = "Привет, мир";\n'
  );
  writeFile(root, 'src/new.ts', 'export const added = true;\n');
  git(root, ['add', '-f', '.']);
  git(root, ['commit', '-qm', 'second']);

  return root;
}

function sorted(values) {
  return [...values].sort();
}

test('getCommitRangeDiff возвращает изменённые файлы и diff для HEAD~1', async t => {
  const root = createRepoWithCommits(t);

  const result = await getCommitRangeDiff('HEAD~1', { cwd: root });

  assert.equal(result.truncated, false);
  assert.deepEqual(sorted(result.files), ['src/app.ts', 'src/new.ts']);
  assert.match(result.diff, /^diff --git /m);
  assert.match(result.diff, /\+export const version = 2;/);
  assert.match(result.diff, /\+export const added = true;/);
  assert.match(result.diff, /\+export const hello = "Привет, мир";/);
});

test('getCommitRangeDiff без изменений возвращает пустой diff', async t => {
  const root = createRepoWithCommits(t);

  const result = await getCommitRangeDiff('HEAD', { cwd: root });

  assert.equal(result.diff, '');
  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, false);
});

test('getCommitRangeDiff отклоняет неизвестный ref понятной ошибкой', async t => {
  const root = createRepoWithCommits(t);

  await assert.rejects(
    () => getCommitRangeDiff('no-such-ref', { cwd: root }),
    error => {
      assert.equal(error.name, 'GitRefError');
      assert.match(error.message, /Неизвестный git ref/);
      assert.doesNotMatch(error.message, /fatal:/);
      return true;
    }
  );
});

test('getCommitRangeDiff отклоняет небезопасный ref до запуска git', async t => {
  const root = createRepoWithCommits(t);

  await assert.rejects(
    () => getCommitRangeDiff('--upload-pack=touch /tmp/pwned', { cwd: root }),
    /Недопустимый git ref/
  );

  await assert.rejects(
    () => getCommitRangeDiff('HEAD; rm -rf /', { cwd: root }),
    /Недопустимый git ref/
  );
});

test('getCommitRangeDiff объясняет отсутствие git-репозитория', async t => {
  const dir = mkTemp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => getCommitRangeDiff('HEAD', { cwd: dir }),
    error => {
      assert.equal(error.name, 'GitRefError');
      assert.match(error.message, /не является git-репозиторием/);
      assert.doesNotMatch(error.message, /fatal:/);
      return true;
    }
  );
});

test('getCommitRangeDiff помечает усечение по maxChars', async t => {
  const root = createRepoWithCommits(t);

  const result = await getCommitRangeDiff('HEAD~1', { cwd: root, maxChars: 40 });

  assert.equal(result.truncated, true);
  assert.match(result.diff, /diff truncated at/);
  // Список файлов парсится по полному выводу, а не по обрезанному diff.
  assert.deepEqual(sorted(result.files), ['src/app.ts', 'src/new.ts']);
});

test('buildAuditRequest формирует задачу с diff и маркерами недоверенных данных', async t => {
  const root = createRepoWithCommits(t);

  const request = await buildAuditRequest({ since: 'HEAD~1', cwd: root });

  assert.equal(request.ref, 'HEAD~1');
  assert.equal(request.truncated, false);
  assert.deepEqual(sorted(request.files), ['src/app.ts', 'src/new.ts']);
  assert.match(request.task, /Audit the changes since HEAD~1/);
  assert.match(request.task, /<untrusted-diff>/);
  assert.match(request.task, /<\/untrusted-diff>/);
  assert.match(request.task, /\+export const added = true;/);
  assert.match(request.task, /баги/);
  assert.match(request.diff, /\+export const added = true;/);
});

test('buildAuditRequest использует пользовательскую инструкцию', async t => {
  const root = createRepoWithCommits(t);

  const request = await buildAuditRequest({
    since: 'HEAD~1',
    cwd: root,
    task: 'Проверь только безопасность.'
  });

  assert.match(request.task, /Проверь только безопасность\./);
  assert.doesNotMatch(request.task, /Найди баги/);
});

test('buildAuditRequest помечает усечённый diff', async t => {
  const root = createRepoWithCommits(t);

  const request = await buildAuditRequest({
    since: 'HEAD~1',
    cwd: root,
    maxChars: 40
  });

  assert.equal(request.truncated, true);
  assert.match(request.task, /diff обрезан/i);
  assert.deepEqual(sorted(request.files), ['src/app.ts', 'src/new.ts']);
});

test('formatAuditSummary показывает ref, число файлов и усечение', () => {
  const request = {
    ref: 'HEAD~1',
    task: '',
    diff: '',
    files: ['src/app.ts', 'src/new.ts'],
    truncated: false
  };

  const summary = formatAuditSummary(request);
  assert.match(summary, /HEAD~1/);
  assert.match(summary, /2/);
  assert.match(summary, /diff полный/);
  assert.doesNotMatch(summary, /обрезан/);

  const truncated = formatAuditSummary({ ...request, truncated: true });
  assert.match(truncated, /diff обрезан/);
});

test('DEFAULT_AUDIT_TASK требует искать баги, безопасность и тесты', () => {
  assert.match(DEFAULT_AUDIT_TASK, /баги/i);
  assert.match(DEFAULT_AUDIT_TASK, /безопасности/i);
  assert.match(DEFAULT_AUDIT_TASK, /тесты/i);
});
