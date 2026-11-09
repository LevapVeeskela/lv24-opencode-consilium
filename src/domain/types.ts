/**
 * @fileoverview Типы публичного API Consilium
 * @module lv24-opencode-consilium
 */

import type { FindingsSummary } from './council/findings.js';
import type { FailOnLevel } from './artifacts/baseline.js';
import type { CouncilPreset } from './council/presets.js';

/** Формат отчёта. */
export type ReportFormat = 'html' | 'pr' | 'markdown' | 'sarif';

/** Код ошибки агента */
export type AgentErrorCode =
  | 'TIMEOUT'
  | 'EMPTY_RESPONSE'
  | 'SPAWN_ERROR'
  | 'PARSE_ERROR'
  | 'EXIT_ERROR'
  | 'CANCELLED'
  | 'AGENT_NOT_FOUND'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'COST_LIMIT'
  | 'DEADLINE';

/** Расход токенов и стоимость одного вызова */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

/**
 * Результат одного агента
 */
export interface AgentResult {
  /** Имя агента */
  agent: string;
  /** Фактически использованная модель (provider/model) */
  model?: string;
  /** Текст ответа */
  text: string;
  /** Успешность выполнения */
  success: boolean;
  /** Длительность в мс (включая retry) */
  duration?: number;
  /** Код ошибки (если есть) */
  errorCode?: AgentErrorCode;
  /** Человекочитаемое сообщение об ошибке */
  errorMessage?: string;
  /** Номер попытки */
  attempt?: number;
  /** Код выхода процесса OpenCode */
  exitCode?: number | null;
  /** Задержка до повтора, которую сообщил провайдер (мс) */
  retryAfterMs?: number;
  /** Идентификатор сессии OpenCode, в которой выполнялся агент */
  sessionId?: string;
  /** Токены и стоимость */
  usage?: AgentUsage;
}

/**
 * Метаданные результата консилиума
 */
export interface ConsiliumMetadata extends Record<string, unknown> {
  /** Сводка структурированных находок (только при findings: true) */
  findings?: FindingsSummary;
}

/**
 * Результат консилиума
 */
export interface ConsiliumResult {
  /** Итоговый текст председателя */
  text: string;
  /** Результаты экспертов */
  experts: AgentResult[];
  /** Результат председателя */
  chair: AgentResult;
  /** Общее время выполнения, мс */
  totalTime: number;
  /** Реальное wall-clock время параллельной фазы экспертов, мс */
  parallelTime: number;
  /** Успешность */
  success: boolean;
  /** Суммарный расход токенов и стоимость */
  usage?: AgentUsage;
  /** Дополнительные данные */
  metadata?: ConsiliumMetadata;
}

/**
 * Конфигурация эксперта
 */
export interface ExpertConfig {
  /** Имя агента */
  name: string;
  /** Модель в формате provider/model (передаётся как --model) */
  model?: string;
  /** Промпт эксперта (${task} заменяется на задачу) */
  prompt?: string | ((task: string) => string);
  /** Таймаут в мс */
  timeout?: number;
  /** Количество повторных попыток */
  retries?: number;
  /** Приоритет (для сортировки) */
  priority?: number;
  /** Включён ли эксперт */
  enabled?: boolean;
}

/**
 * Конфигурация председателя
 */
export interface ChairConfig {
  /** Имя агента-председателя */
  agent: string;
  /** Модель в формате provider/model */
  model?: string;
  /** Таймаут в мс */
  timeout?: number;
  /** Кастомный шаблон промпта */
  promptTemplate?: (task: string, experts: AgentResult[]) => string;
  /** Максимальная длина текста одного эксперта в промпте */
  maxExpertTextLength?: number;
}

/**
 * Хуки жизненного цикла
 */
