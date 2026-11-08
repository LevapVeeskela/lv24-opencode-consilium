/**
 * @fileoverview Промпты совета: эксперты и председатель
 * @module lv24-opencode-consilium
 */

import type { AgentResult, ExpertConfig } from '../types.js';
import { DEFAULT_EXPERT_PROMPTS } from '../defaults.js';
import { analyzeConsensus, buildConsensusPromptSection } from './consensus.js';

/** Вступление промпта председателя */
export const CHAIR_PROMPT_INTRO =
  'Синтезируй мнения экспертов и составь итоговый план. Не вызывай инструменты — ответь только текстом.\n\n';

/** Заголовок раздела с задачей */
export const CHAIR_PROMPT_TASK_HEADING = '## Задача\n';

/** Заголовок раздела с мнениями экспертов */
export const CHAIR_PROMPT_EXPERTS_HEADING = '## Мнения экспертов\n';

/** Требования к ответу председателя */
export const CHAIR_PROMPT_REQUIREMENTS =
  '## Требования к ответу\n1. **Резюме** (1-2 предложения)\n2. **Топ-3 приоритетных действия** с обоснованием\n3. **Главный риск** и митигация\n4. **Оценка трудозатрат** (если применимо)';

/** Собирает промпт эксперта: функция, шаблон с `${task}` или значение по умолчанию */
export function buildExpertPrompt(expert: ExpertConfig, task: string): string {
  if (typeof expert.prompt === 'function') {
    return expert.prompt(task);
  }
  if (typeof expert.prompt === 'string' && expert.prompt.trim().length > 0) {
    return expert.prompt.replace(/\$\{task\}/g, task);
  }

  const fallback = Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, expert.name)
    ? DEFAULT_EXPERT_PROMPTS[expert.name]
    : DEFAULT_EXPERT_PROMPTS.default;
  if (typeof fallback === 'function') {
    return fallback(task);
  }
  if (typeof fallback === 'string') {
    return fallback.replace(/\$\{task\}/g, task);
  }
  return task;
}

/** Собирает промпт председателя по результатам экспертов */
export function buildChairPrompt(
  task: string,
  expertResults: AgentResult[],
  maxExpertTextLength: number,
  consensus = false
): string {
  const successful = expertResults.filter(result => result.success);

  let prompt = CHAIR_PROMPT_INTRO;
  prompt += `${CHAIR_PROMPT_TASK_HEADING}${task}\n\n`;
  prompt += CHAIR_PROMPT_EXPERTS_HEADING;

  for (const result of successful) {
    const cleanText = result.text.substring(0, maxExpertTextLength);
    prompt += `### ${result.agent.toUpperCase()}\n${cleanText}\n\n`;
  }

  const failedCount = expertResults.length - successful.length;
  if (failedCount > 0) {
    prompt += `<!-- Не ответили экспертов: ${failedCount} -->\n\n`;
  }

  prompt += CHAIR_PROMPT_REQUIREMENTS;

  if (consensus === true) {
    const report = analyzeConsensus(
      expertResults.map(result => ({
        agent: result.agent,
        text: result.text,
        model: result.model,
        success: result.success
      }))
    );
    prompt += `\n\n${buildConsensusPromptSection(report)}`;
  }

  return prompt;
}
