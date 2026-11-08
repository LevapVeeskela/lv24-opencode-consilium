/**
 * @fileoverview Диагностика окружения и конфигурации Consilium
 * @module opencode-consilium
 */

import { accessSync, constants, existsSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import type { ConsiliumConfig } from './types.js';
import { getOpenCodeVersion } from './agents.js';
import { fetchFreeModels } from './models.js';
import { findOpenCodeConfigPath, readJsonFile } from './config.js';
import { resolveArtifactRoot } from './artifacts.js';
import {
  describeConfigFlavor,
  findLegacyV1Fields,
  parseOpenCodeVersion,
  readAgentDefinition,
  readAgentSection,
  readMcpSection
} from './compat.js';

/** Результат одной проверки */
export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  hint?: string;
}

/** Опции диагностики */
export interface DoctorOptions {
  configPath?: string | null;
  cwd?: string;
  checkModels?: boolean;
}

/** Паттерн допустимой модели provider/model */
const MODEL_PATTERN = /^[A-Za-z0-9._:@\/#+-]+$/;

/** Проверяет, является ли значение обычным объектом */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Извлекает текст ошибки */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ограничивает список имён в сообщении */
function formatNames(names: string[], limit = 5): string {
  if (names.length <= limit) {
    return names.join(', ');
  }
  return `${names.slice(0, limit).join(', ')} и ещё ${names.length - limit}`;
}

/** Находит дубликаты в списке имён */
function findDuplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      duplicates.add(name);
    } else {
      seen.add(name);
    }
  }
  return [...duplicates];
}

/** Собирает валидные имена экспертов */
function collectExpertNames(config: ConsiliumConfig): string[] {
  const names: string[] = [];
  if (!Array.isArray(config.experts)) {
    return names;
  }
  for (const expert of config.experts) {
    if (isRecord(expert) && typeof expert.name === 'string' && expert.name.trim().length > 0) {
      names.push(expert.name.trim());
    }
  }
  return names;
}

/** Ссылка на модель агента */
interface ModelRef {
  owner: string;
  model: string;
}

/** Собирает модели экспертов и председателя */
function collectModelRefs(config: ConsiliumConfig): ModelRef[] {
  const refs: ModelRef[] = [];

  if (Array.isArray(config.experts)) {
    config.experts.forEach((expert, index) => {
      if (!isRecord(expert)) {
        return;
      }
      const model = expert.model;
      if (typeof model !== 'string' || model.trim().length === 0) {
        return;
      }
      const owner = typeof expert.name === 'string' && expert.name.trim().length > 0
        ? expert.name.trim()
        : `expert#${index}`;
      refs.push({ owner, model: model.trim() });
    });
  }

  if (isRecord(config.chair)) {
    const chairModel = config.chair.model;
    if (typeof chairModel === 'string' && chairModel.trim().length > 0) {
      refs.push({ owner: 'chair', model: chairModel.trim() });
    }
  }

  return refs;
}

/** Возвращает префикс провайдера модели */
function getProvider(model: string): string {
  const slashIndex = model.indexOf('/');
  return slashIndex > 0 ? model.slice(0, slashIndex) : '';
}

/** Проверяет версию Node.js */
function checkNodeVersion(): DoctorCheck {
  const rawVersion = process.versions.node;
  const major = Number.parseInt(rawVersion.split('.')[0] ?? '0', 10);

  if (Number.isFinite(major) && major >= 18) {
    return {
      id: 'node-version',
      status: 'ok',
      message: `Node.js ${rawVersion}`
    };
  }

  return {
    id: 'node-version',
    status: 'fail',
    message: `Node.js ${rawVersion} не поддерживается (требуется >= 18)`,
    hint: 'Обновите Node.js до версии 18 или выше'
  };
}

/** Проверяет доступность OpenCode CLI */
function checkOpenCodeCli(version: string | null): DoctorCheck {
  if (version !== null && version.trim().length > 0) {
    const info = parseOpenCodeVersion(version);
    const channel =
      info.major === 2
        ? 'V2: V1-формат конфигурации поддерживается'
        : info.major === 1
          ? 'V1: нативный V2-формат не читается'
          : 'версия не распознана';
    return {
      id: 'opencode-cli',
      status: 'ok',
      message: `OpenCode CLI: ${version.trim()} (${channel})`
    };
  }

  return {
    id: 'opencode-cli',
    status: 'fail',
    message: 'OpenCode CLI не найден или не запускается',
    hint: 'npm install -g opencode-ai'
  };
}

