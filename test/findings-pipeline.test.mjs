import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAIR_FINDINGS_INSTRUCTION,
  EXPERT_FINDINGS_INSTRUCTION,
  appendFindingsInstruction,
  buildChairPrompt,
  buildExpertPrompt,
  buildFindingsInstruction
} from '../dist/domain/council/prompts.js';
import { collectFindings } from '../dist/application/findings.js';
import { buildCompletedResult, saveArtifactRun } from '../dist/application/run.js';
import { loadArtifact } from '../dist/artifacts.js';
import { Consilium } from '../dist/application/consilium.js';
import { mergeWithDefaults, validateConfig, generateExampleConfig } from '../dist/config.js';
import { parseArgs } from '../dist/cli.js';
import { applyCliOverrides } from '../dist/interfaces/cli/overrides.js';
import { getMcpTools } from '../dist/mcp.js';
import * as publicApi from '../dist/index.js';

const block = payload => '```json\n' + JSON.stringify(payload, null, 2) + '\n```';

const expert = (agent, text, model) => {
  const result = { agent, text, success: true };
  if (model !== undefined) result.model = model;
  return result;
};

test('публичный API экспортирует контракт находок и сборщик', () => {
  assert.equal(typeof publicApi.parseFindingsBlock, 'function');
  assert.equal(typeof publicApi.mergeFindings, 'function');
  assert.equal(typeof publicApi.fingerprintFinding, 'function');
  assert.equal(typeof publicApi.collectFindings, 'function');
});

