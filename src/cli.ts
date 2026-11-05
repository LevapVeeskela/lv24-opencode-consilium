#!/usr/bin/env node

/**
 * @fileoverview CLI интерфейс для Consilium
 * @module opencode-consilium/cli
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { CLIOptions, ConsiliumConfig, ConsiliumResult, RunOptions } from './types.js';
import { Consilium, loadConfig, generateExampleConfig, mergeWithDefaults } from './index.js';
import { buildCouncilAgents, buildConsiliumConfigFromModels, fetchFreeModels, selectCouncilModels } from './models.js';
import { applyPreset, listPresets } from './presets.js';
import { getGitDiff, formatDiffForPrompt } from './git.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { verifyModels } from './verify.js';
import { startMcpServer } from './mcp.js';
import { readJsonFile } from './config.js';

const COMMANDS = new Set(['run', 'init', 'models', 'doctor', 'mcp', 'help', 'version']);

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

КОМАНДЫ:
  init [--free] [--force] [--dry-run]
                          Создать конфиг; --free — подобрать и проверить сильнейшие бесплатные модели
  models [--available] [--verify] [--limit N] [--refresh] [--json]
                          Рейтинг бесплатных моделей (models.dev + OpenRouter)
  doctor                  Проверить окружение, конфиг, агентов и модели
  mcp                     Запустить MCP-сервер (stdio) для любого харнеса

БЕСПЛАТНЫЕ МОДЕЛИ:
  consilium init --free
    Скачивает каталог моделей, выбирает сильнейшие бесплатные с поддержкой tools
    и прописывает их в opencode.json и consilium.config.json.
    --refresh — обновить кэш, --dry-run — только показать план.

MCP (Claude Desktop / Codex / любой MCP-харнесс):
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

  const task = await buildTask(options);
  if (!task) {
    throw new UsageError('Укажите задачу: consilium "Оценить архитектуру" (или передайте её через stdin: consilium -)');
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

  try {
    const result = await consilium.run(task, runOptions);
    printResult(result, options);
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

async function commandInit(options: CLIOptions): Promise<number> {
  const configPath = resolve(process.cwd(), 'consilium.config.json');

  if (!options.free) {
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
  const opencodeJson = resolve(process.cwd(), 'opencode.json');
  const opencodeJsonc = resolve(process.cwd(), 'opencode.jsonc');
  const opencodePath = existsSync(opencodeJson)
    ? opencodeJson
    : existsSync(opencodeJsonc)
      ? opencodeJsonc
      : opencodeJson;

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

  const existingAgents =
    existing.agent && typeof existing.agent === 'object' && !Array.isArray(existing.agent)
      ? (existing.agent as Record<string, unknown>)
      : {};

  const mergedAgents: Record<string, unknown> = { ...existingAgents };
  const assignments: Array<{ agent: string; model: string; kept: boolean }> = [];

  for (const [name, agent] of Object.entries(agents)) {
    const current = existingAgents[name];
    const currentModel =
      current && typeof current === 'object' && typeof (current as { model?: unknown }).model === 'string'
        ? (current as { model: string }).model
        : undefined;
    const kept = currentModel !== undefined && !options.force;
    mergedAgents[name] = {
      ...(current && typeof current === 'object' ? current : {}),
      mode: 'primary',
      model: kept ? currentModel : agent.model,
      prompt:
        current && typeof current === 'object' && typeof (current as { prompt?: unknown }).prompt === 'string'
          ? (current as { prompt: string }).prompt
          : agent.prompt
    };
    assignments.push({ agent: name, model: kept ? currentModel : agent.model, kept });
  }

  const proposedOpenCode = {
    $schema: typeof existing.$schema === 'string' ? existing.$schema : 'https://opencode.ai/config.json',
    ...existing,
    agent: mergedAgents
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
 * Точка входа CLI. Возвращает код выхода.
 */
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
        if (!options.silent) console.error('opencode-consilium MCP server (stdio). Логи — в stderr.');
        await startMcpServer({ version: readVersion() });
        return 0;
      }
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
