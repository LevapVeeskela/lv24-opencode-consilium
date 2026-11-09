/**
 * @fileoverview Команда models: рейтинг бесплатных моделей и статистика надёжности
 * @module lv24-opencode-consilium/cli/commands/models
 */

import type { CLIOptions } from '../../../domain/types.js';
import { fetchFreeModels } from '../../../infrastructure/models/sources.js';
import {
  filterLocalModels,
  formatLocalProviders,
  probeLocalProviders
} from '../../../infrastructure/local-models.js';
import {
  formatReliabilityTable,
  loadReliability,
  type ModelReliability,
  type ReliabilityStore
} from '../../../infrastructure/models/reliability.js';
import { verifyModels } from '../../../application/models/verify.js';
import { log } from '../output.js';

/** Зависимости команды models, подменяемые в тестах */
export interface ModelsCommandDependencies {
  /** Рабочая директория для .consilium/reliability.json */
  cwd?: string;
  /** Загрузчик каталога моделей */
  fetchModels?: typeof fetchFreeModels;
  /** Загрузчик статистики надёжности */
  loadReliabilityStore?: (dir?: string) => ReliabilityStore;
}

/** Строка JSON-вывода статистики надёжности */
type ReliabilityRow = { model: string } & ModelReliability;

function reliabilityRows(store: ReliabilityStore): ReliabilityRow[] {
  return Object.entries(store.models)
    .sort((a, b) => {
      if (b[1].attempts !== a[1].attempts) return b[1].attempts - a[1].attempts;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([model, entry]) => ({ model, ...entry }));
}

export async function commandModels(
  options: CLIOptions,
  deps: ModelsCommandDependencies = {}
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const fetchModels = deps.fetchModels ?? fetchFreeModels;
  const result = await fetchModels({
    forceRefresh: options.refresh,
    includeUnavailable: !options.available
  });

  const limit = options.limit ?? 20;
  // Каталог уже отсортирован по рейтингу; фильтр сохраняет порядок.
  const catalog = options.local ? filterLocalModels(result.models) : result.models;
  const models = catalog.slice(0, limit);

  let checks = new Map<string, { ok: boolean; error?: string }>();
  if (options.verify) {
    log(options, `🔬 Проверяю ${models.length} моделей реальным запросом...`);
    const verified = await verifyModels(models, { timeoutMs: 60000, concurrency: 4 });
    checks = new Map(verified.map(item => [item.model.id, { ok: item.ok, error: item.error }]));
    const working = verified.filter(item => item.ok).length;
    log(options, `🔬 Рабочих моделей: ${working}/${verified.length}`);
  }

  const reliabilityStore = options.reliability
    ? (deps.loadReliabilityStore ?? loadReliability)(cwd)
    : undefined;

  const localProviders = options.probeLocal ? await probeLocalProviders() : undefined;

  if (options.json) {
    const enriched = models.map(model => ({ ...model, verified: checks.get(model.id)?.ok }));
    const payload: Record<string, unknown> = { ...result, models: enriched };
    if (reliabilityStore !== undefined) {
      payload.reliability = reliabilityRows(reliabilityStore);
    }
    if (localProviders !== undefined) {
      payload.localProviders = localProviders;
    }
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  if (!options.silent) {
    for (const source of result.sources) {
      if (!source.ok) console.error(`⚠️ ${source.source}: ${source.error ?? 'ошибка'}`);
    }
  }

  if (localProviders !== undefined) {
    console.log(formatLocalProviders(localProviders));
    console.log('');
  }

  console.log(`Бесплатные модели (${result.fromCache ? 'кэш' : 'свежие данные'}, всего кандидатов: ${catalog.length}):\n`);
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

  if (reliabilityStore !== undefined) {
    console.log('');
    console.log(formatReliabilityTable(reliabilityStore));
  }
  return 0;
}
