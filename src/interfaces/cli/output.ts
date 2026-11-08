/**
 * @fileoverview Вывод и отчёты CLI consilium
 * @module lv24-opencode-consilium/cli/output
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import type { CLIOptions, ConsiliumConfig, ConsiliumResult } from '../../domain/types.js';
import { Consilium } from '../../application/consilium.js';
import { listPresets } from '../../domain/council/presets.js';
import { renderReport, type ReportFormat } from '../../domain/artifacts/report.js';

export function log(options: CLIOptions, message: string): void {
  if (!options.silent) console.error(message);
}

export function setupConsoleHooks(config: ConsiliumConfig, options: CLIOptions): void {
  if (options.silent) return;

  const startTimes = new Map<string, number>();
  config.hooks = {
    ...config.hooks,
    onExpertStart: (expert: string) => {
      startTimes.set(expert, Date.now());
      console.error(`⏳ [${expert}] Запуск...`);
    },
    onExpertEnd: (result) => {
      const started = startTimes.get(result.agent) ?? Date.now();
      const duration = ((result.duration ?? (Date.now() - started)) / 1000).toFixed(1);
      if (result.success) {
        const model = result.model ? ` · ${result.model}` : '';
        console.error(`✅ [${result.agent}] Готово (${duration}с, ${result.text.length} симв.)${model}`);
      } else {
        console.error(`❌ [${result.agent}] ${result.errorCode ?? 'ОШИБКА'}: ${result.errorMessage ?? 'нет ответа'} (${duration}с)`);
      }
      startTimes.delete(result.agent);
    },
    onChairStart: () => {
      console.error('⏳ [chair] Синтез запущен...');
    },
    onChairEnd: (result) => {
      const duration = ((result.duration ?? 0) / 1000).toFixed(1);
      if (result.success) {
        console.error(`✅ [chair] Синтез завершён (${duration}с, ${result.text.length} симв.)`);
      } else {
        console.error(`❌ [chair] Ошибка синтеза: ${result.errorMessage ?? result.errorCode ?? 'нет ответа'}`);
      }
    },
    onLog: (level, message) => {
      console.error(`[${level}] ${message}`);
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
  console.error('─'.repeat(50));
  console.error(`⏱️ Время: ${(result.totalTime / 1000).toFixed(1)}с · эксперты: ${successful}/${result.experts.length}`);
  if (result.usage?.cost && result.usage.cost > 0) {
    console.error(`💰 Стоимость: $${result.usage.cost.toFixed(6)}`);
  } else if (result.usage) {
    console.error('💰 Стоимость: $0 (бесплатные модели)');
  }
  if (typeof result.metadata?.savedFile === 'string') {
    console.error(`💾 Сохранено: ${result.metadata.savedFile}`);
  }
  if (typeof result.metadata?.saveError === 'string') {
    console.error(`⚠️ Не сохранено: ${result.metadata.saveError}`);
  }

  const artifacts = result.metadata?.artifacts;
  if (artifacts !== null && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
    const dir = (artifacts as { dir?: unknown }).dir;
    if (typeof dir === 'string') {
      console.error(`📦 Артефакт: ${dir}`);
    }
  }

  const consensus = result.metadata?.consensus;
  if (consensus !== null && typeof consensus === 'object' && !Array.isArray(consensus)) {
    const agreement = (consensus as { agreement?: unknown }).agreement;
    const average = (consensus as { averageSimilarity?: unknown }).averageSimilarity;
    if (typeof agreement === 'string') {
      const value = typeof average === 'number' ? `, ${average.toFixed(2)}` : '';
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
}

export function printAgentList(config: ConsiliumConfig): void {
  console.log('Эксперты:');
  for (const expert of config.experts) {
    const status = expert.enabled === false ? ' (отключен)' : '';
    const model = expert.model ? ` — ${expert.model}` : '';
    console.log(`  • ${expert.name}${model}${status}`);
  }
  console.log('\nПредседатель:');
  console.log(`  • ${config.chair.agent}${config.chair.model ? ` — ${config.chair.model}` : ''}`);
  console.log('\nПресеты:');
  for (const preset of listPresets()) {
    console.log(`  • ${preset.name} — ${preset.description}`);
  }
}

export function printDryRun(task: string, config: ConsiliumConfig): void {
  const consilium = new Consilium(config);
  const info = consilium.dryRun(task);

  console.log('\n🔍 DRY RUN — промпты без вызова агентов\n');
  for (const { agent, prompt, model } of info.expertPrompts) {
    console.log(`\n[${agent.toUpperCase()}]${model ? ` (${model})` : ''}`);
    console.log(prompt);
  }
  console.log('\n[ПРЕДСЕДАТЕЛЬ]');
  console.log(info.chairPromptTemplate);
}

/** Определяет формат отчёта по расширению файла */
export function inferReportFormat(file: string): ReportFormat {
  const lower = file.toLowerCase();
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
    text = renderReport(result, format);
  } catch (error) {
    console.error(`⚠️ Не удалось построить отчёт: ${(error as Error).message}`);
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
    const directory = dirname(target);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    writeFileSync(target, text, 'utf-8');
  } catch (error) {
    console.error(`⚠️ Не удалось сохранить отчёт: ${(error as Error).message}`);
    return false;
  }
  if (!options.silent) console.error(`📄 Отчёт: ${target}`);
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
