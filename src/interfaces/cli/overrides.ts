/**
 * @fileoverview Применение CLI-флагов поверх загруженной конфигурации
 * @module lv24-opencode-consilium/cli/overrides
 */

import type { CLIOptions, ConsiliumConfig } from '../../domain/types.js';
import { applyPreset, listPresets } from '../../domain/council/presets.js';
import { isValidVariant, variantOf, withVariant } from '../../domain/council/variants.js';
import { UsageError } from './args.js';

export function applyCliOverrides(config: ConsiliumConfig, options: CLIOptions): ConsiliumConfig {
  let result = config;

  if (options.preset) {
    const known = listPresets().map(preset => preset.name);
    if (!known.includes(options.preset)) {
      throw new UsageError(`Неизвестный пресет: ${options.preset}. Доступны: ${known.join(', ')}`);
    }
    result = applyPreset(result, options.preset);
  }

  if (options.experts) {
    const names = options.experts.split(',').map(name => name.trim()).filter(Boolean);
    const available = new Set(result.experts.map(expert => expert.name));
    const unknown = names.filter(name => !available.has(name));
    if (unknown.length > 0) {
      throw new UsageError(`Неизвестные эксперты: ${unknown.join(', ')}. Доступны: ${[...available].join(', ')}`);
    }
    result.experts = result.experts.filter(expert => names.includes(expert.name));
  }

  if (options.expertTimeout) {
    result.timeouts.expert = options.expertTimeout;
    result.experts = result.experts.map(expert => ({ ...expert, timeout: options.expertTimeout }));
  }
  if (options.chairTimeout) {
    result.timeouts.chair = options.chairTimeout;
    result.chair.timeout = options.chairTimeout;
  }
  if (options.retries !== undefined) {
    result.retry.expertRetries = options.retries;
    result.retry.chairRetries = options.retries;
  }
  if (options.format) result.output.format = options.format;
  if (options.logLevel) result.output.logLevel = options.logLevel;
  if (options.noSave) {
    result.output.file = false;
  } else if (options.output !== undefined) {
    result.output.file = options.output;
  }

  if (options.artifacts !== undefined) result.artifacts = options.artifacts;
  if (options.noArtifacts) result.artifacts = false;
  if (options.consensus === true) result.consensus = true;
  if (options.noConsensus) result.consensus = false;
  if (options.findings === true) result.findings = true;
  if (options.noFindings) result.findings = false;
  if (options.smartExperts) result.smartExperts = true;
  if (options.maxCost !== undefined) result.maxCost = options.maxCost;
  if (options.fallbackModels !== undefined) result.fallbackModels = options.fallbackModels;
  if (options.session !== undefined) result.session = options.session;

  if (options.variant !== undefined) {
    if (!isValidVariant(options.variant)) {
      throw new UsageError(
        `Некорректный вариант модели: ${options.variant} (допустимы буквы, цифры, . _ -)`
      );
    }
    const configVariant = result.variant;
    result.experts = result.experts.map(expert => {
      if (expert.model === undefined || !expert.model.includes('/')) return expert;
      const existing = variantOf(expert.model);
      if (existing === undefined || existing === configVariant) {
        return { ...expert, model: withVariant(expert.model, options.variant) };
      }
      return expert;
    });
    if (result.chair.model !== undefined && result.chair.model.includes('/')) {
      const existing = variantOf(result.chair.model);
      if (existing === undefined || existing === configVariant) {
        result.chair = {
          ...result.chair,
          model: withVariant(result.chair.model, options.variant)
        };
      }
    }
    result.variant = options.variant;
  }

  if (options.report !== undefined) result.report = options.report;
  if (options.reportFile !== undefined) result.reportFile = options.reportFile;
  if (options.debounceMs !== undefined) result.debounceMs = options.debounceMs;

  return result;
}