export interface ConsiliumHooks {
  onStart?: (task: string, config: ConsiliumConfig) => void | Promise<void>;
  onExpertStart?: (expert: string, task: string) => void | Promise<void>;
  onExpertEnd?: (result: AgentResult) => void | Promise<void>;
  onExpertError?: (result: AgentResult) => void | Promise<void>;
  onChairStart?: (task: string, experts: AgentResult[]) => void | Promise<void>;
  onChairEnd?: (result: AgentResult) => void | Promise<void>;
  onChairError?: (result: AgentResult) => void | Promise<void>;
  onEnd?: (result: ConsiliumResult) => void | Promise<void>;
  onError?: (error: Error, context?: unknown) => void | Promise<void>;
  onLog?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/**
 * Настройки таймаутов
 */
export interface TimeoutConfig {
  /** Таймаут эксперта, мс */
  expert: number;
  /** Таймаут председателя, мс */
  chair: number;
  /** Таймаут graceful shutdown, мс */
  shutdown: number;
}

/**
 * Настройки retry
 */
export interface RetryConfig {
  expertRetries: number;
  chairRetries: number;
  delay: number;
  exponentialBackoff: boolean;
  /** Максимальное число одновременно работающих агентов */
  maxConcurrency: number;
  /** Добавлять джиттер к задержке повторов */
  jitter?: boolean;
}

/**
 * Настройки вывода
 */
export interface OutputConfig {
  /** Файл для сохранения результата (false — не сохранять) */
  file: string | false;
  /** Формат файла: text, markdown, json */
  format: 'text' | 'markdown' | 'json';
  /** Показывать прогресс */
  progress: boolean;
  /** Уровень логирования */
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}

/**
 * Полная конфигурация
 */
export interface ConsiliumConfig {
  version?: string;
  experts: ExpertConfig[];
  chair: ChairConfig;
  excludedAgents?: string[];
  timeouts: TimeoutConfig;
  retry: RetryConfig;
  output: OutputConfig;
  hooks?: ConsiliumHooks;
  /** Рабочая директория для запуска opencode */
  cwd?: string;
  /** Путь к opencode CLI */
  opencodePath?: string;
  /** Дополнительные аргументы opencode */
  opencodeArgs?: string[];
  /** Автоопределение агентов из opencode.json */
  autoDiscoverAgents?: boolean;
  /** Путь к opencode.json */
  opencodeConfigPath?: string;
  /** Использовать приватный сервер (--standalone), чтобы не конфликтовать с запущенным OpenCode */
  standalone?: boolean;
  /** Авто-подтверждение разрешений (--auto) */
  autoApprove?: boolean;
  /** Плагины (инициализируются перед запуском) */
  plugins?: ConsiliumPlugin[];
  /** Сохранять артефакты запусков (true → .consilium/runs, строка → путь) */
  artifacts?: boolean | string;
  /** Добавлять анализ согласия экспертов в промпт председателя и метаданные */
  consensus?: boolean;
  /** Запрашивать структурированные находки в ответах и собирать metadata.findings */
  findings?: boolean;
  /** Автоматически выбирать экспертов по задаче/диффу */
  smartExperts?: boolean;
  /** Лимит стоимости запуска в USD; при превышении председатель не запускается */
  maxCost?: number;
  /** Использовать только локальные провайдеры моделей */
  localOnly?: boolean;
  /** Пользовательские пресеты: имя пресета → частичное описание */
  presets?: Record<string, Partial<CouncilPreset>>;
  /**
   * Общий wall-clock дедлайн фазы экспертов, мс.
   * Положительное целое, не больше 24 часов; 0/отрицательное игнорируется.
   */
  deadlineMs?: number;
  /**
   * Число раундов дебатов: 1 (по умолчанию) или 2.
   * Значения, отличные от 2, трактуются как 1.
   */
  rounds?: number;
  /** Запасные модели для RATE_LIMITED/MODEL_UNAVAILABLE (в порядке приоритета) */
  fallbackModels?: string[];
  /** Переиспользовать сессию OpenCode (`run --session`) между запусками */
  session?: string;
  /** Формат отчёта после запуска */
  report?: ReportFormat;
  /** Файл отчёта (по умолчанию stdout) */
  reportFile?: string;
  /** Вариант модели (`provider/model#variant`) для всех агентов */
  variant?: string;
  /** Задержка watch-режима, мс */
  debounceMs?: number;
  /** Автосбор контекста проекта: off (по умолчанию) или auto */
  context?: 'off' | 'auto';
}

/**
 * Плагин
 */
export interface ConsiliumPlugin {
  name: string;
  version?: string;
  init?: (config: ConsiliumConfig) => ConsiliumConfig | Promise<ConsiliumConfig>;
  hooks?: Partial<ConsiliumHooks>;
}

/**
 * Опции запуска
 */
export interface RunOptions {
  /** Имена экспертов */
  experts?: string[];
  /** Имя председателя */
  chair?: string;
  /** Общий таймаут (переопределяет expert timeout) */
  timeout?: number;
  /** Файл для сохранения */
  outputFile?: string;
  /** Тихий режим */
  silent?: boolean;
  /** Дополнительные хуки */
  hooks?: Partial<ConsiliumHooks>;
  /** Метаданные */
  metadata?: ConsiliumMetadata;
  /** Пресет (fast, deep, security, review) */
  preset?: string;
  /** Сохранять артефакт запуска */
  artifacts?: boolean | string;
  /** Переопределить анализ согласия */
  consensus?: boolean;
  /** Переопределить сбор структурированных находок */
  findings?: boolean;
  /** Переопределить умный выбор экспертов */
  smartExperts?: boolean;
  /** Лимит стоимости запуска в USD */
  maxCost?: number;
  /**
   * Общий wall-clock дедлайн фазы экспертов, мс.
   * Положительное целое, не больше 24 часов; 0/отрицательное игнорируется.
   */
  deadlineMs?: number;
  /**
   * Число раундов дебатов: 1 (по умолчанию) или 2.
   * Значения, отличные от 2, трактуются как 1.
   */
  rounds?: number;
  /** Запасные модели для RATE_LIMITED/MODEL_UNAVAILABLE */
  fallbackModels?: string[];
  /** Сессия OpenCode для продолжения контекста */
  session?: string;
}

/**
 * Статус консилиума
 */
export type ConsiliumStatus =
  | 'idle'
  | 'running_experts'
  | 'running_chair'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Событие прогресса
 */
export interface ProgressEvent {
  type: 'expert_start' | 'expert_end' | 'chair_start' | 'chair_end' | 'error';
  agent?: string;
  status: ConsiliumStatus;
  progress: number;
  timestamp: number;
  data?: unknown;
}

export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Опции CLI
 */
export interface CLIOptions {
  task: string;
  command?:
    | 'run'
    | 'init'
    | 'models'
    | 'doctor'
    | 'mcp'
    | 'watch'
    | 'hooks'
    | 'baseline'
    | 'eval'
    | 'history'
    | 'stats'
    | 'presets'
    | 'audit'
    | 'sarif'
    | 'help'
    | 'version';
  config?: string;
  experts?: string;
  chair?: string;
  expertTimeout?: number;
  chairTimeout?: number;
  output?: string;
  format?: 'text' | 'markdown' | 'json';
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  retries?: number;
  silent?: boolean;
  help?: boolean;
  version?: boolean;
  verbose?: boolean;
  listAgents?: boolean;
  init?: boolean;
  dryRun?: boolean;
  /** Пресет */
  preset?: string;
  /** Скачать/использовать бесплатные модели */
  free?: boolean;
  /** Обновить кэш каталога моделей */
  refresh?: boolean;
  /** Лимит вывода моделей */
  limit?: number;
  /** Только доступные (есть ключ) модели */
  available?: boolean;
  /** JSON-вывод */
  json?: boolean;
  /** Применить изменения (init --free) */
  apply?: boolean;
  /** Перезаписать существующие модели агентов */
  force?: boolean;
  /** Файл с задачей */
  taskFile?: string;
  /** Добавить git diff к задаче */
  diff?: boolean;
  /** git diff --staged */
  diffStaged?: boolean;
  /** git diff <base> */
  diffBase?: string;
  /** Не сохранять результат */
  noSave?: boolean;
  /** Проверить модели реальным коротким запросом */
  verify?: boolean;
  /** Пропустить проверку моделей */
  noVerify?: boolean;
  /** Путь/каталог артефактов (true → .consilium/runs) */
  artifacts?: string | boolean;
  /** Не сохранять артефакты */
  noArtifacts?: boolean;
  /** Умный выбор экспертов по задаче/диффу */
  smartExperts?: boolean;
  /** Отключить анализ согласия */
  noConsensus?: boolean;
  /** Включить структурированные находки */
  findings?: boolean;
  /** Отключить структурированные находки */
  noFindings?: boolean;
  /** Отключить джиттер retry */
  noJitter?: boolean;
  /** Повторить сохранённый запуск (файл артефакта) */
  replay?: string;
  /** (sarif) id артефакта или latest */
  run?: string;
  /** Сравнить два артефакта */
  diffRuns?: [string, string];
  /** Каталог артефактов (переопределяет .consilium/runs) */
  artifactsDir?: string;
  /** Включить анализ согласия */
  consensus?: boolean;
  /** Лимит стоимости запуска в USD */
  maxCost?: number;
  /** Дедлайн экспертной фазы, мс */
  deadlineMs?: number;
  /** Число раундов дебатов: 1 или 2 */
  rounds?: 1 | 2;
  /** (eval) Сравнить прогоны с rounds=1 и rounds=2 */
  compareRounds?: boolean;
  /** Git ref, с которого начинается аудит изменений */
  since?: string;
  /** Разрешить только локальные модели */
  localOnly?: boolean;
  /** (models) Показать только локальные модели каталога */
  local?: boolean;
  /** (models) Проверить доступность Ollama и LM Studio */
  probeLocal?: boolean;
  /** Запасные модели при RATE_LIMITED/MODEL_UNAVAILABLE */
  fallbackModels?: string[];
  /** Сессия OpenCode для продолжения контекста */
  session?: string;
  /** Формат отчёта после запуска */
  report?: ReportFormat;
  /** Файл отчёта (по умолчанию stdout) */
  reportFile?: string;
  /** Файл для HTML-отчёта команды stats */
  statsHtml?: string;
  /** Вариант модели (`provider/model#variant`) для всех агентов */
  variant?: string;
  /** Задержка watch-режима, мс */
  debounceMs?: number;
  /** Каталог eval-фикстур (по умолчанию eval/fixtures) */
  fixtures?: string;
  /** Минимальный catch rate eval в процентах (0..100); ниже — код 3 */
  failUnder?: number;
  /** Автосбор контекста проекта */
  context?: 'off' | 'auto';
  /** Показать статистику надёжности моделей */
  reliability?: boolean;
  /** Порог политики: завершиться с кодом 3 при находках не ниже уровня */
  failOn?: FailOnLevel;
  /** Действие команды baseline */
  baselineAction?: 'accept' | 'prune';
  /** Аргумент baseline accept: id артефакта или latest */
  baselineTarget?: string;
  /** Удалить записи baseline старше N дней */
  olderThan?: number;
  /** Удалить все записи baseline */
  all?: boolean;
  /** Подтвердить опасное действие */
  yes?: boolean;
  /** Действие команды hooks */
  hookAction?: 'install' | 'uninstall';
  /** Писать нативный V2-формат конфигурации OpenCode */
  nativeV2?: boolean;
  /** Зарегистрировать MCP-сервер в конфигурации OpenCode */
  mcpInstall?: boolean;
  /** Использовать глобальную конфигурацию OpenCode */
  globalConfig?: boolean;
}