/** Проверяет наличие файла конфигурации Consilium */
function checkConfigFile(configPath: string | null | undefined): DoctorCheck {
  if (typeof configPath === 'string' && configPath.length > 0) {
    return {
      id: 'config-file',
      status: 'ok',
      message: `Конфиг: ${configPath}`
    };
  }

  return {
    id: 'config-file',
    status: 'warn',
    message: 'Конфиг не найден, используются значения по умолчанию',
    hint: 'Выполните `consilium init`, чтобы создать конфиг'
  };
}

/** Проверяет список экспертов */
function checkExperts(config: ConsiliumConfig): DoctorCheck {
  const id = 'experts-config';
  const rawExperts: unknown = config.experts;

  if (!Array.isArray(rawExperts) || rawExperts.length === 0) {
    return {
      id,
      status: 'fail',
      message: 'Список экспертов пуст',
      hint: 'Добавьте экспертов в experts или выполните `consilium init`'
    };
  }

  const names: string[] = [];
  const invalidIndexes: number[] = [];
  let enabled = 0;

  for (let index = 0; index < rawExperts.length; index += 1) {
    const entry: unknown = rawExperts[index];

    if (!isRecord(entry)) {
      invalidIndexes.push(index);
      continue;
    }

    const name = entry.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      invalidIndexes.push(index);
    } else {
      names.push(name.trim());
    }

    if (entry.enabled !== false) {
      enabled += 1;
    }
  }

  if (invalidIndexes.length > 0) {
    return {
      id,
      status: 'fail',
      message: `Некорректные имена экспертов: ${invalidIndexes.map(index => `#${index}`).join(', ')}`,
      hint: 'У каждого эксперта должно быть непустое строковое поле name'
    };
  }

  if (enabled === 0) {
    return {
      id,
      status: 'fail',
      message: 'Нет включённых экспертов',
      hint: 'Установите enabled: true хотя бы одному эксперту'
    };
  }

  const duplicates = findDuplicates(names);
  if (duplicates.length > 0) {
    return {
      id,
      status: 'warn',
      message: `Дубликаты имён экспертов: ${duplicates.join(', ')}`,
      hint: 'Агенты с одинаковыми именами неразличимы для OpenCode'
    };
  }

  return {
    id,
    status: 'ok',
    message: `Экспертов: ${rawExperts.length}, включено: ${enabled}`
  };
}

/** Проверяет конфигурацию председателя */
function checkChair(config: ConsiliumConfig): DoctorCheck {
  const id = 'chair-config';
  const chair: unknown = config.chair;

  if (!isRecord(chair)) {
    return {
      id,
      status: 'fail',
      message: 'Конфигурация председателя отсутствует',
      hint: 'Добавьте объект chair с полем agent'
    };
  }

  const agent: unknown = chair.agent;
  if (typeof agent !== 'string' || agent.trim().length === 0) {
    return {
      id,
      status: 'fail',
      message: 'Не задан агент-председатель',
      hint: 'Укажите непустое значение chair.agent'
    };
  }

  const chairAgent = agent.trim();
  const expertNames = collectExpertNames(config);

  if (expertNames.includes(chairAgent)) {
    return {
      id,
      status: 'warn',
      message: `Председатель «${chairAgent}» совпадает с экспертом`,
      hint: 'Возможна путаница ролей: используйте отдельного агента для председателя'
    };
  }

  return {
    id,
    status: 'ok',
    message: `Председатель: ${chairAgent}`
  };
}

/** Проверяет таймауты */
function checkTimeouts(config: ConsiliumConfig): DoctorCheck {
  const id = 'timeouts';
  const timeouts: unknown = config.timeouts;

  if (!isRecord(timeouts)) {
    return {
      id,
      status: 'fail',
      message: 'Секция timeouts отсутствует',
      hint: 'Задайте timeouts.expert, timeouts.chair и timeouts.shutdown'
    };
  }

  const expert = timeouts.expert;
  const chair = timeouts.chair;
  const shutdown = timeouts.shutdown;

  const isPositiveNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

  if (!isPositiveNumber(expert) || !isPositiveNumber(chair) || !isPositiveNumber(shutdown)) {
    return {
      id,
      status: 'fail',
      message: 'Некорректные таймауты: ожидаются конечные положительные числа',
      hint: 'Проверьте timeouts.expert, timeouts.chair и timeouts.shutdown'
    };
  }

  if (expert < 10000 || chair < 30000) {
    return {
      id,
      status: 'warn',
      message: `Таймауты слишком малы: эксперт ${expert} мс, председатель ${chair} мс`,
      hint: 'Рекомендуется expert >= 10000 мс и chair >= 30000 мс'
    };
  }

  return {
    id,
    status: 'ok',
    message: `Таймауты: эксперт ${expert} мс, председатель ${chair} мс, shutdown ${shutdown} мс`
  };
}

