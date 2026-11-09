/**
 * @fileoverview Генерация конфигурации и служебные пути
 * @module lv24-opencode-consilium
 */

import { dirname } from 'path';
import type { ConsiliumConfig, ExpertConfig } from '../../domain/types.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_EXPERT_PROMPTS,
  EXCLUDED_AGENTS
} from '../../domain/defaults.js';
import { mergeWithDefaults } from './load.js';

/**
 * Создаёт минимальный конфиг
 */
export function createMinimalConfig(experts: string[] = []): ConsiliumConfig {
  const expertConfigs: ExpertConfig[] = experts.length > 0
    ? experts.map((name, index) => ({
        name,
        enabled: true,
        priority: index + 1,
        prompt: Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, name)
          ? DEFAULT_EXPERT_PROMPTS[name] ?? ((task: string) => task)
          : DEFAULT_EXPERT_PROMPTS.default ?? ((task: string) => task)
      }))
    : DEFAULT_CONFIG.experts.map(expert => ({ ...expert }));

  return mergeWithDefaults({ experts: expertConfigs });
}

/**
 * Генерирует пример конфигурационного файла
 */
export function generateExampleConfig(): string {
  return JSON.stringify(
    {
      version: '1.7.0',
      experts: [
        {
          name: 'arch',
          enabled: true,
          priority: 1,
          timeout: 300000,
          retries: 1,
          prompt: 'Как архитектор, проанализируй задачу кратко (3-5 предложений): ${task}'
        },
        {
          name: 'ux',
          enabled: true,
          priority: 2
        },
        {
          name: 'ba',
          enabled: true,
          priority: 3
        },
        {
          name: 'sec',
          enabled: true,
          priority: 4
        }
      ],
      chair: {
        agent: 'consilium',
        timeout: 600000,
        maxExpertTextLength: 3000
      },
      excludedAgents: [...EXCLUDED_AGENTS],
      timeouts: {
        expert: 300000,
        chair: 600000,
        shutdown: 5000
      },
      retry: {
        expertRetries: 1,
        chairRetries: 1,
        delay: 1000,
        exponentialBackoff: true,
        maxConcurrency: 3
      },
      output: {
        file: false,
        format: 'markdown',
        progress: true,
        logLevel: 'info'
      },
      standalone: true,
      autoApprove: false,
      autoDiscoverAgents: true,
      findings: false,
      localOnly: false,
      deadlineMs: 900000,
      presets: {
        docs: {
          description: 'Документация: архитектор и бизнес-аналитик',
          experts: ['arch', 'ba']
        }
      }
    },
    null,
    2
  );
}

/**
 * Возвращает директорию конфигурационного файла (для относительных путей)
 */
export function configDirectory(configPath: string | null): string {
  return configPath ? dirname(configPath) : process.cwd();
}
