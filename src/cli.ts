#!/usr/bin/env node

/**
 * @fileoverview CLI интерфейс для Consilium
 * @module opencode-consilium/cli
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { homedir } from 'os';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { CLIOptions, ConsiliumConfig, ConsiliumResult, RunOptions } from './types.js';
import { Consilium, loadConfig, generateExampleConfig, mergeWithDefaults } from './index.js';
import { buildCouncilAgents, buildConsiliumConfigFromModels, fetchFreeModels, selectCouncilModels } from './models.js';
import { applyPreset, listPresets } from './presets.js';
import { getGitDiff, formatDiffForPrompt } from './git.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { verifyModels } from './verify.js';
import { startMcpServer } from './mcp.js';
import { getOpenCodeVersion } from './agents.js';
import { findOpenCodeConfigPath, readJsonFile } from './config.js';
import {
  diffArtifacts,
  loadArtifact,
  resolveArtifactRoot,
  type ArtifactRun
} from './artifacts.js';
import { renderReport, type ReportFormat } from './report.js';
import { planReplay } from './replay.js';
import { isValidVariant, variantOf, withVariant } from './variants.js';
import {
  createProjectWatcher,
  installPreCommitHook,
  uninstallPreCommitHook
} from './watch.js';
import {
  parseOpenCodeVersion,
  readAgentDefinition,
  readAgentSection,
  readMcpSection,
  upsertAgents,
  upsertMcpServer
} from './compat.js';

const COMMANDS = new Set(['run', 'init', 'models', 'doctor', 'mcp', 'watch', 'hooks', 'help', 'version']);

class UsageError extends Error {}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || (value.startsWith('-') && value !== '-')) {
    throw new UsageError(`Флаг ${flag} требует значение`);
  }
  return value;
}

function requireNumericValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new UsageError(`Флаг ${flag} требует значение`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`Флаг ${flag} ожидает положительное целое число, получено: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`Флаг ${flag} ожидает целое число >= 0, получено: ${value}`);
  }
  return parsed;
}

function parseNonNegativeFloat(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`Флаг ${flag} ожидает число >= 0, получено: ${value}`);
  }
  return parsed;
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

/**
 * Парсит аргументы командной строки
 */
export function parseArgs(argv: string[]): CLIOptions {
  const options: CLIOptions = { task: '' };
  const taskParts: string[] = [];
  let afterTerminator = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';

    if (afterTerminator) {
      taskParts.push(arg);
      continue;
    }

    switch (arg) {
      case '--':
        afterTerminator = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      case '-V':
      case '--verbose':
        options.verbose = true;
        break;
      case '-s':
      case '--silent':
        options.silent = true;
        break;
      case '-c':
      case '--config':
        options.config = requireValue(argv, ++i, arg);
        break;
      case '-e':
      case '--experts':
        options.experts = requireValue(argv, ++i, arg);
        break;
      case '--chair':
        options.chair = requireValue(argv, ++i, arg);
        break;
      case '--expert-timeout':
        options.expertTimeout = parsePositiveInt(requireNumericValue(argv, ++i, arg), arg);
        break;
      case '--chair-timeout':
        options.chairTimeout = parsePositiveInt(requireNumericValue(argv, ++i, arg), arg);
        break;
      case '-o':
      case '--output':
        options.output = requireValue(argv, ++i, arg);
        break;
      case '-f':
      case '--format': {
        const format = requireValue(argv, ++i, arg);
        if (format !== 'text' && format !== 'markdown' && format !== 'json') {
          throw new UsageError(`Неизвестный формат: ${format} (text, markdown, json)`);
        }
        options.format = format;
        break;
      }
      case '-l':
      case '--log-level': {
        const level = requireValue(argv, ++i, arg);
        if (!['silent', 'error', 'warn', 'info', 'debug'].includes(level)) {
          throw new UsageError(`Неизвестный уровень логирования: ${level}`);
        }
        options.logLevel = level as CLIOptions['logLevel'];
        break;
      }
      case '-r':
      case '--retries':
        options.retries = parseNonNegativeInt(requireNumericValue(argv, ++i, arg), arg);
        break;
      case '--preset':
        options.preset = requireValue(argv, ++i, arg);
        break;
      case '--limit':
        options.limit = parsePositiveInt(requireNumericValue(argv, ++i, arg), arg);
        break;
      case '--task-file':
        options.taskFile = requireValue(argv, ++i, arg);
        break;
      case '--base':
        options.diffBase = requireValue(argv, ++i, arg);
        break;
      case '--list-agents':
        options.listAgents = true;
        break;
      case '--init':
        options.init = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--free':
        options.free = true;
        break;
      case '--refresh':
        options.refresh = true;
        break;
      case '--available':
        options.available = true;
        break;
      case '--json':
        options.json = true;
        options.format = 'json';
        break;
      case '--apply':
        options.apply = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--diff':
        options.diff = true;
        break;
      case '--staged':
        options.diffStaged = true;
        break;
      case '--no-save':
        options.noSave = true;
        break;
      case '--verify':
        options.verify = true;
        break;
      case '--no-verify':
        options.noVerify = true;
        break;
      case '--max-cost':
        options.maxCost = parseNonNegativeFloat(requireNumericValue(argv, ++i, arg), arg);
        break;
      case '--fallback-models':
        options.fallbackModels = parseCsv(requireValue(argv, ++i, arg));
        break;
      case '--session':
        options.session = requireValue(argv, ++i, arg);
        break;
      case '--report': {
        const format = requireValue(argv, ++i, arg);
        if (format !== 'html' && format !== 'pr' && format !== 'markdown') {
          throw new UsageError(`Неизвестный формат отчёта: ${format} (html, pr, markdown)`);
        }
        options.report = format;
        break;
      }
      case '--report-file':
        options.reportFile = requireValue(argv, ++i, arg);
        break;
      case '--variant':
        options.variant = requireValue(argv, ++i, arg);
        break;
      case '--debounce':
        options.debounceMs = parseNonNegativeInt(requireNumericValue(argv, ++i, arg), arg);
        break;
      case '--artifacts':
        options.artifacts = true;
        break;
      case '--artifacts-dir':
        options.artifactsDir = requireValue(argv, ++i, arg);
        options.artifacts = options.artifactsDir;
        break;
      case '--no-artifacts':
        options.noArtifacts = true;
        break;
      case '--consensus':
        options.consensus = true;
        break;
      case '--no-consensus':
        options.noConsensus = true;
        break;
      case '--smart-experts':
        options.smartExperts = true;
        break;
      case '--replay':
        options.replay = requireValue(argv, ++i, arg);
        break;
      case '--diff-runs': {
        const left = requireValue(argv, ++i, arg);
        const right = requireValue(argv, ++i, arg);
        options.diffRuns = [left, right];
        break;
      }
      case '--native-v2':
        options.nativeV2 = true;
        break;
      case '--install':
        options.mcpInstall = true;
        break;
      case '--global':
        options.globalConfig = true;
        break;
      default:
        if (arg === '-') {
          options.taskFile = '-';
        } else if (!arg.startsWith('-')) {
          if (options.command === undefined && taskParts.length === 0 && COMMANDS.has(arg)) {
            options.command = arg as CLIOptions['command'];
          } else {
            taskParts.push(arg);
          }
        } else {
          throw new UsageError(`Неизвестный флаг: ${arg}. Используйте --help.`);
        }
        break;
    }
  }

  options.task = taskParts.join(' ').trim();
  if (options.command === 'hooks') {
    const action = options.task.trim();
    if (action === 'install' || action === 'uninstall') {
      options.hookAction = action;
      options.task = '';
    }
  }
  if (options.help) options.command = 'help';
  if (options.version) options.command = 'version';
  if (options.init && options.command === undefined) options.command = 'init';
  return options;
}

