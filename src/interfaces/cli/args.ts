/**
 * @fileoverview Разбор аргументов командной строки consilium
 * @module lv24-opencode-consilium/cli/args
 */

import type { CLIOptions } from '../../domain/types.js';
import {
  FAIL_ON_LEVELS,
  type FailOnLevel
} from '../../domain/artifacts/baseline.js';

export const COMMANDS = new Set([
  'run',
  'init',
  'models',
  'doctor',
  'mcp',
  'watch',
  'hooks',
  'baseline',
  'eval',
  'history',
  'stats',
  'presets',
  'audit',
  'sarif',
  'help',
  'version'
]);

/** Команды, у которых есть собственные позиционные аргументы (задача/действие) */
const COMMANDS_WITH_POSITIONAL_ARGS = new Set(['run', 'watch', 'hooks', 'baseline', 'audit']);

/** Команды, распознаваемые только в самом начале argv (не после флагов) */
const START_ONLY_COMMANDS = new Set([
  'baseline',
  'eval',
  'history',
  'stats',
  'presets',
  'audit',
  'sarif'
]);

/** Типизированные коды выхода CLI */
export const EXIT_CODES = {
  success: 0,
  runFailed: 1,
  usage: 2,
  policyGate: 3
} as const;

/** Код выхода CLI */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class UsageError extends Error {}

export function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || (value.startsWith('-') && value !== '-')) {
    throw new UsageError(`Флаг ${flag} требует значение`);
  }
  return value;
}

export function requireNumericValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new UsageError(`Флаг ${flag} требует значение`);
  }
  return value;
}

export function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`Флаг ${flag} ожидает положительное целое число, получено: ${value}`);
  }
  return parsed;
}

export function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`Флаг ${flag} ожидает целое число >= 0, получено: ${value}`);
  }
  return parsed;
}

export function parseNonNegativeFloat(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`Флаг ${flag} ожидает число >= 0, получено: ${value}`);
  }
  return parsed;
}

export function parsePercent(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new UsageError(`Флаг ${flag} ожидает число от 0 до 100, получено: ${value}`);
  }
  return parsed;
}

export function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

/**
 * Парсит аргументы командной строки
 */
export function parseArgs(argv: string[]): CLIOptions {
  const options: CLIOptions = { task: '', failOn: 'none' };
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
      case '--deadline':
        options.deadlineMs = parsePositiveInt(requireNumericValue(argv, ++i, arg), arg);
        break;
      case '--rounds': {
        const value = requireValue(argv, ++i, arg);
        if (value !== '1' && value !== '2') {
          throw new UsageError(`Флаг --rounds ожидает 1 или 2, получено: ${value}`);
        }
        options.rounds = value === '2' ? 2 : 1;
        break;
      }
      case '--compare-rounds':
        options.compareRounds = true;
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
      case '--html':
        options.statsHtml = requireValue(argv, ++i, arg);
        break;
      case '--task-file':
        options.taskFile = requireValue(argv, ++i, arg);
        break;
      case '--base':
        options.diffBase = requireValue(argv, ++i, arg);
        break;
      case '--since':
        options.since = requireValue(argv, ++i, arg);
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
      case '--local':
        options.local = true;
        break;
      case '--local-only':
        options.localOnly = true;
        break;
      case '--probe-local':
        options.probeLocal = true;
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
      case '--fixtures':
        options.fixtures = requireValue(argv, ++i, arg);
        break;
      case '--fail-under':
        options.failUnder = parsePercent(requireNumericValue(argv, ++i, arg), arg);
        break;
      case '--context': {
        const mode = requireValue(argv, ++i, arg);
        if (mode !== 'off' && mode !== 'auto') {
          throw new UsageError(`Флаг --context ожидает off или auto, получено: ${mode}`);
        }
        options.context = mode;
        break;
      }
      case '--reliability':
        options.reliability = true;
        break;
      case '--fail-on': {
        const level = requireValue(argv, ++i, arg);
        if (!(FAIL_ON_LEVELS as readonly string[]).includes(level)) {
          throw new UsageError(
            `Флаг --fail-on ожидает ${FAIL_ON_LEVELS.join(', ')}, получено: ${level}`
          );
        }
        options.failOn = level as FailOnLevel;
        break;
      }
      case '--older-than':
        options.olderThan = parseNonNegativeInt(requireNumericValue(argv, ++i, arg), arg);
        break;
      case '--all':
        options.all = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--fallback-models':
        options.fallbackModels = parseCsv(requireValue(argv, ++i, arg));
        break;
      case '--session':
        options.session = requireValue(argv, ++i, arg);
        break;
      case '--report': {
        const format = requireValue(argv, ++i, arg);
        if (
          format !== 'html' &&
          format !== 'pr' &&
          format !== 'markdown' &&
          format !== 'sarif' &&
          format !== 'jira' &&
          format !== 'linear'
        ) {
          throw new UsageError(
            `Неизвестный формат отчёта: ${format} (html, pr, markdown, sarif, jira, linear)`
          );
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
      case '--findings':
        options.findings = true;
        break;
      case '--no-findings':
        options.noFindings = true;
        break;
      case '--smart-experts':
        options.smartExperts = true;
        break;
      case '--replay':
        options.replay = requireValue(argv, ++i, arg);
        break;
      case '--run':
        options.run = requireValue(argv, ++i, arg);
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
          // baseline, eval, history и stats — команды только в самом начале argv,
          // чтобы слово в задаче или после флагов не переключало режим.
          if (START_ONLY_COMMANDS.has(arg) && i === 0) {
            options.command = arg as CLIOptions['command'];
          } else if (
            !START_ONLY_COMMANDS.has(arg) &&
            options.command === undefined &&
            taskParts.length === 0 &&
            COMMANDS.has(arg)
          ) {
            // Команда распознаётся только до первого слова задачи; флаги перед
            // ней не считаются частью задачи.
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

  if (options.compareRounds === true && options.rounds !== undefined) {
    throw new UsageError(
      'Флаги --compare-rounds и --rounds взаимоисключающие: выберите один.'
    );
  }

  options.task = taskParts.join(' ').trim();
  // Если первое слово совпало с командой без позиционных аргументов, но после
  // него идёт текст задачи, это задача, а не команда: "models should be cached".
  if (
    options.command !== undefined &&
    !COMMANDS_WITH_POSITIONAL_ARGS.has(options.command) &&
    options.task.length > 0
  ) {
    taskParts.unshift(options.command);
    options.command = undefined;
    options.task = taskParts.join(' ').trim();
  }
  if (options.command === 'hooks') {
    const action = options.task.trim();
    if (action === 'install' || action === 'uninstall') {
      options.hookAction = action;
      options.task = '';
    }
  }
  if (options.command === 'baseline') {
    const parts = options.task.trim().length > 0 ? options.task.trim().split(/\s+/) : [];
    const action = parts[0];
    if (action === 'accept' || action === 'prune') {
      options.baselineAction = action;
      options.baselineTarget =
        parts.length > 1 ? parts.slice(1).join(' ').trim() : undefined;
      options.task = '';
    }
  }
  if (options.help) options.command = 'help';
  if (options.version) options.command = 'version';
  if (options.init && options.command === undefined) options.command = 'init';
  if (options.command === 'init' && options.free === true && options.local === true) {
    throw new UsageError('Флаги --free и --local взаимоисключающие: выберите один.');
  }
  return options;
}