test('инструкция эксперта требует один JSON-блок со всеми полями находки', () => {
  assert.equal(buildFindingsInstruction('expert'), EXPERT_FINDINGS_INSTRUCTION);
  assert.equal(buildFindingsInstruction('chair'), CHAIR_FINDINGS_INSTRUCTION);

  for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
    assert.match(EXPERT_FINDINGS_INSTRUCTION, new RegExp(severity));
  }
  assert.match(EXPERT_FINDINGS_INSTRUCTION, /```json/);
  assert.match(EXPERT_FINDINGS_INSTRUCTION, /findings/);
  assert.match(EXPERT_FINDINGS_INSTRUCTION, /category/);
  assert.match(EXPERT_FINDINGS_INSTRUCTION, /file/);
  assert.match(EXPERT_FINDINGS_INSTRUCTION, /line/);
  assert.match(EXPERT_FINDINGS_INSTRUCTION, /claim/);
  assert.match(EXPERT_FINDINGS_INSTRUCTION, /evidence/);
  assert.match(EXPERT_FINDINGS_INSTRUCTION, /confidence/);
  assert.match(EXPERT_FINDINGS_INSTRUCTION, /ровно один/);

  assert.match(CHAIR_FINDINGS_INSTRUCTION, /rejected/);
  assert.match(CHAIR_FINDINGS_INSTRUCTION, /reason/);
  assert.match(CHAIR_FINDINGS_INSTRUCTION, /findings/);
});

test('buildExpertPrompt: без findings текст прежний, с findings — инструкция в конце', () => {
  const base = buildExpertPrompt({ name: 'arch' }, 'задача');
  assert.match(base, /Не вызывай инструменты/);
  assert.equal(buildExpertPrompt({ name: 'arch' }, 'задача', false), base);

  const withFindings = buildExpertPrompt({ name: 'arch' }, 'задача', true);
  assert.ok(withFindings.startsWith(base));
  assert.ok(withFindings.endsWith(EXPERT_FINDINGS_INSTRUCTION));
  assert.match(withFindings, /Не вызывай инструменты/);

  const custom = buildExpertPrompt(
    { name: 'custom', prompt: 'Разбери: ${task}' },
    'задача',
    true
  );
  assert.match(custom, /^Разбери: задача/);
  assert.ok(custom.endsWith(EXPERT_FINDINGS_INSTRUCTION));
});

test('buildChairPrompt: инструкция с rejected добавляется после требований', () => {
  const experts = [expert('arch', 'ответ архитектора')];
  const base = buildChairPrompt('задача', experts, 3000);
  assert.match(base, /Не вызывай инструменты/);

  const withFindings = buildChairPrompt('задача', experts, 3000, false, true);
  assert.ok(withFindings.startsWith(base));
  assert.ok(withFindings.endsWith(CHAIR_FINDINGS_INSTRUCTION));
  assert.match(withFindings, /ответ архитектора/);
});

test('appendFindingsInstruction идемпотентен', () => {
  const once = appendFindingsInstruction('ответ', 'expert');
  assert.equal(appendFindingsInstruction(once, 'expert'), once);
});

test('collectFindings: два эксперта и председатель — дедуп, severity и contested', () => {
  const experts = [
    expert(
      'arch',
      `Ответ.\n${block({
        findings: [
          {
            severity: 'medium',
            category: 'api',
            file: 'src/api.ts',
            line: 10,
            claim: 'Нет лимита запросов',
            evidence: 'handler без rate limit',
            confidence: 0.7
          }
        ]
      })}`,
      'openai/arch-model'
    ),
    expert(
      'sec',
      `Ответ.\n${block({
        findings: [
          {
            severity: 'high',
            category: 'api',
            file: 'src/api.ts',
            line: 12,
            claim: 'нет лимита запросов',
            evidence: 'подтверждаю',
            confidence: 0.9
          }
        ]
      })}`,
      'openai/sec-model'
    )
  ];
  const chair = expert(
    'consilium',
    `Итог.\n${block({
      findings: [],
      rejected: [
        { claim: 'Нет лимита запросов', reason: 'лимит настроен на прокси' }
      ]
    })}`,
    'openai/chair-model'
  );

  const summary = collectFindings(experts, chair);
  assert.deepEqual(summary.parseErrors, []);
  assert.equal(summary.items.length, 1);

  const item = summary.items[0];
  assert.equal(item.severity, 'high');
  assert.equal(item.contested, true);
  assert.deepEqual(item.rejectedBy, ['consilium']);
  assert.deepEqual(
    item.sources.map(source => [source.agent, source.model]),
    [
      ['arch', 'openai/arch-model'],
      ['sec', 'openai/sec-model']
    ]
  );
  assert.equal(summary.rejected.length, 1);
  assert.equal(summary.rejected[0].agent, 'consilium');
  assert.equal(summary.counts.high, 1);
  assert.equal(summary.counts.medium, 0);
});

test('collectFindings: отсутствующий/битый блок не роняет сбор и попадает в parseErrors', () => {
  const experts = [
    expert('arch', `Ответ.\n${block({ findings: [{ claim: 'ok', severity: 'low' }] })}`),
    expert('ux', 'Ответ без JSON-блока'),
    expert('ba', '```json\n{ broken\n```')
  ];

  const summary = collectFindings(experts);
  assert.equal(summary.items.length, 1);
  assert.deepEqual(summary.parseErrors, ['ux: no-block', 'ba: invalid-json']);

  const empty = collectFindings([]);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.rejected, []);
  assert.deepEqual(empty.parseErrors, []);
  assert.deepEqual(empty.counts, {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0
  });
});

test('buildCompletedResult: findings добавляются только когда передана сводка', () => {
  const experts = [
    expert('arch', `Ответ.\n${block({ findings: [{ claim: 'находка', severity: 'low' }] })}`)
  ];
  const chair = expert('consilium', `Итог.\n${block({ findings: [], rejected: [] })}`);
  const base = {
    experts,
    chair,
    parallelTime: 1,
    startTime: Date.now(),
    cost: { spent: 0, exceeded: false, byAgent: {} },
    costExceeded: false,
    consensusEnabled: false,
    fallbackModels: []
  };

  const disabled = buildCompletedResult(base);
  assert.equal(Object.prototype.hasOwnProperty.call(disabled.metadata, 'findings'), false);

  const summary = collectFindings(experts, chair);
  const enabled = buildCompletedResult({ ...base, findings: summary });
  assert.equal(enabled.metadata.findings.items.length, 1);
  assert.equal(enabled.metadata.findings.items[0].claim, 'находка');
});

test('saveArtifactRun сохраняет metadata.findings в run.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'consilium-findings-'));
  try {
    const experts = [
      expert(
        'arch',
        `Ответ.\n${block({ findings: [{ claim: 'проблема', severity: 'high' }] })}`,
        'openai/arch-model'
      )
    ];
    const chair = expert('consilium', `Итог.\n${block({ findings: [], rejected: [] })}`);
    const summary = collectFindings(experts, chair);
    const result = buildCompletedResult({
      experts,
      chair,
      parallelTime: 1,
      startTime: Date.now(),
      cost: { spent: 0, exceeded: false, byAgent: {} },
      costExceeded: false,
      consensusEnabled: false,
      findings: summary,
      fallbackModels: []
    });

    saveArtifactRun(result, 'задача', root, { cwd: root }, undefined);
    const reference = result.metadata.artifacts;
    assert.equal(typeof reference.dir, 'string');

    const stored = loadArtifact(reference.id, root);
    assert.equal(stored.metadata.findings.items.length, 1);
    assert.equal(stored.metadata.findings.items[0].claim, 'проблема');
    assert.equal(stored.metadata.findings.items[0].severity, 'high');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('конфигурация: findings опционален, валидируется и попадает в пример', () => {
  assert.equal(mergeWithDefaults({ findings: true }).findings, true);
  assert.equal(mergeWithDefaults({}).findings, false);

  const invalid = mergeWithDefaults({ findings: 'yes' });
  assert.ok(
    validateConfig(invalid).some(warning => warning.includes('findings')),
    validateConfig(invalid).join(' | ')
  );

  const example = JSON.parse(generateExampleConfig());
  assert.equal(example.findings, false);
});

test('CLI: --findings / --no-findings и overrides', () => {
  const enabled = parseArgs(['--findings', 'задача']);
  assert.equal(enabled.findings, true);
  assert.equal(enabled.task, 'задача');

  const disabled = parseArgs(['--no-findings', 'задача']);
  assert.equal(disabled.noFindings, true);

  const config = mergeWithDefaults({ experts: [{ name: 'arch' }] });
  assert.equal(applyCliOverrides(config, enabled).findings, true);
  assert.equal(
    applyCliOverrides(mergeWithDefaults({ findings: true }), disabled).findings,
    false
  );
});

test('MCP: consilium_run объявляет findings, dry-run учитывает флаг', () => {
  const runTool = getMcpTools().find(tool => tool.name === 'consilium_run');
  assert.equal(runTool.inputSchema.properties.findings.type, 'boolean');

  const enabled = new Consilium({ experts: [{ name: 'arch' }], findings: true });
  const enabledPrompts = enabled.dryRun('задача');
  assert.ok(enabledPrompts.expertPrompts[0].prompt.endsWith(EXPERT_FINDINGS_INSTRUCTION));
  assert.ok(enabledPrompts.chairPromptTemplate.endsWith(CHAIR_FINDINGS_INSTRUCTION));

  const disabled = new Consilium({ experts: [{ name: 'arch' }], findings: false });
  const disabledPrompts = disabled.dryRun('задача');
  assert.equal(disabledPrompts.expertPrompts[0].prompt.includes('Структурированные находки'), false);
  assert.equal(disabledPrompts.chairPromptTemplate.includes('Структурированные находки'), false);
});