/** Проверяет формат моделей и наличие ключей провайдеров */
function checkModelsFormat(config: ConsiliumConfig): DoctorCheck {
  const id = 'models-format';
  const refs = collectModelRefs(config);

  if (refs.length === 0) {
    return {
      id,
      status: 'ok',
      message: 'Модели не заданы — OpenCode выберет их автоматически'
    };
  }

  const invalid = refs.filter(ref => !MODEL_PATTERN.test(ref.model) || !ref.model.includes('/'));
  if (invalid.length > 0) {
    return {
      id,
      status: 'fail',
      message: `Некорректные модели: ${formatNames(invalid.map(ref => `${ref.owner}=${ref.model}`))}`,
      hint: 'Формат: provider/model; допустимы символы A-Z a-z 0-9 . _ : @ / # + -'
    };
  }

  const missingEnv = new Set<string>();
  for (const ref of refs) {
    const provider = getProvider(ref.model);
    if (provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
      missingEnv.add('OPENROUTER_API_KEY');
    } else if (provider === 'opencode' && !process.env.OPENCODE_API_KEY) {
      missingEnv.add('OPENCODE_API_KEY');
    }
  }

  if (missingEnv.size > 0) {
    return {
      id,
      status: 'warn',
      message: `Не заданы переменные окружения: ${[...missingEnv].join(', ')}`,
      hint: 'Задайте ключ в окружении; для opencode CLI-авторизация через `opencode auth login` может работать'
    };
  }

  return {
    id,
    status: 'ok',
    message: `Модели заданы для ${refs.length} агент(ов)`
  };
}

/** Прочитанная конфигурация OpenCode */
interface OpenCodeConfigRead {
  path: string | null;
  config: Record<string, unknown> | null;
  error?: string;
}

/** Проверяет включённые дополнительные функции */
function checkFeatures(config: ConsiliumConfig): DoctorCheck {
  const id = 'features';
  const parts: string[] = [];

  if (config.artifacts !== undefined && config.artifacts !== false) {
    try {
      const dir = resolveArtifactRoot({ artifacts: config.artifacts, cwd: config.cwd });
      parts.push(`artifacts → ${dir}`);
    } catch {
      parts.push('artifacts (некорректный путь)');
    }
  }
  if (config.consensus === true) parts.push('consensus');
  if (config.smartExperts === true) parts.push('smartExperts');
  if (config.maxCost !== undefined) parts.push(`maxCost=$${config.maxCost}`);
  if ((config.fallbackModels?.length ?? 0) > 0) {
    parts.push(`fallbackModels=${config.fallbackModels?.length}`);
  }
  if (config.session !== undefined && config.session.length > 0) {
    parts.push(`session=${config.session}`);
  }

  if (parts.length === 0) {
    return { id, status: 'ok', message: 'Дополнительные функции выключены' };
  }
  return { id, status: 'ok', message: `Включено: ${parts.join(', ')}` };
}

/** Читает opencode.json(c) с учётом `.opencode/` и родительских каталогов */
function readOpenCodeConfig(cwd: string, configuredPath?: string): OpenCodeConfigRead {
  const path = findOpenCodeConfigPath(configuredPath, cwd);
  if (path === null) {
    return { path: null, config: null };
  }

  try {
    const parsed = readJsonFile(path);
    if (!isRecord(parsed)) {
      return { path, config: null, error: 'ожидается JSON-объект' };
    }
    return { path, config: parsed };
  } catch (error) {
    return { path, config: null, error: errorMessage(error) };
  }
}