function printHelp(): void {
  console.log(`
consilium - Консилиум ИИ-экспертов через OpenCode CLI

ИСПОЛЬЗОВАНИЕ:
  consilium [опции] <задача>
  consilium <задача> -              задача читается из stdin
  consilium init [--free]
  consilium models [--available] [--json]
  consilium doctor
  consilium mcp

ОСНОВНЫЕ ОПЦИИ:
  -h, --help              Показать эту справку
  -v, --version           Показать версию
  -V, --verbose           Подробный вывод
  -s, --silent            Тихий режим (только результат)

  -c, --config <файл>     Путь к файлу конфигурации
  -e, --experts <список>  Эксперты через запятую (arch,ux,ba,sec)
  --chair <агент>         Агент-председатель
  --preset <имя>          Пресет: fast, deep, security, review, free

  --expert-timeout <мс>   Таймаут экспертов (по умолчанию: 300000)
  --chair-timeout <мс>    Таймаут председателя (по умолчанию: 600000)
  -r, --retries <число>   Повторные попытки

  -o, --output <файл>     Сохранить результат в файл
  -f, --format <формат>   Формат: text, markdown, json (json — чистый JSON в stdout)
  --no-save               Не сохранять результат
  --verify                (models/init) Проверить модели реальным запросом
  --no-verify             (init) Не проверять модели (быстрее)

  --diff                  Добавить git diff текущих изменений к задаче
  --staged                Использовать staged-изменения
  --base <ref>            Сравнить с веткой/коммитом
  --task-file <файл>      Прочитать задачу из файла

АНАЛИЗ И АРТЕФАКТЫ:
  --consensus             Анализ согласия экспертов (в промпт председателя и отчёт)
  --no-consensus          Отключить анализ согласия
  --smart-experts         Выбрать 2–3 релевантных эксперта по задаче/диффу
  --max-cost <usd>        Лимит стоимости; при превышении председатель не запускается
  --fallback-models a,b   Запасные модели при RATE_LIMITED/MODEL_UNAVAILABLE/EMPTY_RESPONSE
  --session <id>          Продолжить сессию председателя; эксперты получают свои сессии
  --artifacts             Сохранить запуск в .consilium/runs
  --artifacts-dir <путь>  Сохранить артефакты в указанный каталог
  --no-artifacts          Не сохранять артефакты
  --replay <id>           Повторить сохранённый запуск
  --diff-runs <a> <b>     Сравнить два артефакта
  --report <формат>       Отчёт после запуска: html, pr, markdown
  --report-file <файл>    Записать отчёт в файл (по умолчанию stdout)
  --variant <имя>         Вариант для моделей без #variant (существующий сохраняется)

РЕЖИМ НАБЛЮДЕНИЯ:
  watch [--debounce <мс>] [задача]
                          Перезапускать консилиум при изменениях в проекте
  hooks install|uninstall Установить/удалить git pre-commit hook

КОМАНДЫ:
  init [--free] [--force] [--dry-run] [--native-v2]
                          Создать конфиг; --free — подобрать и проверить сильнейшие бесплатные модели
  models [--available] [--verify] [--limit N] [--refresh] [--json]
                          Рейтинг бесплатных моделей (models.dev + OpenRouter)
  doctor                  Проверить окружение, конфиг, агентов и модели
  mcp [--install] [--global]
                          Запустить MCP-сервер (stdio) или зарегистрировать его в opencode.json

СОВМЕСТИМОСТЬ:
  Работает с OpenCode V1 и V2. Формат opencode.json определяется автоматически:
  V1-формат (agent/prompt) читают обе версии, нативный V2 (agents/system)
  пишется только по флагу --native-v2.

БЕСПЛАТНЫЕ МОДЕЛИ:
  consilium init --free
    Скачивает каталог моделей, выбирает сильнейшие бесплатные с поддержкой tools
    и прописывает их в opencode.json и consilium.config.json.
    --refresh — обновить кэш, --dry-run — только показать план.

MCP (OpenCode V1/V2, Claude Desktop, Codex, любой MCP-харнесс):
  consilium mcp --install             # ./opencode.json → mcp.servers.consilium (V2) или mcp.consilium (V1)
  consilium mcp --install --global    # глобальный конфиг OpenCode

  Claude Desktop / Codex:
  {
    "mcpServers": {
      "consilium": {
        "command": "npx",
        "args": ["-y", "opencode-consilium", "mcp"]
      }
    }
  }

ПРИМЕРЫ:
  consilium "Оценить архитектуру проекта"
  consilium -e arch,sec "Проверить безопасность API"
  git diff | consilium - --diff "Сделай ревью изменений"
  consilium models --available
  consilium doctor

ДОКУМЕНТАЦИЯ:
  https://github.com/LevapVeeskela/opencode-consilium
`);
}

function readVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(packagePath, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function log(options: CLIOptions, message: string): void {
  if (!options.silent) console.error(message);
}

function setupConsoleHooks(config: ConsiliumConfig, options: CLIOptions): void {
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

function printResult(result: ConsiliumResult, options: CLIOptions): void {
  const format = options.format ?? 'text';
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.text);
}

function printSummary(result: ConsiliumResult, options: CLIOptions): void {
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

async function readTaskFromFile(path: string): Promise<string> {
  if (path === '-') {
    return readStdin();
  }
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    throw new UsageError(`Файл с задачей не найден: ${path}`);
  }
  return readFileSync(resolved, 'utf-8').trim();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1_000_000) {
      throw new UsageError('stdin превышает 1 МБ');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

function applyCliOverrides(config: ConsiliumConfig, options: CLIOptions): ConsiliumConfig {
  let result = config;

  if (options.preset) {
    const known = listPresets().map(preset => preset.name);
    if (!known.includes(options.preset)) {
      throw new UsageError(`Неизвестный пресет: ${options.preset}. Доступны: ${known.join(', ')}`);
    }
    result = applyPreset(result, options.preset);
  }

  if (options.experts) {
    const names = options.experts.split(',').map(name => name.trim()).filter(Boolean);
    const available = new Set(result.experts.map(expert => expert.name));
    const unknown = names.filter(name => !available.has(name));
    if (unknown.length > 0) {
      throw new UsageError(`Неизвестные эксперты: ${unknown.join(', ')}. Доступны: ${[...available].join(', ')}`);
    }
    result.experts = result.experts.filter(expert => names.includes(expert.name));
  }

  if (options.expertTimeout) {
    result.timeouts.expert = options.expertTimeout;
    result.experts = result.experts.map(expert => ({ ...expert, timeout: options.expertTimeout }));
  }
  if (options.chairTimeout) {
    result.timeouts.chair = options.chairTimeout;
    result.chair.timeout = options.chairTimeout;
  }
  if (options.retries !== undefined) {
    result.retry.expertRetries = options.retries;
    result.retry.chairRetries = options.retries;
  }
  if (options.format) result.output.format = options.format;
  if (options.logLevel) result.output.logLevel = options.logLevel;
  if (options.noSave) {
    result.output.file = false;
  } else if (options.output !== undefined) {
    result.output.file = options.output;
  }

  if (options.artifacts !== undefined) result.artifacts = options.artifacts;
  if (options.noArtifacts) result.artifacts = false;
  if (options.consensus === true) result.consensus = true;
  if (options.noConsensus) result.consensus = false;
  if (options.smartExperts) result.smartExperts = true;
  if (options.maxCost !== undefined) result.maxCost = options.maxCost;
  if (options.fallbackModels !== undefined) result.fallbackModels = options.fallbackModels;
  if (options.session !== undefined) result.session = options.session;

  if (options.variant !== undefined) {
    if (!isValidVariant(options.variant)) {
      throw new UsageError(
        `Некорректный вариант модели: ${options.variant} (допустимы буквы, цифры, . _ -)`
      );
    }
    const configVariant = result.variant;
    result.experts = result.experts.map(expert => {
      if (expert.model === undefined || !expert.model.includes('/')) return expert;
      const existing = variantOf(expert.model);
      if (existing === undefined || existing === configVariant) {
        return { ...expert, model: withVariant(expert.model, options.variant) };
      }
      return expert;
    });
    if (result.chair.model !== undefined && result.chair.model.includes('/')) {
      const existing = variantOf(result.chair.model);
      if (existing === undefined || existing === configVariant) {
        result.chair = {
          ...result.chair,
          model: withVariant(result.chair.model, options.variant)
        };
      }
    }
    result.variant = options.variant;
  }

  if (options.report !== undefined) result.report = options.report;
  if (options.reportFile !== undefined) result.reportFile = options.reportFile;
  if (options.debounceMs !== undefined) result.debounceMs = options.debounceMs;

  return result;
}

function printAgentList(config: ConsiliumConfig): void {
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

function printDryRun(task: string, config: ConsiliumConfig): void {
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

async function buildTask(options: CLIOptions): Promise<string> {
  let task = options.task;

  if (options.taskFile) {
    const fromFile = await readTaskFromFile(options.taskFile);
    task = task ? `${fromFile}\n\n${task}` : fromFile;
  }

  if (options.diff || options.diffStaged || options.diffBase) {
    try {
      const diff = await getGitDiff({
        staged: options.diffStaged,
        base: options.diffBase
      });
      const diffText = formatDiffForPrompt(diff);
      task = task
        ? `${task}\n\n${diffText}`
        : `Проведи ревью изменений в коде: найди баги, риски безопасности и предложи улучшения.\n\n${diffText}`;
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }

  return task.trim();
}

/** Определяет формат отчёта по расширению файла */
function inferReportFormat(file: string): ReportFormat {
  const lower = file.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'pr';
  return 'html';
}

/** Рендерит и сохраняет отчёт. Возвращает true, если отчёт напечатан в stdout. */
function writeRunReport(
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

async function commandRun(options: CLIOptions): Promise<number> {
  const loaded = loadConfig(options.config);
  if (options.config && (!loaded.configPath || (loaded.errors?.length ?? 0) > 0)) {
    throw new UsageError(
      loaded.errors?.[0] ?? `Файл конфигурации не найден: ${options.config}`
    );
  }
  if (!options.silent) {
    for (const warning of loaded.warnings) {
      console.error(`⚠️ ${warning}`);
    }
  }

  const config = applyCliOverrides(loaded.config, options);
  if (config.output.logLevel === 'silent') {
    options.silent = true;
  }

  if (options.listAgents) {
    printAgentList(config);
    return 0;
  }

  const artifactsSetting = options.noArtifacts
    ? false
    : options.artifacts ?? config.artifacts;
  const artifactsRoot = resolveArtifactRoot({
    artifacts:
      artifactsSetting !== undefined && artifactsSetting !== false ? artifactsSetting : true,
    cwd: config.cwd
  });

  if (options.diffRuns !== undefined) {
    const [leftId, rightId] = options.diffRuns;
    try {
      const left = loadArtifact(leftId, artifactsRoot);
      const right = loadArtifact(rightId, artifactsRoot);
      console.log(diffArtifacts(left, right));
      return 0;
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }

  let replayArtifact: ArtifactRun | undefined;
  let task: string;
  if (options.replay !== undefined) {
    try {
      replayArtifact = loadArtifact(options.replay, artifactsRoot);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }

    const plan = planReplay(replayArtifact, {
      chairAgent: config.chair.agent,
      artifacts: artifactsSetting
    });
    task = plan.task;

    const byName = new Map(config.experts.map(expert => [expert.name, expert]));
    config.experts = plan.experts.map((expert, index) => {
      const base = byName.get(expert.name) ?? {
        name: expert.name,
        enabled: true,
        priority: index + 1
      };
      return expert.model !== undefined ? { ...base, model: expert.model } : base;
    });

    if (options.experts !== undefined) {
      const requested = options.experts
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0);
      const wanted = new Set(requested);
      const filtered = config.experts.filter(expert => wanted.has(expert.name));

      if (filtered.length === 0) {
        throw new UsageError(
          `В артефакте ${replayArtifact.id} нет экспертов: ${requested.join(', ')}. ` +
            `Доступны: ${plan.experts.map(expert => expert.name).join(', ')}`
        );
      }
      const missing = requested.filter(
        name => !plan.experts.some(expert => expert.name === name)
      );
      if (missing.length > 0 && !options.silent) {
        console.error(`⚠️ Нет в артефакте: ${missing.join(', ')}`);
      }
      config.experts = filtered;
    }
    config.chair = { ...config.chair, agent: plan.chair.agent };
    if (plan.chair.model !== undefined) {
      config.chair = { ...config.chair, model: plan.chair.model };
    }
    if (plan.options.consensus !== undefined) config.consensus = plan.options.consensus;
    if (plan.options.smartExperts !== undefined) config.smartExperts = plan.options.smartExperts;
    if (plan.options.fallbackModels !== undefined) {
      config.fallbackModels = plan.options.fallbackModels;
    }
    if (plan.options.session !== undefined) config.session = plan.options.session;
    if (plan.options.artifacts !== undefined) config.artifacts = plan.options.artifacts;

    if (!options.silent) {
      console.error(`↩️ Повтор артефакта ${replayArtifact.id} (${replayArtifact.createdAt})`);
      for (const warning of plan.warnings) {
        console.error(`⚠️ ${warning}`);
      }
    }
  } else {
    const built = await buildTask(options);
    if (!built) {
      throw new UsageError(
        'Укажите задачу: consilium "Оценить архитектуру" (или передайте её через stdin: consilium -)'
      );
    }
    task = built;
  }

  if (options.dryRun) {
    printDryRun(task, config);
    return 0;
  }

  setupConsoleHooks(config, options);
  const consilium = new Consilium(config);
  if (options.verbose && !options.silent) {
    consilium.onProgress(event => {
      console.error(`[${new Date(event.timestamp).toISOString()}] ${event.type}`, event.agent ?? '');
    });
  }

  let cancelled = false;
  const shutdown = (): void => {
    if (cancelled) process.exit(130);
    cancelled = true;
    console.error('\n⏹️ Отмена...');
    consilium.cancel();
    setTimeout(() => process.exit(130), Math.max(1000, config.timeouts.shutdown)).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const runOptions: RunOptions = {};
  if (options.chair) runOptions.chair = options.chair;
  if (options.output && !options.noSave) runOptions.outputFile = options.output;
  if (replayArtifact !== undefined) {
    runOptions.metadata = { replayOf: replayArtifact.id };
  }

  try {
    const result = await consilium.run(task, runOptions);
    const reportPrinted = writeRunReport(result, config, options);
    if (!reportPrinted) printResult(result, options);
    printSummary(result, options);
    return result.success ? 0 : 1;
  } catch (error) {
    console.error(`\n❌ Ошибка: ${(error as Error).message}`);
    return 1;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temporary, path);
}

/** Путь к глобальному opencode.json(c) */
function resolveGlobalOpenCodePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config');
  const directory = resolve(configHome, 'opencode');
  const json = resolve(directory, 'opencode.json');
  const jsonc = resolve(directory, 'opencode.jsonc');
  return existsSync(json) ? json : existsSync(jsonc) ? jsonc : json;
}

/**
 * Регистрирует MCP-сервер в конфигурации OpenCode в формате установленной версии.
 * V2 пишет `mcp.servers.<name>` и `disabled`, V1 — `mcp.<name>` и `enabled`.
 */
async function commandMcpInstall(options: CLIOptions): Promise<number> {
  const global = options.globalConfig === true;
  const loaded = loadConfig(options.config);
  const cwd = loaded.config.cwd ?? process.cwd();

  const path = global
    ? resolveGlobalOpenCodePath()
    : findOpenCodeConfigPath(loaded.config.opencodeConfigPath, cwd) ??
      resolve(cwd, 'opencode.json');

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = readJsonFile(path);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (error) {
      console.error(`❌ Не удалось прочитать ${path}: ${(error as Error).message}`);
      return 1;
    }
  }

  // Формат MCP-секции определяет установленный CLI, а не формат agent-секции:
  // V2 игнорирует плоские записи mcp.<name>.
  let flavor: 'v1' | 'v2' | undefined;
  try {
    const cliMajor = parseOpenCodeVersion(await getOpenCodeVersion(loaded.config)).major;
    flavor = cliMajor === 2 ? 'v2' : cliMajor === 1 ? 'v1' : undefined;
  } catch {
    flavor = undefined;
  }

  const section = readMcpSection(existing);
  const targetFlavor = flavor ?? section.flavor;
  const installedEntry =
    targetFlavor === 'v2' ? section.servers.consilium : section.flat.consilium;

  if (installedEntry !== undefined && !options.force && !options.dryRun) {
    console.log(`ℹ️ MCP-сервер consilium уже есть в ${path} (используйте --force для обновления).`);
    return 0;
  }

  const upserted = upsertMcpServer(
    existing,
    'consilium',
    { command: ['npx', '-y', 'opencode-consilium', 'mcp'] },
    { flavor: targetFlavor }
  );

  for (const warning of upserted.warnings) {
    log(options, `⚠️ ${warning}`);
  }

  const proposed = {
    $schema:
      typeof existing.$schema === 'string'
        ? existing.$schema
        : 'https://opencode.ai/config.json',
    ...upserted.config
  };

  if (options.dryRun) {
    console.log(JSON.stringify(proposed, null, 2));
    return 0;
  }

  if (path.endsWith('.jsonc')) {
    log(options, '⚠️ Файл .jsonc будет перезаписан без комментариев (они не сохраняются).');
  }

  writeJsonAtomic(path, proposed);
  const key = upserted.key === 'mcp.servers' ? 'mcp.servers.consilium' : 'mcp.consilium';
  const flavorLabel = upserted.flavor === 'v2' ? 'V2' : 'V1';
  console.log(`✅ MCP-сервер зарегистрирован: ${path}`);
  console.log(`   Ключ: ${key} (${flavorLabel}-формат)`);
  console.log('   Проверка: opencode mcp list');
  return 0;
}

async function commandInit(options: CLIOptions): Promise<number> {
  const configPath = resolve(process.cwd(), 'consilium.config.json');

  if (!options.free) {
    if (options.nativeV2 === true) {
      log(options, 'ℹ️ --native-v2 применяется только с --free: он влияет на запись агентов в opencode.json.');
    }
    if (options.dryRun) {
      console.log(generateExampleConfig());
      return 0;
    }
    if (existsSync(configPath) && !options.force) {
      console.error('❌ Файл consilium.config.json уже существует. Используйте --force, чтобы перезаписать.');
      return 1;
    }
    writeFileSync(configPath, `${generateExampleConfig()}\n`, 'utf-8');
    console.log(`✅ Создан ${configPath}`);
    console.log('   Следующий шаг: consilium init --free  (подобрать бесплатные модели)');
    console.log('   Или отредактируйте конфиг вручную и запустите: consilium "ваша задача"');
    return 0;
  }

  log(options, '🔎 Загружаю каталог моделей (models.dev + OpenRouter)...');
  const fetchResult = await fetchFreeModels({
    forceRefresh: options.refresh,
    includeUnavailable: true
  });

  for (const source of fetchResult.sources) {
    if (!source.ok) {
      log(options, `⚠️ ${source.source}: ${source.error ?? 'ошибка'} (использованы другие источники)`);
    }
  }

  let pool = fetchResult.models;
  const verification = [];
  if (!options.noVerify && (!options.dryRun || options.verify)) {
    const available = pool.filter(model => model.available);
    const verificationPool = available.length >= 3 ? available : pool;
    const candidates = verificationPool.slice(0, Math.min(12, verificationPool.length));
    log(options, `🔬 Проверяю ${candidates.length} кандидатов реальным запросом (это бесплатно)...`);
    const checks = await verifyModels(candidates, { timeoutMs: 60000, concurrency: 4 });
    verification.push(...checks);
    const working = checks.filter(check => check.ok).map(check => check.model);
    if (working.length >= 3) {
      pool = working;
    } else {
      log(options, `⚠️ Рабочих моделей: ${working.length}. Использую рейтинг без полной фильтрации.`);
    }
  }

  const council = selectCouncilModels(pool, 5);
  if (council.length === 0) {
    console.error('❌ Не удалось найти бесплатные модели. Попробуйте --refresh позже.');
    return 1;
  }

  const agents = buildCouncilAgents(pool);
  const councilConfig = buildConsiliumConfigFromModels(pool);
  const loadedForPath = loadConfig(options.config);
  const targetCwd = loadedForPath.config.cwd ?? process.cwd();
  const opencodePath =
    findOpenCodeConfigPath(loadedForPath.config.opencodeConfigPath, targetCwd) ??
    resolve(targetCwd, 'opencode.json');

  let existing: Record<string, unknown> = {};
  if (existsSync(opencodePath)) {
    try {
      const parsed = readJsonFile(opencodePath);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (error) {
      console.error(`❌ Не удалось прочитать opencode.json: ${(error as Error).message}`);
      return 1;
    }
  }

  const section = readAgentSection(existing);
  const assignments: Array<{ agent: string; model: string; kept: boolean }> = [];
  const definitions: Record<string, { model?: string; prompt?: string; mode?: string }> = {};

  for (const [name, agent] of Object.entries(agents)) {
    const current = section.entries[name];
    const currentView = current === undefined ? undefined : readAgentDefinition(current);
    const currentModel = currentView?.model;
    const kept = currentModel !== undefined && !options.force;
    const model = kept && currentModel !== undefined ? currentModel : agent.model;

    definitions[name] = {
      model,
      prompt: currentView?.prompt ?? agent.prompt,
      mode: 'primary'
    };
    assignments.push({ agent: name, model, kept });
  }

  const upserted = upsertAgents(existing, definitions, {
    flavor: options.nativeV2 === true ? 'v2' : undefined,
    migrate: options.nativeV2 === true
  });

  for (const warning of upserted.warnings) {
    log(options, `⚠️ ${warning}`);
  }

  const proposedOpenCode = {
    $schema:
      typeof existing.$schema === 'string'
        ? existing.$schema
        : 'https://opencode.ai/config.json',
    ...upserted.config
  };

  const defaultConfig = mergeWithDefaults({
    experts: councilConfig.experts.map(expert => ({ ...expert })),
    chair: { ...councilConfig.chair },
    autoDiscoverAgents: false
  });
  const proposedConsilium = {
    version: defaultConfig.version,
    experts: defaultConfig.experts,
    chair: defaultConfig.chair,
    excludedAgents: defaultConfig.excludedAgents,
    timeouts: defaultConfig.timeouts,
    retry: defaultConfig.retry,
    output: defaultConfig.output,
    standalone: defaultConfig.standalone,
    autoApprove: defaultConfig.autoApprove,
    autoDiscoverAgents: defaultConfig.autoDiscoverAgents,
    opencodeConfigPath: defaultConfig.opencodeConfigPath
  };

  if (options.dryRun) {
    console.log(JSON.stringify({ opencode: proposedOpenCode, consilium: proposedConsilium }, null, 2));
    return 0;
  }

  if (opencodePath.endsWith('.jsonc')) {
    log(options, '⚠️ Файл .jsonc будет перезаписан без комментариев (они не сохраняются).');
  }

  writeJsonAtomic(opencodePath, proposedOpenCode);
  console.log(`✅ Обновлён ${opencodePath}`);

  if (existsSync(configPath) && !options.force) {
    console.error(`⚠️ ${configPath} уже существует — не перезаписан (используйте --force).`);
  } else {
    writeJsonAtomic(configPath, proposedConsilium);
    console.log(`✅ Создан ${configPath}`);
  }

  console.log('\n📋 Состав консилиума (сильнейшие бесплатные модели):');
  for (const item of assignments) {
    console.log(`  • ${item.agent} → ${item.model}${item.kept ? ' (сохранена ваша модель)' : ''}`);
  }

  if (verification.length > 0) {
    console.log('\n🔬 Проверка моделей:');
    for (const check of verification) {
      const status = check.ok ? '✅' : `❌ ${check.error ?? 'недоступна'}`;
      console.log(`  ${status} ${check.model.id}`);
    }
  }
  const cacheNote = fetchResult.fromCache ? 'из кэша' : 'свежий каталог';
  console.log(`\nИсточник: ${cacheNote}, моделей-кандидатов: ${fetchResult.models.length}, выбрано: ${council.length}.`);
  console.log('Запуск: consilium "ваша задача"');
  return 0;
}

async function commandModels(options: CLIOptions): Promise<number> {
  const result = await fetchFreeModels({
    forceRefresh: options.refresh,
    includeUnavailable: !options.available
  });

  const limit = options.limit ?? 20;
  const models = result.models.slice(0, limit);

  let checks = new Map<string, { ok: boolean; error?: string }>();
  if (options.verify) {
    log(options, `🔬 Проверяю ${models.length} моделей реальным запросом...`);
    const verified = await verifyModels(models, { timeoutMs: 60000, concurrency: 4 });
    checks = new Map(verified.map(item => [item.model.id, { ok: item.ok, error: item.error }]));
    const working = verified.filter(item => item.ok).length;
    log(options, `🔬 Рабочих моделей: ${working}/${verified.length}`);
  }

  if (options.json) {
    const enriched = models.map(model => ({ ...model, verified: checks.get(model.id)?.ok }));
    console.log(JSON.stringify({ ...result, models: enriched }, null, 2));
    return 0;
  }

  if (!options.silent) {
    for (const source of result.sources) {
      if (!source.ok) console.error(`⚠️ ${source.source}: ${source.error ?? 'ошибка'}`);
    }
  }

  console.log(`Бесплатные модели (${result.fromCache ? 'кэш' : 'свежие данные'}, всего кандидатов: ${result.models.length}):\n`);
  const header = ['#', 'model', 'ctx', 'tools', 'score', 'доступна', 'источник', 'проверка'];
  console.log(header.join('\t'));
  models.forEach((model, index) => {
    const check = checks.get(model.id);
    console.log([
      String(index + 1),
      model.id,
      `${Math.round(model.context / 1000)}k`,
      model.toolCall ? 'yes' : 'no',
      model.score.toFixed(3),
      model.available ? 'yes' : 'no',
      model.source,
      check ? (check.ok ? 'OK' : `FAIL: ${check.error ?? ''}`) : (options.verify ? '-' : 'не проверялась')
    ].join('\t'));
  });
  if (models.length === 0) {
    console.log('Нет моделей по заданным критериям.');
  }
  return 0;
}

async function commandDoctor(options: CLIOptions): Promise<number> {
  const loaded = loadConfig(options.config);
  if (loaded.warnings.length > 0 && !options.silent) {
    for (const warning of loaded.warnings) {
      console.error(`⚠️ ${warning}`);
    }
  }
  const checks = await runDoctor(loaded.config, {
    configPath: loaded.configPath,
    cwd: process.cwd(),
    checkModels: true
  });
  console.log(formatDoctorReport(checks));
  if ((loaded.errors?.length ?? 0) > 0) {
    return 1;
  }
  return checks.some(check => check.status === 'fail') ? 1 : 0;
}

/**
 * Watch-режим: перезапускает консилиум при изменениях в проекте.
 */
async function commandWatch(options: CLIOptions): Promise<number> {
  if (options.replay !== undefined) {
    throw new UsageError('watch не поддерживает --replay');
  }
  if (options.diffRuns !== undefined) {
    throw new UsageError('watch не поддерживает --diff-runs');
  }
  if (options.taskFile === '-') {
    throw new UsageError('watch не читает задачу из stdin (-)');
  }

  const loaded = loadConfig(options.config);
  if (!options.silent) {
    for (const warning of loaded.warnings) {
      console.error(`⚠️ ${warning}`);
    }
  }
  const config = applyCliOverrides(loaded.config, options);
  const cwd = config.cwd ?? process.cwd();
  const task =
    options.task.trim().length > 0 ? options.task.trim() : 'Сделай ревью текущих изменений';
  const debounceMs = config.debounceMs ?? 400;

  const ignore: string[] = [];
  const addIgnore = (value: string | undefined): void => {
    if (value === undefined || value.trim().length === 0) return;
    const target = resolve(cwd, value);
    const rel = relative(cwd, target);
    if (rel.length > 0 && !rel.startsWith('..')) {
      ignore.push(rel.replace(/\\/g, '/'));
    }
  };
  addIgnore(options.output ?? (typeof config.output.file === 'string' ? config.output.file : undefined));
  addIgnore(options.reportFile ?? config.reportFile);
  if (config.artifacts !== undefined && config.artifacts !== false) {
    try {
      addIgnore(resolveArtifactRoot({ artifacts: config.artifacts, cwd }));
    } catch {
      // Некорректный каталог артефактов отловит сам запуск
    }
  }

  if (!options.silent) {
    console.error(`👀 watch: ${cwd} (debounce ${debounceMs} мс), Ctrl+C — выход`);
    if (ignore.length > 0) console.error(`   игнорирую выводы: ${ignore.join(', ')}`);
  }

  let running = false;
  let pending = false;
  let closed = false;
  let active: Consilium | undefined;

  const runOnce = async (): Promise<void> => {
    if (running || closed) {
      pending = true;
      return;
    }
    running = true;
    try {
      let baseTask = task;
      if (options.taskFile !== undefined) {
        const fromFile = await readTaskFromFile(options.taskFile);
        if (fromFile.trim().length > 0) baseTask = fromFile.trim();
      }

      let fullTask = baseTask;
      try {
        const diff = await getGitDiff({
          cwd,
          staged: options.diffStaged,
          base: options.diffBase
        });
        if (diff.filesChanged > 0) {
          fullTask = `${baseTask}\n\n${formatDiffForPrompt(diff)}`;
        }
      } catch {
        // Вне git-репозитория работаем с задачей как есть
      }

      if (options.dryRun) {
        printDryRun(fullTask, config);
        return;
      }

      if (!options.silent) console.error('\n🔄 Запуск консилиума...');
      active = new Consilium(config);
      const result = await active.run(fullTask);
      const reportPrinted = writeRunReport(result, config, options);
      if (!reportPrinted) printResult(result, options);
      printSummary(result, options);
    } catch (error) {
      console.error(`❌ ${(error as Error).message}`);
    } finally {
      active = undefined;
      running = false;
      if (pending && !closed) {
        pending = false;
        void runOnce();
      }
    }
  };

  let watcher: { close(): void };
  try {
    watcher = createProjectWatcher({
      cwd,
      debounceMs,
      ignore,
      onTrigger: () => {
        void runOnce();
      }
    });
  } catch (error) {
    console.error(`❌ Не удалось запустить watch: ${(error as Error).message}`);
    return 1;
  }

  await runOnce();

  await new Promise<void>(resolve => {
    const shutdown = (): void => {
      closed = true;
      active?.cancel();
      watcher.close();
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}

/** Устанавливает или удаляет git pre-commit hook */
async function commandHooks(options: CLIOptions): Promise<number> {
  const cwd = process.cwd();

  if (options.hookAction === undefined) {
    console.error('❌ Укажите действие: consilium hooks install|uninstall');
    return 2;
  }

  if (options.hookAction === 'uninstall') {
    const removed = uninstallPreCommitHook(cwd);
    console.log(
      removed
        ? '✅ consilium-блок удалён из pre-commit'
        : 'ℹ️ consilium-блок в pre-commit не найден'
    );
    return 0;
  }

  const hookCommand =
    'npx -y opencode-consilium --staged -s "Ревью staged-изменений" || exit 1';
  try {
    const hook = installPreCommitHook(cwd, hookCommand);
    console.log(`✅ pre-commit hook ${hook.created ? 'создан' : 'обновлён'}: ${hook.path}`);
    console.log(`   ${hookCommand}`);
    return 0;
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`);
    return 1;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: CLIOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`❌ ${error.message}`);
      return 2;
    }
    throw error;
  }

  const command = options.command ?? 'run';

  try {
    switch (command) {
      case 'help':
        printHelp();
        return 0;
      case 'version':
        console.log(`consilium v${readVersion()}`);
        return 0;
      case 'init':
        return await commandInit(options);
      case 'models':
        return await commandModels(options);
      case 'doctor':
        return await commandDoctor(options);
      case 'mcp': {
        if (options.mcpInstall === true) {
          return await commandMcpInstall(options);
        }
        if (!options.silent) console.error('opencode-consilium MCP server (stdio). Логи — в stderr.');
        await startMcpServer({ version: readVersion() });
        return 0;
      }
      case 'watch':
        return await commandWatch(options);
      case 'hooks':
        return await commandHooks(options);
      case 'run':
        return await commandRun(options);
      default:
        console.error(`❌ Неизвестная команда: ${command}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`❌ ${error.message}`);
      return 2;
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedDirectly) {
  main()
    .then(code => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error('💥 Критическая ошибка:', error);
      process.exitCode = 1;
    });
}
