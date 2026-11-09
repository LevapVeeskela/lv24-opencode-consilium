import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_DEADLINE_MS,
  buildDeadlineChairNote,
  buildDeadlineFailureChair,
  buildDeadlineMetadata,
  runExpertPhaseWithDeadline,
  sanitizeDeadlineMs,
  summarizeDeadline,
  withDeadlineChairNote
} from '../dist/application/run.js';
import { Consilium } from '../dist/application/consilium.js';
import { mergeWithDefaults } from '../dist/config.js';

const TRUSTED_PROJECT_CONFIG = Symbol.for('lv24-opencode-consilium.trustedProjectConfig');

const failed = (agent, errorCode = 'CANCELLED') => ({
  agent,
  text: '',
  success: false,
  errorCode
});

test('sanitizeDeadlineMs: положительное целое, не больше 24 часов', () => {
  assert.equal(MAX_DEADLINE_MS, 24 * 60 * 60 * 1000);

  assert.equal(sanitizeDeadlineMs(undefined), undefined);
  assert.equal(sanitizeDeadlineMs(0), undefined);
  assert.equal(sanitizeDeadlineMs(-1), undefined);
  assert.equal(sanitizeDeadlineMs(Number.NaN), undefined);
  assert.equal(sanitizeDeadlineMs(Number.POSITIVE_INFINITY), undefined);

  assert.equal(sanitizeDeadlineMs(1), 1);
  assert.equal(sanitizeDeadlineMs(1500.9), 1500);
  assert.equal(sanitizeDeadlineMs(MAX_DEADLINE_MS + 1), MAX_DEADLINE_MS);
});

test('summarizeDeadline и buildDeadlineMetadata: completed/missing и форма metadata', () => {
  const experts = [
    { agent: 'build', text: 'ok', success: true },
    failed('plan'),
    failed('sec', 'TIMEOUT')
  ];
  const summary = summarizeDeadline(experts);
  assert.deepEqual(summary, {
    total: 3,
    completed: 1,
    missing: ['plan', 'sec']
  });
  assert.deepEqual(summarizeDeadline([]), { total: 0, completed: 0, missing: [] });

  assert.deepEqual(buildDeadlineMetadata(2000, true, summary), {
    limitMs: 2000,
    hit: true,
    completed: 1,
    missing: ['plan', 'sec']
  });

  // missing не должен быть общей ссылкой с исходной сводкой.
  const metadata = buildDeadlineMetadata(2000, false, summary);
  metadata.missing.push('extra');
  assert.deepEqual(summary.missing, ['plan', 'sec']);
});

test('buildDeadlineChairNote: короткая заметка для промпта председателя', () => {
  assert.equal(
    buildDeadlineChairNote({ total: 3, completed: 1, missing: ['plan', 'sec'] }),
    '1 of 3 experts finished before the deadline; missing: plan, sec'
  );
  assert.equal(
    buildDeadlineChairNote({ total: 1, completed: 1, missing: [] }),
    '1 of 1 experts finished before the deadline; missing: none'
  );
});

test('buildDeadlineFailureChair: код DEADLINE и понятное сообщение', () => {
  const chair = buildDeadlineFailureChair('general', 1500, {
    total: 2,
    completed: 0,
    missing: ['build', 'plan']
  });

  assert.equal(chair.agent, 'general');
  assert.equal(chair.success, false);
  assert.equal(chair.errorCode, 'DEADLINE');
  assert.match(chair.text, /Дедлайн/);
  assert.match(chair.text, /build, plan/);
  assert.match(chair.errorMessage, /председатель не запускался/);
  assert.match(chair.errorMessage, /build, plan/);
});

test('withDeadlineChairNote дополняет стандартный и пользовательский шаблон', () => {
  const note = '1 of 2 experts finished before the deadline; missing: plan';
  const successful = [{ agent: 'build', text: 'ответ', success: true }];

  const config = mergeWithDefaults({
    experts: [{ name: 'build' }],
    chair: { agent: 'general' }
  });
  const prompt = withDeadlineChairNote(config, note).chair.promptTemplate('задача', successful);
  assert.ok(prompt.endsWith(note));
  assert.match(prompt, /ответ/);
  assert.match(prompt, /задача/);

  const custom = mergeWithDefaults({
    experts: [{ name: 'build' }],
    chair: {
      agent: 'general',
      promptTemplate: (task, experts) => `CUSTOM ${task}/${experts.length}`
    }
  });
  const customPrompt = withDeadlineChairNote(custom, note).chair.promptTemplate(
    'задача',
    successful
  );
  assert.equal(customPrompt, `CUSTOM задача/1\n\n${note}`);

  // Исходная конфигурация не мутируется.
  assert.equal(config.chair.promptTemplate, undefined);
});

test('runExpertPhaseWithDeadline: без дедлайна не создаёт таймер', async () => {
  let cancelCalls = 0;
  const controller = {
    cancel: () => {
      cancelCalls += 1;
    },
    reset: () => {},
    isCancelled: () => false
  };

  const outcome = await runExpertPhaseWithDeadline(undefined, controller, async () => 'ok');
  assert.deepEqual(outcome, { value: 'ok', hit: false });
  assert.equal(cancelCalls, 0);
});