/** Проверяет opencode.json/opencode.jsonc и ссылки на агентов */
function checkOpenCodeConfig(config: ConsiliumConfig, cwd: string): DoctorCheck {
  const id = 'opencode-config';
  const read = readOpenCodeConfig(cwd, config.opencodeConfigPath);

  if (read.path === null) {
    return {
      id,
      status: 'warn',
      message: 'opencode.json не найден (проект, родители и глобальный конфиг)',
      hint: 'Создайте opencode.json или задайте model экспертам и председателю'
    };
  }

  if (read.config === null) {
    return {
      id,
      status: 'fail',
      message: `Не удалось разобрать ${read.path}: ${read.error ?? 'неизвестная ошибка'}`,
      hint: 'Проверьте синтаксис JSON/JSONC'
    };
  }

  const section = readAgentSection(read.config);
  const agents = section.entries;

  const expertNames = collectExpertNames(config);
  const referenced = new Set<string>(expertNames);

  const chairConfig: unknown = config.chair;
  if (isRecord(chairConfig)) {
    const chairAgent = chairConfig.agent;
    if (typeof chairAgent === 'string' && chairAgent.trim().length > 0) {
      referenced.add(chairAgent.trim());
    }
  }

  const missing: string[] = [];
  const subagents: string[] = [];

  for (const name of referenced) {
    const entry = agents[name];
    if (entry === undefined || section.invalid.includes(name)) {
      missing.push(name);
      continue;
    }
    const definition = readAgentDefinition(entry);
    if (expertNames.includes(name) && definition.mode === 'subagent') {
      subagents.push(name);
    }
  }

  if (missing.length > 0 || subagents.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`агенты не найдены: ${formatNames(missing)}`);
    }
    if (subagents.length > 0) {
      parts.push(`эксперты в режиме subagent: ${formatNames(subagents)}`);
    }

    const hints: string[] = [];
    if (missing.length > 0) {
      hints.push('будет использован default agent; задайте model, чтобы маршрутизировать модель');
    }
    if (subagents.length > 0) {
      hints.push('subagent нельзя вызвать напрямую через --agent');
    }

    return {
      id,
      status: 'warn',
      message: `${parts.join('; ')} (формат ${describeConfigFlavor(section.flavor)})`,
      hint: hints.join('; ')
    };
  }

  return {
    id,
    status: 'ok',
    message: `${read.path}: формат ${describeConfigFlavor(section.flavor)}, агентов ${Object.keys(agents).length}, все ссылки корректны`
  };
}

/**
 * Проверяет, не потеряется ли конфигурация при переходе между V1 и V2.
 * Учитывает установленную основную версию OpenCode.
 */
function checkOpenCodeV2Compat(
  cwd: string,
  major: 1 | 2 | null,
  configuredPath?: string
): DoctorCheck {
  const id = 'opencode-v2-compat';
  const read = readOpenCodeConfig(cwd, configuredPath);

  if (read.path === null) {
    return {
      id,
      status: 'ok',
      message: 'opencode.json не найден — проверка V1/V2 пропущена'
    };
  }

  if (read.config === null) {
    return {
      id,
      status: 'warn',
      message: `Не удалось прочитать ${read.path}: ${read.error ?? 'неизвестная ошибка'}`,
      hint: 'Проверка совместимости V1/V2 пропущена до исправления синтаксиса'
    };
  }

  const section = readAgentSection(read.config);
  const mcp = readMcpSection(read.config);
  const legacy = findLegacyV1Fields(read.config);
  const problems: string[] = [];
  const hints: string[] = [];

  if (major === 2) {
    if (Object.keys(mcp.flat).length > 0) {
      problems.push(`плоские MCP-серверы: ${formatNames(Object.keys(mcp.flat))}`);
      hints.push('OpenCode V2 читает только mcp.servers.<name>; выполните consilium mcp --install');
    }
    if (legacy.length > 0) {
      problems.push(`поля V1 без прямого эффекта в V2: ${formatNames(legacy)}`);
      hints.push('theme переносится в cli.json, autoupdate → update, small_model → agents.title.model, snapshot → snapshots, attachment → media');
    }
  }

  if (major === 1 && section.flavor === 'v2') {
    problems.push('конфигурация в нативном V2-формате');
    hints.push('OpenCode V1 не читает agents/mcp.servers; используйте V1-формат (agent/prompt)');
  }

  if (section.duplicated.length > 0) {
    problems.push(`агенты заданы дважды: ${formatNames(section.duplicated)}`);
    hints.push('V2 использует agents, V1 — agent; оставьте одно определение агента');
  }

  if (problems.length === 0) {
    return {
      id,
      status: 'ok',
      message: `формат ${describeConfigFlavor(section.flavor)} совместим с установленной версией OpenCode`
    };
  }

  return {
    id,
    status: 'warn',
    message: `${problems.join('; ')} (формат ${describeConfigFlavor(section.flavor)})`,
    hint: hints.join('; ')
  };
}

