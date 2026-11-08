/**
 * @fileoverview Проверки окружения Consilium
 * @module lv24-opencode-consilium
 */

import type { ConsiliumConfig } from '../../../domain/types.js';
import { parseOpenCodeVersion } from '../../../infrastructure/config/compat.js';
import { fetchFreeModels } from '../../../infrastructure/models/sources.js';
import type { DoctorCheck } from '../types.js';
import { errorMessage, isRecord } from '../types.js';

/** Проверяет версию Node.js */
export function checkNodeVersion(): DoctorCheck {
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
export function checkOpenCodeCli(version: string | null): DoctorCheck {
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

/** Проверяет параллелизм */
export function checkConcurrency(config: ConsiliumConfig): DoctorCheck {
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
export function checkStandalone(config: ConsiliumConfig): DoctorCheck {
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
export function checkAutoApprove(config: ConsiliumConfig): DoctorCheck {
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

/** Проверяет кэш свободных моделей (сеть не блокирует диагностику) */
export async function checkModelsCache(): Promise<DoctorCheck> {
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
