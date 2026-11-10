/**
 * @fileoverview Вывод и отчёты CLI consilium
 * @module lv24-opencode-consilium/cli/output
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import type { CLIOptions, ConsiliumConfig, ConsiliumResult } from '../../domain/types.js';
import { Consilium } from '../../application/consilium.js';
import { listPresets } from '../../domain/council/presets.js';
import { formatFindingsCounts, findingsSummaryOf, renderReport, type ReportFormat } from '../../domain/artifacts/report.js';
import { writeFileAtomic } from '../../shared/fs.js';
import { stripControlSequences } from '../../shared/redact.js';

/** Убирает ANSI/OSC-последовательности из недоверенных терминальных полей */
function safeText(value: string): string {
  return stripControlSequences(value);
}

export function log(options: CLIOptions, message: string): void {
  if (!options.silent) console.error(message);
}

export function setupConsoleHooks(config: ConsiliumConfig, options: CLIOptions): void {
  if (options.silent) return;

  const startTimes = new Map<string, number>();
  config.hooks = {
    ...config.hooks,
    onExpertStart: (expert: string) => {
      const name = safeText(expert);
      startTimes.set(name, Date.now());
      console.error(`⏳ [${name}] Запуск...`);
    },
    onExpertEnd: (result) => {
      const name = safeText(result.agent);
      const started = startTimes.get(name) ?? Date.now();
      const duration = ((result.duration ?? (Date.now() - started)) / 1000).toFixed(1);
      if (result.success) {
        const model = result.model ? ` · ${safeText(result.model)}` : '';
        console.error(`✅ [${name}] Готово (${duration}с, ${result.text.length} симв.)${model}`);
      } else {
        const code = safeText(result.errorCode ?? 'ОШИБКА');
        const message = safeText(result.errorMessage ?? 'нет ответа');
        console.error(`❌ [${name}] ${code}: ${message} (${duration}с)`);
      }
      startTimes.delete(name);
    },
    onChairStart: () => {
      console.error('⏳ [chair] Синтез запущен...');
    },
    onChairEnd: (result) => {
      const duration = ((result.duration ?? 0) / 1000).toFixed(1);
      if (result.success) {
        console.error(`✅ [chair] Синтез завершён (${duration}с, ${result.text.length} симв.)`);
      } else {
        const message = safeText(result.errorMessage ?? result.errorCode ?? 'нет ответа');
        console.error(`❌ [chair] Ошибка синтеза: ${message}`);
      }
    },
    onLog: (level, message) => {
      console.error(`[${level}] ${safeText(message)}`);
    }
  };
}

export function printResult(result: ConsiliumResult, options: CLIOptions): void {
  const format = options.format ?? 'text';
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.text);
}

export function printSummary(result: ConsiliumResult, options: CLIOptions): void {
  if (options.silent) return;
  const successful = result.experts.filter(expert => expert.success).length;
  const findings = findingsSummaryOf(result);
  const contested = findings === null ? 0 : findings.items.filter(item => item.contested).length;
  const findingsSuffix =
    findings === null
      ? ''
      : ` · Findings: ${findings.items.length} (${formatFindingsCounts(findings.counts)}) · contested: ${contested}`;
  console.error('─'.repeat(50));
  console.error(`⏱️ Время: ${(result.totalTime / 1000).toFixed(1)}с · эксперты: ${successful}/${result.experts.length}${findingsSuffix}`);
  if (result.usage?.cost && result.usage.cost > 0) {
    console.error(`💰 Стоимость: $${result.usage.cost.toFixed(6)}`);
  } else if (result.usage) {
    console.error('💰 Стоимость: $0 (бесплатные модели)');
  }
  if (typeof result.metadata?.savedFile === 'string') {
    console.error(`💾 Сохранено: ${safeText(result.metadata.savedFile)}`);
  }
  if (typeof result.metadata?.saveError === 'string') {
    console.error(`⚠️ Не сохранено: ${safeText(result.metadata.saveError)}`);
  }

  const artifacts = result.metadata?.artifacts;
  if (artifacts !== null && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
    const dir = (artifacts as { dir?: unknown }).dir;
    if (typeof dir === 'string') {
      console.error(`📦 Артефакт: ${safeText(dir)}`);
    }
  }

  const consensus = result.metadata?.consensus;
  if (consensus !== null && typeof consensus === 'object' && !Array.isArray(consensus)) {
    const agreement = (consensus as { agreement?: unknown }).agreement;
    const average = (consensus as { averageSimilarity?: unknown }).averageSimilarity;
    const experts = (consensus as { experts?: unknown }).experts;
    if (agreement === 'none' || agreement === 'insufficient') {
      const count = typeof experts === 'number' ? ` (экспертов: ${experts})` : '';
      console.error(`🤝 Согласие экспертов: нет данных${count}`);
    } else if (typeof agreement === 'string') {
      const value =
        typeof average === 'number' && Number.isFinite(average)
          ? `, ${average.toFixed(2)}`
          : '';
      console.error(`🤝 Согласие экспертов: ${agreement}${value}`);
    }
  }

  const cost = result.metadata?.cost;
  if (cost !== null && typeof cost === 'object' && !Array.isArray(cost)) {
    const limit = (cost as { limit?: unknown }).limit;
    const spent = (cost as { spent?: unknown }).spent;
    const exceeded = (cost as { exceeded?: unknown }).exceeded;
    if (typeof limit === 'number' && typeof spent === 'number') {
      console.error(
        `🎯 Лимит: $${limit.toFixed(4)} · потрачено $${spent.toFixed(4)}` +
          (exceeded === true ? ' — превышен' : '')
      );
    }
  }

  if (result.metadata?.costTelemetry === 'missing') {
    console.error('⚠️ Провайдер не сообщил стоимость: лимит maxCost не проверен');
  }

  const safety = result.metadata?.safety;
  if (safety !== null && typeof safety === 'object' && !Array.isArray(safety)) {
    const readOnly = (safety as { readOnly?: unknown }).readOnly === true;
    const isolate = (safety as { isolate?: unknown }).isolate === true;
    if (readOnly || isolate) {
      const parts = [readOnly ? 'read-only' : '', isolate ? 'isolate' : ''].filter(Boolean);
      console.error(`🛡️ Безопасность: ${parts.join(', ')}`);
    }
  }
}

