import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDoctorReport } from '../dist/doctor.js';
import { formatDiffForPrompt } from '../dist/git.js';

test('formatDoctorReport считает статусы и выносит вердикт', () => {
  const report = formatDoctorReport([
    { id: 'a', status: 'ok', message: 'ok' },
    { id: 'b', status: 'warn', message: 'warn', hint: 'hint' },
    { id: 'c', status: 'fail', message: 'fail' }
  ]);
  assert.match(report, /Итого: 1 ok, 1 warnings, 1 errors/);
  assert.match(report, /Вердикт: FAIL/);
  assert.match(report, /↳ hint/);
});

test('formatDiffForPrompt оборачивает diff в markdown', () => {
  const text = formatDiffForPrompt({ diff: 'diff --git a/x b/x', truncated: false, filesChanged: 1 });
  assert.match(text, /```diff/);
  assert.match(text, /diff --git/);
});

test('formatDiffForPrompt сообщает об усечении', () => {
  const text = formatDiffForPrompt({ diff: 'abc', truncated: true, filesChanged: 1 });
  assert.match(text, /обрезан/i);
});
