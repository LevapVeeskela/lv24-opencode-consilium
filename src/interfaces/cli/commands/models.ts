/**
 * @fileoverview Команда models: рейтинг бесплатных моделей
 * @module lv24-opencode-consilium/cli/commands/models
 */

import type { CLIOptions } from '../../../domain/types.js';
import { fetchFreeModels } from '../../../domain/models/models.js';
import { verifyModels } from '../../../application/models/verify.js';
import { log } from '../output.js';

export async function commandModels(options: CLIOptions): Promise<number> {
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
