/**
 * @fileoverview Команда init: создание конфигурации и подбор бесплатных моделей
 * @module lv24-opencode-consilium/cli/commands/init
 */

import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { CLIOptions } from '../../../domain/types.js';
import { loadConfig, generateExampleConfig, mergeWithDefaults } from '../../../application/consilium.js';
import { buildCouncilAgents, buildConsiliumConfigFromModels, fetchFreeModels, selectCouncilModels } from '../../../domain/models/models.js';
import { verifyModels } from '../../../application/models/verify.js';
import { findOpenCodeConfigPath, readJsonFile } from '../../../infrastructure/config/config.js';
import {
  readAgentDefinition,
  readAgentSection,
  upsertAgents
} from '../../../infrastructure/config/compat.js';
import { log, writeJsonAtomic } from '../output.js';

export async function commandInit(options: CLIOptions): Promise<number> {
  const configPath = resolve(process.cwd(), 'consilium.config.json');

  if (!options.free) {
    if (options.nativeV2 === true) {
      log(options, 'ℹ️ --native-v2 применяется только с --free: он влияет на запись агентов в opencode.json.');
    }
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
  const loadedForPath = loadConfig(options.config);
  const targetCwd = loadedForPath.config.cwd ?? process.cwd();
  const opencodePath =
    findOpenCodeConfigPath(loadedForPath.config.opencodeConfigPath, targetCwd) ??
    resolve(targetCwd, 'opencode.json');

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

  const section = readAgentSection(existing);
  const assignments: Array<{ agent: string; model: string; kept: boolean }> = [];
  const definitions: Record<string, { model?: string; prompt?: string; mode?: string }> = {};

  for (const [name, agent] of Object.entries(agents)) {
    const current = section.entries[name];
    const currentView = current === undefined ? undefined : readAgentDefinition(current);
    const currentModel = currentView?.model;
    const kept = currentModel !== undefined && !options.force;
    const model = kept && currentModel !== undefined ? currentModel : agent.model;

    definitions[name] = {
      model,
      prompt: currentView?.prompt ?? agent.prompt,
      mode: 'primary'
    };
    assignments.push({ agent: name, model, kept });
  }

  const upserted = upsertAgents(existing, definitions, {
    flavor: options.nativeV2 === true ? 'v2' : undefined,
    migrate: options.nativeV2 === true
  });

  for (const warning of upserted.warnings) {
    log(options, `⚠️ ${warning}`);
  }

  const proposedOpenCode = {
    $schema:
      typeof existing.$schema === 'string'
        ? existing.$schema
        : 'https://opencode.ai/config.json',
    ...upserted.config
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

  if (opencodePath.endsWith('.jsonc')) {
    log(options, '⚠️ Файл .jsonc будет перезаписан без комментариев (они не сохраняются).');
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
