/**
 * @fileoverview Проверки конфигурации Consilium
 * @module lv24-opencode-consilium
 */

import { accessSync, constants, existsSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import type { ConsiliumConfig } from '../../../domain/types.js';
import { resolveArtifactRoot } from '../../../domain/artifacts/artifacts.js';
import type { DoctorCheck } from '../types.js';
import {
  MODEL_PATTERN,
  errorMessage,
  findDuplicates,
  formatNames,
  getProvider,
  isRecord
} from '../types.js';
import { collectExpertNames, collectModelRefs } from './opencode.js';

export { readOpenCodeConfig } from './opencode.js';

/** Находит ближайший существующий предок пути */
export function findExistingAncestor(start: string): string | null {
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

/** Проверяет наличие файла конфигурации Consilium */
export function checkConfigFile(configPath: string | null | undefined): DoctorCheck {
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
export function checkExperts(config: ConsiliumConfig): DoctorCheck {
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
export function checkChair(config: ConsiliumConfig): DoctorCheck {
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
export function checkTimeouts(config: ConsiliumConfig): DoctorCheck {
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
export function checkModelsFormat(config: ConsiliumConfig): DoctorCheck {
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

/** Проверяет включённые дополнительные функции */
export function checkFeatures(config: ConsiliumConfig): DoctorCheck {
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

/** Проверяет доступность пути для сохранения результата */
export function checkOutputFile(config: ConsiliumConfig, cwd: string): DoctorCheck {
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