export function printAgentList(config: ConsiliumConfig): void {
  console.log('Эксперты:');
  for (const expert of config.experts) {
    const status = expert.enabled === false ? ' (отключен)' : '';
    const model = expert.model ? ` — ${safeText(expert.model)}` : '';
    console.log(`  • ${safeText(expert.name)}${model}${status}`);
  }
  console.log('\nПредседатель:');
  const chairModel = config.chair.model ? ` — ${safeText(config.chair.model)}` : '';
  console.log(`  • ${safeText(config.chair.agent)}${chairModel}`);
  console.log('\nПресеты:');
  for (const preset of listPresets(config.presets)) {
    console.log(`  • ${preset.name} — ${preset.description}`);
  }
}

export function printDryRun(task: string, config: ConsiliumConfig): void {
  const consilium = new Consilium(config);
  const info = consilium.dryRun(task);

  console.log('\n🔍 DRY RUN — промпты без вызова агентов\n');
  for (const { agent, prompt, model } of info.expertPrompts) {
    const modelLabel = model ? ` (${safeText(model)})` : '';
    console.log(`\n[${safeText(agent).toUpperCase()}]${modelLabel}`);
    console.log(prompt);
  }
  console.log('\n[ПРЕДСЕДАТЕЛЬ]');
  console.log(info.chairPromptTemplate);
}

/** Определяет формат отчёта по расширению файла */
export function inferReportFormat(file: string): ReportFormat {
  const lower = file.toLowerCase();
  if (lower.endsWith('.sarif') || lower.endsWith('.sarif.json')) return 'sarif';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'pr';
  return 'html';
}

/** Рендерит и сохраняет отчёт. Возвращает true, если отчёт напечатан в stdout. */
export function writeRunReport(
  result: ConsiliumResult,
  config: ConsiliumConfig,
  options: CLIOptions
): boolean {
  const formatSetting = options.report ?? config.report;
  const fileSetting = options.reportFile ?? config.reportFile;
  if (formatSetting === undefined && fileSetting === undefined) return false;

  const format = formatSetting ?? inferReportFormat(fileSetting ?? '');
  let text: string;
  try {
    text = renderReport(result, format, config.version === undefined ? undefined : { version: config.version });
  } catch (error) {
    console.error(`⚠️ Не удалось построить отчёт: ${safeText((error as Error).message)}`);
    return false;
  }

  if (fileSetting === undefined) {
    if ((options.format ?? config.output.format) === 'json') {
      console.error('⚠️ Отчёт не выведен: при --format json укажите --report-file');
      return false;
    }
    console.log(text);
    return true;
  }

  const target = resolve(config.cwd ?? process.cwd(), fileSetting);
  try {
    writeFileAtomic(target, text);
  } catch (error) {
    console.error(`⚠️ Не удалось сохранить отчёт: ${safeText((error as Error).message)}`);
    return false;
  }
  if (!options.silent) console.error(`📄 Отчёт: ${safeText(target)}`);
  return false;
}

/** Атомарно записывает JSON-файл (через временный файл и rename) */
export function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temporary, path);
}
