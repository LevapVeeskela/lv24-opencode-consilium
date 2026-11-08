/**
 * @fileoverview Форматирование артефактов запусков консилиума
 * @module lv24-opencode-consilium
 */

import type { AgentUsage } from '../../types.js';
import { MAX_EXPERT_TEXT_CHARS, type ArtifactRun } from './types.js';

/** Форматирует расход токенов одной строкой */
function formatUsageLine(usage: AgentUsage | undefined): string {
  if (usage === undefined) {
    return '—';
  }
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    parts.push(`вход: ${usage.inputTokens}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`выход: ${usage.outputTokens}`);
  }
  if (usage.reasoningTokens !== undefined) {
    parts.push(`рассуждения: ${usage.reasoningTokens}`);
  }
  if (usage.cacheReadTokens !== undefined) {
    parts.push(`кэш-чтение: ${usage.cacheReadTokens}`);
  }
  if (usage.cacheWriteTokens !== undefined) {
    parts.push(`кэш-запись: ${usage.cacheWriteTokens}`);
  }
  if (usage.cost !== undefined) {
    parts.push(`стоимость: $${usage.cost}`);
  }
  return parts.length > 0 ? parts.join(', ') : '—';
}

/** Обрезает текст до лимита с пометкой */
function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n[… обрезано: ${text.length - limit} символов из ${text.length} …]`;
}

/**
 * Форматирует артефакт в читаемый русскоязычный markdown-отчёт
 */
export function formatArtifact(run: ArtifactRun): string {
  const lines: string[] = [];
  lines.push(`# Отчёт консилиума: ${run.id}`);
  lines.push('');
  lines.push(`- Дата: ${run.createdAt}`);
  lines.push(`- Статус: ${run.success ? '✅ успех' : '❌ ошибка'}`);
  lines.push('');
  lines.push('## Задача');
  lines.push('');
  lines.push(run.task);
  lines.push('');
  lines.push('## Модели');
  lines.push('');
  const modelKeys = Object.keys(run.models);
  if (modelKeys.length === 0) {
    lines.push('Модели не указаны.');
  } else {
    for (const name of modelKeys) {
      lines.push(`- ${name}: ${run.models[name] ?? '—'}`);
    }
  }
  lines.push('');
  lines.push(`## Эксперты (${run.experts.length})`);
  lines.push('');
  if (run.experts.length === 0) {
    lines.push('Нет ответов экспертов.');
  } else {
    for (const expert of run.experts) {
      lines.push(`### ${expert.agent}`);
      lines.push('');
      lines.push(`- Модель: ${expert.model ?? '—'}`);
      lines.push(`- Статус: ${expert.success ? '✅ успех' : '❌ ошибка'}`);
      if (expert.errorCode !== undefined) {
        lines.push(`- Код ошибки: ${expert.errorCode}`);
      }
      if (expert.errorMessage !== undefined) {
        lines.push(`- Ошибка: ${expert.errorMessage}`);
      }
      if (expert.duration !== undefined) {
        lines.push(`- Длительность: ${expert.duration} мс`);
      }
      lines.push(`- Расход: ${formatUsageLine(expert.usage)}`);
      lines.push('');
      lines.push(truncateText(expert.text, MAX_EXPERT_TEXT_CHARS));
      lines.push('');
    }
  }
  lines.push('## Итог');
  lines.push('');
  lines.push(run.text);
  lines.push('');
  lines.push('## Расход');
  lines.push('');
  lines.push(`- Суммарно: ${formatUsageLine(run.usage)}`);
  lines.push('');
  return lines.join('\n');
}
