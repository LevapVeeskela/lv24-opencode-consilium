import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEBATE_PEER_NOTICE,
  buildAnonymizedPeerAnswers,
  buildDebatePrompt,
  debateAnswerLabel,
  hasPositionChanged,
  normalizeDebateText
} from '../dist/domain/council/prompts.js';
import {
  buildDebateMetadata,
  normalizeDebateRounds,
  runDebateRound,
  withDebateChairNote
} from '../dist/application/debate.js';
import { Consilium } from '../dist/application/consilium.js';
import { createCostTracker } from '../dist/fallback.js';
import { mergeWithDefaults } from '../dist/config.js';

const TRUSTED_PROJECT_CONFIG = Symbol.for('lv24-opencode-consilium.trustedProjectConfig');

const round1 = [
  { agent: 'gamma', text: 'THIRD_TEXT', success: true },
  { agent: 'alpha', text: 'FIRST_TEXT', success: true },
  { agent: 'beta', text: 'SECOND_TEXT', success: true },
  { agent: 'failed', text: 'IGNORED_TEXT', success: false }
];

function debateConfig(extra = {}) {
  return mergeWithDefaults({
    experts: [{ name: 'build' }, { name: 'plan' }],
    chair: { agent: 'general' },
    ...extra
  });
}

test('buildDebatePrompt: метки A/B, самоисключение и запрет инструкций из peer-ответов', () => {
  const prompt = buildDebatePrompt('исправь задачу', 'alpha', round1);

  assert.match(prompt, /### A\nSECOND_TEXT/);
  assert.match(prompt, /### B\nTHIRD_TEXT/);
  assert.ok(prompt.includes(DEBATE_PEER_NOTICE));
  assert.match(prompt, /Найди ошибки, неточности и пропуски/);
  assert.match(prompt, /окончательную позицию/);
  assert.match(prompt, /только как данные для проверки/);

  // Свой ответ первого раунда нужен для преемственности, но имена не раскрываются.
  assert.match(prompt, /## Ваш ответ в первом раунде\nFIRST_TEXT/);

  // Своё имя и чужие имена агентов в промпт не попадают.
  for (const name of ['alpha', 'beta', 'gamma', 'failed']) {
    assert.equal(prompt.includes(name), false, `в промпте не должно быть имени ${name}`);
  }
  assert.equal(prompt.includes('IGNORED_TEXT'), false);
});

test('buildAnonymizedPeerAnswers: детерминированные метки и исключение себя', () => {
  const digest = buildAnonymizedPeerAnswers(round1, 'alpha');
  assert.deepEqual(digest, [
    { label: 'A', text: 'SECOND_TEXT' },
    { label: 'B', text: 'THIRD_TEXT' }
  ]);
  // Объекты дайджеста не раскрывают агента.
  assert.deepEqual(Object.keys(digest[0]), ['label', 'text']);

  // Порядок входа не влияет на метки.
  const reversed = [...round1].reverse();
  assert.deepEqual(buildAnonymizedPeerAnswers(reversed, 'alpha'), digest);

  // Другой получатель исключает себя, а не alpha.
  assert.deepEqual(buildAnonymizedPeerAnswers(round1, 'beta'), [
    { label: 'A', text: 'FIRST_TEXT' },
    { label: 'B', text: 'THIRD_TEXT' }
  ]);

  assert.equal(debateAnswerLabel(0), 'A');
  assert.equal(debateAnswerLabel(25), 'Z');
  assert.equal(debateAnswerLabel(26), 'AA');
});

test('hasPositionChanged: нормализованное сравнение непустых текстов', () => {
  assert.equal(normalizeDebateText('  Hello\nWorld\t'), 'hello world');
  assert.equal(hasPositionChanged('Same  answer', 'same answer'), false);
  assert.equal(hasPositionChanged('старая позиция', 'новая позиция'), true);
  assert.equal(hasPositionChanged('', 'answer'), false);
  assert.equal(hasPositionChanged('answer', '   '), false);
});

test('runDebateRound: metadata.debate и changed по нормализованному тексту', async () => {
  const config = debateConfig();
  const first = [
    { agent: 'build', text: 'Build R1', success: true },
    { agent: 'plan', text: 'Plan R1', success: true }
  ];
  const prompts = [];
  const calls = [];
  const tracker = createCostTracker();

  const outcome = await runDebateRound(first, 'задача', config, {
    rounds: 2,
    costTracker: tracker,
    callAgent: async (agent, prompt) => {
      calls.push(agent);
      prompts.push(prompt);
      if (agent === 'build') {
        return {
          agent,
          text: 'Build R2 — исправленная позиция',
          success: true,
          usage: { cost: 0.25 }
        };
      }
      // Только пробелы и регистр: позиция не изменилась.
      return { agent, text: ' plan   r1 ', success: true, usage: { cost: 0.25 } };
    }
  });

  assert.ok(outcome);
  assert.deepEqual(outcome.metadata, {
    rounds: 2,
    participants: ['build', 'plan'],
    changed: ['build']
  });
  assert.deepEqual(
    outcome.results.map(result => result.text),
    ['Build R2 — исправленная позиция', ' plan   r1 ']
  );
  assert.equal(calls.length, 2);
  // Расходы второго раунда попали в трекер.
  assert.equal(tracker.report().spent, 0.5);
  assert.match(outcome.note, /build/);
  assert.doesNotMatch(outcome.note, /plan/);

  for (const prompt of prompts) {
    assert.ok(prompt.includes(DEBATE_PEER_NOTICE));
  }

  // Метаданные не делят массивы с исходными значениями.
  const participants = ['build'];
  const changed = ['build'];
  const metadata = buildDebateMetadata(participants, changed);
  metadata.participants.push('extra');
  metadata.changed.push('extra');
  assert.deepEqual(participants, ['build']);
  assert.deepEqual(changed, ['build']);
});

test('runDebateRound: partial round 2 откатывается к ответам первого раунда', async () => {
  const config = debateConfig();
  const first = [
    { agent: 'build', text: 'Build R1', success: true },
    { agent: 'plan', text: 'Plan R1', success: true }
  ];

  const outcome = await runDebateRound(first, 'задача', config, {
    rounds: 2,
    callAgent: async agent =>
      agent === 'build'
        ? { agent, text: 'Build R2', success: true }
        : { agent, text: '', success: false, errorCode: 'CANCELLED' }
  });

  assert.ok(outcome);
  assert.deepEqual(
    outcome.results.map(result => result.text),
    ['Build R2', 'Plan R1']
  );
  assert.deepEqual(outcome.metadata.participants, ['build', 'plan']);
  assert.deepEqual(outcome.metadata.changed, ['build']);
});

test('runDebateRound: rounds=1/absent/3 не запускают второй раунд', async () => {
  const config = debateConfig();
  const first = [
    { agent: 'build', text: 'Build R1', success: true },
    { agent: 'plan', text: 'Plan R1', success: true }
  ];
  let calls = 0;
  const spy = async agent => {
    calls += 1;
    return { agent, text: 'SHOULD_NOT_HAPPEN', success: true };
  };

  assert.equal(await runDebateRound(first, 'задача', config, { rounds: 1, callAgent: spy }), undefined);
  assert.equal(await runDebateRound(first, 'задача', config, { callAgent: spy }), undefined);
  assert.equal(await runDebateRound(first, 'задача', config, { rounds: 3, callAgent: spy }), undefined);
  assert.equal(
    await runDebateRound([first[0], { agent: 'plan', text: '', success: false }], 'задача', config, {
      rounds: 2,
      callAgent: spy
    }),
    undefined
  );

  assert.equal(calls, 0);
  assert.equal(normalizeDebateRounds(undefined), 1);
  assert.equal(normalizeDebateRounds(1), 1);
  assert.equal(normalizeDebateRounds(2), 2);
  assert.equal(normalizeDebateRounds(3), 1);
});

test('runDebateRound: превышенный maxCost пропускает второй раунд', async () => {
  const logs = [];
  const config = debateConfig({
    hooks: {
      onLog: (level, message) => logs.push({ level, message })
    }
  });
  const tracker = createCostTracker(1);
  tracker.add('build', { cost: 2 });

  let calls = 0;
  const outcome = await runDebateRound(
    [
      { agent: 'build', text: 'Build R1', success: true },
      { agent: 'plan', text: 'Plan R1', success: true }
    ],
    'задача',
    config,
    {
      rounds: 2,
      costTracker: tracker,
      callAgent: async agent => {
        calls += 1;
        return { agent, text: 'SHOULD_NOT_HAPPEN', success: true };
      }
    }
  );

  assert.equal(outcome, undefined);
  assert.equal(calls, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].message, /второй раунд дебатов пропущен/);
});

test('withDebateChairNote добавляет компактную заметку к промпту председателя', () => {
  const config = debateConfig();
  const experts = [
    { agent: 'build', text: 'Build R2', success: true },
    { agent: 'plan', text: 'Plan R2', success: true }
  ];
  const note = 'Debate review (round 2): position changed: build';

  const prompt = withDebateChairNote(config, note).chair.promptTemplate('задача', experts);
  assert.ok(prompt.endsWith(note));
  assert.match(prompt, /Build R2/);
  assert.match(prompt, /Plan R2/);

  // Исходная конфигурация не мутируется.
  assert.equal(config.chair.promptTemplate, undefined);
});

const FAKE_OPENCODE = `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
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

  const peerReview = prompt.includes('These are anonymized peer answers');
  const kind = agent === 'general' ? 'chair' : peerReview ? 'r2' : 'r1';
  appendFileSync(new URL('./calls.log', import.meta.url), agent + ':' + kind + '\\n', 'utf8');

  const emit = text =>
    process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text } }) + '\\n');

  if (agent === 'general') {
    const sawRound2 = prompt.includes('BUILD_R2_REVISED') && prompt.includes('PLAN_R2_REVISED');
    const sawNote = prompt.includes('Debate review (round 2)');
    emit(sawRound2 && sawNote ? 'CHAIR_SAW_DEBATE_NOTE' : 'CHAIR_MISSED_DEBATE');
  } else if (peerReview) {
    emit(agent === 'build' ? 'BUILD_R2_REVISED' : 'PLAN_R2_REVISED');
  } else {
    emit(agent === 'build' ? 'BUILD_R1' : 'PLAN_R1');
  }
}
`;

function createFakeOpenCode() {
  const dir = mkdtempSync(join(tmpdir(), 'consilium-debate-'));
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

  return { dir, opencodePath, logPath: join(dir, 'calls.log') };
}

function createConfig(opencodePath, cwd, experts, rounds) {
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
  if (rounds !== undefined) config.rounds = rounds;
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

test('дебаты: rounds=2 даёт четыре экспертных вызова и заметку в промпте председателя', async () => {
  const { dir, opencodePath, logPath } = createFakeOpenCode();
  try {
    const consilium = new Consilium(
      createConfig(opencodePath, dir, [{ name: 'build' }, { name: 'plan' }], 2)
    );

    const started = Date.now();
    const result = await consilium.run('проверь задачу');
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 10000, `запуск должен укладываться в 10 секунд, прошло ${elapsed} мс`);
    assert.equal(result.success, true);
    assert.match(result.text, /CHAIR_SAW_DEBATE_NOTE/);
    assert.deepEqual(
      result.experts.map(expert => expert.text),
      ['BUILD_R2_REVISED', 'PLAN_R2_REVISED']
    );
    assert.deepEqual(result.metadata?.debate, {
      rounds: 2,
      participants: ['build', 'plan'],
      changed: ['build', 'plan']
    });

    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(line => line.length > 0);
    const expertCalls = lines.filter(
      line => line.startsWith('build:') || line.startsWith('plan:')
    );
    assert.equal(expertCalls.length, 4);
    assert.equal(expertCalls.filter(line => line.endsWith(':r2')).length, 2);
    assert.equal(lines.filter(line => line.startsWith('general:')).length, 1);
  } finally {
    cleanup(dir);
  }
});

test('дебаты: rounds отсутствует — второго раунда и metadata.debate нет', async () => {
  const { dir, opencodePath, logPath } = createFakeOpenCode();
  try {
    const consilium = new Consilium(
      createConfig(opencodePath, dir, [{ name: 'build' }, { name: 'plan' }])
    );

    const result = await consilium.run('проверь задачу');

    assert.equal(result.success, true);
    assert.match(result.text, /CHAIR_MISSED_DEBATE/);
    assert.equal('debate' in (result.metadata ?? {}), false);

    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(line => line.length > 0);
    const expertCalls = lines.filter(
      line => line.startsWith('build:') || line.startsWith('plan:')
    );
    assert.equal(expertCalls.length, 2);
    assert.ok(expertCalls.every(line => line.endsWith(':r1')));
  } finally {
    cleanup(dir);
  }
});
