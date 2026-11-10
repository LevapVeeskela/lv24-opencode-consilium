/**
 * @fileoverview Применение плана повтора запуска к конфигурации консилиума
 * @module lv24-opencode-consilium
 */

import type { ConsiliumConfig } from '../domain/types.js';
import type { ArtifactRun } from '../domain/artifacts/artifacts.js';
import { planReplay } from '../domain/artifacts/replay.js';
import type { ReplayPlan } from '../domain/artifacts/replay.js';

/** Опции применения плана повтора */
export interface ReplayConfigOptions {
  /** Запасной агент-председатель из текущей конфигурации */
  chairAgent?: string;
  /** Сохранять ли повторный запуск (true — в .consilium/runs, строка — каталог) */
  artifacts?: boolean | string;
  /** Необязательный фильтр экспертов (CLI `--experts`) */
  experts?: string[];
}

/** Результат применения плана повтора */
export interface ReplayConfigResult {
  /** Восстановленный план повтора */
  plan: ReplayPlan;
  /** Запрошенные эксперты, которых нет в артефакте */
  missing: string[];
  /** Фильтр экспертов не совпал ни с одним экспертом артефакта */
  emptySelection: boolean;
}

/**
 * Восстанавливает задачу, экспертов, председателя и replayable-опции
 * из артефакта в переданную конфигурацию (мутирует её, как и CLI).
 * Семантика плана остаётся в `planReplay`; функция только переносит план
 * в конфигурацию, чтобы CLI и MCP не расходились.
 */
export function applyReplayPlan(
  config: ConsiliumConfig,
  artifact: ArtifactRun,
  options: ReplayConfigOptions = {}
): ReplayConfigResult {
  const plan = planReplay(artifact, {
    chairAgent: options.chairAgent,
    artifacts: options.artifacts
  });

  const byName = new Map(config.experts.map(expert => [expert.name, expert]));
  config.experts = plan.experts.map((expert, index) => {
    const base = byName.get(expert.name) ?? {
      name: expert.name,
      enabled: true,
      priority: index + 1
    };
    return expert.model !== undefined ? { ...base, model: expert.model } : base;
  });

  let missing: string[] = [];
  let emptySelection = false;
  if (options.experts !== undefined) {
    const wanted = new Set(options.experts);
    const filtered = config.experts.filter(expert => wanted.has(expert.name));

    missing = options.experts.filter(
      name => !plan.experts.some(expert => expert.name === name)
    );
    emptySelection = filtered.length === 0;
    if (!emptySelection) {
      config.experts = filtered;
    }
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

  return { plan, missing, emptySelection };
}

/** Разбирает строку CLI `--experts` в список имён */
export function parseReplayExperts(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0);
}
