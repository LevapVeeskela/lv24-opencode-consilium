/**
 * @fileoverview Проверки конфигурации OpenCode и совместимости V1/V2
 * @module lv24-opencode-consilium
 */

import type { ConsiliumConfig } from '../../types.js';
import {
  describeConfigFlavor,
  findLegacyV1Fields,
  readAgentDefinition,
  readAgentSection,
  readMcpSection
} from '../../../infrastructure/config/compat.js';
import type { DoctorCheck, ModelRef } from '../types.js';
import { formatNames, isRecord } from '../types.js';
import { readOpenCodeConfig } from './config.js';

/** Паттерн допустимой модели provider/model */
export const MODEL_PATTERN = /^[A-Za-z0-9._:@\/#+-]+$/;

/** Собирает валидные имена экспертов */
export function collectExpertNames(config: ConsiliumConfig): string[] {
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

/** Собирает модели экспертов и председателя */
export function collectModelRefs(config: ConsiliumConfig): ModelRef[] {
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

/** Проверяет opencode.json/opencode.jsonc и ссылки на агентов */
export function checkOpenCodeConfig(config: ConsiliumConfig, cwd: string): DoctorCheck {
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
export function checkOpenCodeV2Compat(
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
