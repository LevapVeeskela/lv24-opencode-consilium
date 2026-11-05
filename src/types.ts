/**
 * @fileoverview Типы публичного API Consilium
 * @module opencode-consilium
 */

/** Код ошибки агента */
export type AgentErrorCode =
  | 'TIMEOUT'
  | 'EMPTY_RESPONSE'
  | 'SPAWN_ERROR'
  | 'PARSE_ERROR'
  | 'EXIT_ERROR'
  | 'CANCELLED'
  | 'AGENT_NOT_FOUND'
  | 'MODEL_UNAVAILABLE';

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
  /** Токены и стоимость */
  usage?: AgentUsage;
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
  metadata?: Record<string, unknown>;
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
  metadata?: Record<string, unknown>;
  /** Пресет (fast, deep, security, review) */
  preset?: string;
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
  command?: 'run' | 'init' | 'models' | 'doctor' | 'mcp' | 'help' | 'version';
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
}