/** Находит ближайший существующий предок пути */
function findExistingAncestor(start: string): string | null {
  let current = start;
  for (;;) {
    if (existsSync(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Проверяет доступность пути для сохранения результата */
function checkOutputFile(config: ConsiliumConfig, cwd: string): DoctorCheck {
  const id = 'output-file';
  const output: unknown = config.output;

  if (!isRecord(output)) {
    return {
      id,
      status: 'fail',
      message: 'Секция output отсутствует',
      hint: 'Задайте output.file строкой или false'
    };
  }

  const file = output.file;

  if (file === false) {
    return {
      id,
      status: 'ok',
      message: 'Сохранение результата отключено (output.file = false)'
    };
  }

  if (typeof file !== 'string' || file.trim().length === 0) {
    return {
      id,
      status: 'fail',
      message: 'Некорректный output.file',
      hint: 'Укажите непустой путь строкой или false'
    };
  }

  const fullPath = resolve(cwd, file);
  const directory = dirname(fullPath);
  const ancestor = findExistingAncestor(directory);

  if (ancestor === null) {
    return {
      id,
      status: 'fail',
      message: `Не найдена существующая директория для ${fullPath}`,
      hint: 'Проверьте путь output.file'
    };
  }

  try {
    if (!statSync(ancestor).isDirectory()) {
      return {
        id,
        status: 'fail',
        message: `Путь ${ancestor} не является директорией`,
        hint: 'Проверьте путь output.file'
      };
    }
    accessSync(ancestor, constants.W_OK);
  } catch (error) {
    return {
      id,
      status: 'fail',
      message: `Нет доступа на запись в ${ancestor}`,
      hint: errorMessage(error)
    };
  }

  if (existsSync(fullPath)) {
    try {
      if (statSync(fullPath).isDirectory()) {
        return {
          id,
          status: 'fail',
          message: `output.file указывает на директорию: ${fullPath}`,
          hint: 'Укажите путь к файлу'
        };
      }
      accessSync(fullPath, constants.W_OK);
    } catch (error) {
      return {
        id,
        status: 'fail',
        message: `Файл ${fullPath} недоступен для записи`,
        hint: errorMessage(error)
      };
    }

    return {
      id,
      status: 'ok',
      message: `Файл результата: ${fullPath}`
    };
  }

  const note = directory === ancestor
    ? ''
    : ` (каталог ${directory} будет создан)`;

  return {
    id,
    status: 'ok',
    message: `Файл результата: ${fullPath}${note}`
  };
}

/** Проверяет кэш свободных моделей (сеть не блокирует диагностику) */
async function checkModelsCache(): Promise<DoctorCheck> {
  const id = 'models-cache';

  try {
    const result = await fetchFreeModels({ timeoutMs: 4000 });
    const count = result.models.length;
    const failedSources = result.sources.filter(source => !source.ok);

    if (count === 0) {
      return {
        id,
        status: 'warn',
        message: 'Свободные модели не найдены',
        hint: failedSources.length > 0
          ? `Недоступные источники: ${failedSources.map(source => source.source).join(', ')}`
          : 'Обновите кэш командой `consilium models --refresh`'
      };
    }

    if (failedSources.length > 0) {
      return {
        id,
        status: 'warn',
        message: `Свободных моделей: ${count}, но часть источников недоступна`,
        hint: failedSources
          .map(source => `${source.source}: ${source.error ?? 'ошибка'}`)
          .join('; ')
      };
    }

    if (result.fromCache) {
      return {
        id,
        status: 'ok',
        message: `Кэш свободных моделей: ${count}`
      };
    }

    return {
      id,
      status: 'ok',
      message: `Свободных моделей: ${count}`
    };
  } catch (error) {
    return {
      id,
      status: 'warn',
      message: `Не удалось проверить каталог моделей: ${errorMessage(error)}`,
      hint: 'Проверьте сеть; на работу консилиума это не влияет'
    };
  }
}

/** Проверяет параллелизм */
function checkConcurrency(config: ConsiliumConfig): DoctorCheck {
  const id = 'concurrency';
  const retry: unknown = config.retry;
  const value = isRecord(retry) ? retry.maxConcurrency : undefined;

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return {
      id,
      status: 'warn',
      message: `Некорректный retry.maxConcurrency: ${String(value)}`,
      hint: 'Рекомендуется целое число от 1 до 8'
    };
  }

  if (value < 1 || value > 8) {
    return {
      id,
      status: 'warn',
      message: `retry.maxConcurrency = ${value} вне рекомендуемого диапазона 1–8`,
      hint: 'Слишком большое значение нагружает систему и API'
    };
  }

  return {
    id,
    status: 'ok',
    message: `Параллельных агентов: ${value}`
  };
}

/** Проверяет режим standalone */
function checkStandalone(config: ConsiliumConfig): DoctorCheck {
  if (config.standalone !== false) {
    return {
      id: 'standalone',
      status: 'ok',
      message: 'Изолированный сервер (--standalone) включён'
    };
  }

  return {
    id: 'standalone',
    status: 'warn',
    message: 'Standalone отключён: может конфликтовать с запущенным OpenCode (порт managed service)',
    hint: 'Включите standalone: true (--standalone) для изоляции'
  };
}

/** Проверяет авто-подтверждение разрешений */
function checkAutoApprove(config: ConsiliumConfig): DoctorCheck {
  if (config.autoApprove === true) {
    return {
      id: 'auto-approve',
      status: 'warn',
      message: 'autoApprove включён: агенты могут выполнять инструменты без подтверждения',
      hint: 'Оставьте autoApprove: false, если не доверяете промптам и инструментам'
    };
  }

  return {
    id: 'auto-approve',
    status: 'ok',
    message: 'Авто-подтверждение разрешений выключено'
  };
}

/** Тип функции проверки */
type CheckFn = () => DoctorCheck | Promise<DoctorCheck>;

/** Выполняет проверку, превращая исключения в fail */
async function safeCheck(id: string, fn: CheckFn): Promise<DoctorCheck> {
  try {
    return await fn();
  } catch (error) {
    return {
      id,
      status: 'fail',
      message: `Проверка не выполнена: ${errorMessage(error)}`
    };
  }
}

/**
 * Запускает все проверки диагностики
 */
export async function runDoctor(
  config: ConsiliumConfig,
  options: DoctorOptions = {}
): Promise<DoctorCheck[]> {
  const cwd = options.cwd ?? config.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  let versionText: string | null = null;
  try {
    versionText = await getOpenCodeVersion(config);
  } catch {
    versionText = null;
  }
  const cliMajor = parseOpenCodeVersion(versionText).major;

  checks.push(await safeCheck('node-version', () => checkNodeVersion()));
  checks.push(await safeCheck('opencode-cli', () => checkOpenCodeCli(versionText)));
  checks.push(await safeCheck('config-file', () => checkConfigFile(options.configPath)));
  checks.push(await safeCheck('experts-config', () => checkExperts(config)));
  checks.push(await safeCheck('chair-config', () => checkChair(config)));
  checks.push(await safeCheck('timeouts', () => checkTimeouts(config)));
  checks.push(await safeCheck('models-format', () => checkModelsFormat(config)));
  checks.push(await safeCheck('opencode-config', () => checkOpenCodeConfig(config, cwd)));
  checks.push(
    await safeCheck('opencode-v2-compat', () =>
      checkOpenCodeV2Compat(cwd, cliMajor, config.opencodeConfigPath)
    )
  );
  checks.push(await safeCheck('output-file', () => checkOutputFile(config, cwd)));

  if (options.checkModels !== false) {
    checks.push(await safeCheck('models-cache', () => checkModelsCache()));
  }

  checks.push(await safeCheck('concurrency', () => checkConcurrency(config)));
  checks.push(await safeCheck('features', () => checkFeatures(config)));
  checks.push(await safeCheck('standalone', () => checkStandalone(config)));
  checks.push(await safeCheck('auto-approve', () => checkAutoApprove(config)));

  return checks;
}

/**
 * Форматирует отчёт диагностики для консоли
 */
export function formatDoctorReport(checks: DoctorCheck[]): string {
  const icons: Record<DoctorCheck['status'], string> = {
    ok: '✅',
    warn: '⚠️',
    fail: '❌'
  };

  const lines: string[] = [];
  let okCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const check of checks) {
    lines.push(`${icons[check.status]} [${check.id}] ${check.message}`);
    if (check.hint) {
      lines.push(`   ↳ ${check.hint}`);
    }

    if (check.status === 'ok') {
      okCount += 1;
    } else if (check.status === 'warn') {
      warnCount += 1;
    } else {
      failCount += 1;
    }
  }

  lines.push('');
  lines.push(`Итого: ${okCount} ok, ${warnCount} warnings, ${failCount} errors`);

  const verdict = failCount > 0 ? 'FAIL' : warnCount > 0 ? 'WARN' : 'PASS';
  lines.push(`Вердикт: ${verdict}`);

  return lines.join('\n');
}