test('runExpertPhaseWithDeadline: таймер отменяет контроллер и снимается после запуска', async () => {
  let resolveRun;
  let cancelCalls = 0;
  const controller = {
    cancel: () => {
      cancelCalls += 1;
      resolveRun('cancelled');
    },
    reset: () => {},
    isCancelled: () => cancelCalls > 0
  };
  const run = new Promise(resolve => {
    resolveRun = resolve;
  });

  // Таймер в помощнике unref-нут; интервал держит event loop, пока тест ждёт.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const outcome = await runExpertPhaseWithDeadline(25, controller, () => run);
    assert.equal(outcome.hit, true);
    assert.equal(outcome.value, 'cancelled');
    assert.equal(cancelCalls, 1);
  } finally {
    clearInterval(keepAlive);
  }

  // После быстрого завершения таймер снят и позже не срабатывает.
  let laterCalls = 0;
  const fastController = {
    cancel: () => {
      laterCalls += 1;
    },
    reset: () => {},
    isCancelled: () => false
  };
  const fast = await runExpertPhaseWithDeadline(30, fastController, async () => 'fast');
  assert.equal(fast.hit, false);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(laterCalls, 0);
});

test('runExpertPhaseWithDeadline: снимает таймер и при ошибке экспертного этапа', async () => {
  let cancelCalls = 0;
  const controller = {
    cancel: () => {
      cancelCalls += 1;
    },
    reset: () => {},
    isCancelled: () => false
  };

  await assert.rejects(
    runExpertPhaseWithDeadline(20, controller, async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(cancelCalls, 0);
});

const FAKE_OPENCODE = `const args = process.argv.slice(2);
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

  if (prompt.includes('ALL_SLOW') || agent === 'plan') {
    setInterval(() => {}, 1000);
  } else if (agent === 'build') {
    emit('BUILD_OK');
  } else {
    emit(
      prompt.includes('experts finished before the deadline')
        ? 'CHAIR_SAW_DEADLINE_NOTE'
        : 'CHAIR_NO_DEADLINE_NOTE'
    );
  }
}
`;

function createFakeOpenCode() {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-deadline-'));
  const script = join(dir, 'fake-opencode.mjs');
  writeFileSync(script, FAKE_OPENCODE, 'utf8');

  let opencodePath;
  if (process.platform === 'win32') {
    opencodePath = join(dir, 'fake-opencode.cmd');
    writeFileSync(
      opencodePath,
      `@"${process.execPath}" "%~dp0fake-opencode.mjs" %*\r\n`,
      'utf8'
    );
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

function createConfig(opencodePath, cwd, experts) {
  const config = {
    cwd,
    opencodePath,
    experts,
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
    autoDiscoverAgents: false
  };
  // .cmd-шим на Windows принимается только из доверенной конфигурации.
  Object.defineProperty(config, TRUSTED_PROJECT_CONFIG, {
    value: true,
    enumerable: false,
    configurable: true
  });
  return config;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test('дедлайн: частичный результат, hit=true и missing-роли', async () => {
  const { dir, opencodePath } = createFakeOpenCode();
  try {
    const consilium = new Consilium(
      createConfig(opencodePath, dir, [{ name: 'build' }, { name: 'plan' }])
    );
    const started = Date.now();
    const result = await consilium.run('проверь задачу', { deadlineMs: 2000 });
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 1500, `эксперты должны были ждать дедлайн, прошло ${elapsed} мс`);
    assert.equal(result.success, true);
    assert.equal(result.experts.length, 2);

    const build = result.experts.find(expert => expert.agent === 'build');
    const plan = result.experts.find(expert => expert.agent === 'plan');
    assert.equal(build?.success, true);
    assert.equal(plan?.success, false);

    assert.deepEqual(result.metadata?.deadline, {
      limitMs: 2000,
      hit: true,
      completed: 1,
      missing: ['plan']
    });
    // Заметка попала в промпт председателя, а missing — в текст результата.
    assert.match(result.text, /CHAIR_SAW_DEADLINE_NOTE/);
    assert.match(result.text, /1 из 2 экспертов завершили работу/);
    assert.match(result.text, /plan/);
  } finally {
    cleanup(dir);
  }
});

test('дедлайн без успешных экспертов: DEADLINE и председатель не запускается', async () => {
  const { dir, opencodePath } = createFakeOpenCode();
  try {
    const config = createConfig(opencodePath, dir, [{ name: 'build' }, { name: 'plan' }]);
    // Дедлайн из конфигурации, а не из RunOptions.
    config.deadlineMs = 1000;
    const result = await new Consilium(config).run('ALL_SLOW проверь задачу');

    assert.equal(result.success, false);
    assert.equal(result.chair.success, false);
    assert.equal(result.chair.errorCode, 'DEADLINE');
    assert.match(result.chair.errorMessage, /председатель не запускался/);
    assert.match(result.chair.text, /Дедлайн/);
    assert.equal(result.text, result.chair.text);

    assert.deepEqual(result.metadata?.deadline, {
      limitMs: 1000,
      hit: true,
      completed: 0,
      missing: ['build', 'plan']
    });
    // Ни один эксперт не успел: все результаты неуспешны.
    assert.ok(result.experts.every(expert => expert.success === false));
  } finally {
    cleanup(dir);
  }
});

test('без deadlineMs metadata.deadline отсутствует и заметки нет', async () => {
  const { dir, opencodePath } = createFakeOpenCode();
  try {
    const consilium = new Consilium(
      createConfig(opencodePath, dir, [{ name: 'build' }])
    );
    const result = await consilium.run('обычная задача');

    assert.equal(result.success, true);
    assert.equal(result.chair.success, true);
    assert.equal('deadline' in (result.metadata ?? {}), false);
    assert.match(result.text, /CHAIR_NO_DEADLINE_NOTE/);
    assert.doesNotMatch(result.text, /experts finished before the deadline/);
  } finally {
    cleanup(dir);
  }
});
