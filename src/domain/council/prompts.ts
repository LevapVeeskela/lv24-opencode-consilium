/**
 * @fileoverview Промпты совета: эксперты и председатель
 * @module lv24-opencode-consilium
 */

import type { AgentResult, ExpertConfig } from '../types.js';
import { DEFAULT_EXPERT_PROMPTS } from '../defaults.js';
import { analyzeConsensus, buildConsensusPromptSection } from './consensus.js';

/** Роль агента для инструкции структурированных находок */
export type FindingsPromptRole = 'expert' | 'chair';

/** Заголовок раздела структурированных находок */
export const FINDINGS_PROMPT_HEADING = '## Структурированные находки';

/** Требуемые поля находки, перечисленные в инструкции */
export const FINDINGS_PROMPT_FIELDS =
  'severity (critical | high | medium | low | info), category, file, line, claim, evidence, confidence (0..1)';

/** Инструкция эксперту: завершить ответ одним fenced JSON-блоком находок */
export const EXPERT_FINDINGS_INSTRUCTION =
  `${FINDINGS_PROMPT_HEADING}\n` +
  'В самом конце ответа добавь ровно один fenced-блок ```json и ничего после него.\n' +
  'Блок должен содержать объект с массивом findings. Поля каждой находки:\n' +
  `- ${FINDINGS_PROMPT_FIELDS};\n` +
  '- severity — уровень серьёзности, category — краткая категория проблемы;\n' +
  '- file и line — место в коде, если оно известно;\n' +
  '- claim — суть находки одной фразой, evidence — подтверждение из кода или задачи;\n' +
  '- confidence — уверенность от 0 до 1.\n' +
  'Если находок нет, верни {"findings": []}.\n' +
  'Не добавляй после блока текст и не дублируй блок.';

/** Инструкция председателю: находки и отклонённые позиции с причинами */
export const CHAIR_FINDINGS_INSTRUCTION =
  `${FINDINGS_PROMPT_HEADING}\n` +
  'В самом конце ответа добавь ровно один fenced-блок ```json и ничего после него.\n' +
  'Блок должен содержать объект с массивами findings и rejected.\n' +
  `findings — подтверждённые находки; поля: ${FINDINGS_PROMPT_FIELDS}.\n` +
  'rejected — позиции экспертов, которые ты отклонил; для каждой укажи claim (позиция) ' +
  'и reason (почему отклонена).\n' +
  'Если находок нет, верни "findings": []; если отклонённых позиций нет — "rejected": [].\n' +
  'Не добавляй после блока текст и не дублируй блок.';

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

/** Возвращает инструкцию структурированных находок для роли */
export function buildFindingsInstruction(
  role: FindingsPromptRole | boolean = 'expert'
): string {
  return role === 'chair' || role === true
    ? CHAIR_FINDINGS_INSTRUCTION
    : EXPERT_FINDINGS_INSTRUCTION;
}

/** Добавляет инструкцию находок в конец промпта (идемпотентно) */
export function appendFindingsInstruction(
  prompt: string,
  role: FindingsPromptRole | boolean = 'expert'
): string {
  const instruction = buildFindingsInstruction(role);
  if (prompt.includes(instruction)) return prompt;
  return `${prompt}\n\n${instruction}`;
}

/** Собирает промпт эксперта: функция, шаблон с `${task}` или значение по умолчанию */
export function buildExpertPrompt(
  expert: ExpertConfig,
  task: string,
  findings = false
): string {
  let prompt: string;
  if (typeof expert.prompt === 'function') {
    prompt = expert.prompt(task);
  } else if (typeof expert.prompt === 'string' && expert.prompt.trim().length > 0) {
    prompt = expert.prompt.replace(/\$\{task\}/g, task);
  } else {
    const fallback = Object.prototype.hasOwnProperty.call(DEFAULT_EXPERT_PROMPTS, expert.name)
      ? DEFAULT_EXPERT_PROMPTS[expert.name]
      : DEFAULT_EXPERT_PROMPTS.default;
    if (typeof fallback === 'function') {
      prompt = fallback(task);
    } else if (typeof fallback === 'string') {
      prompt = fallback.replace(/\$\{task\}/g, task);
    } else {
      prompt = task;
    }
  }

  return findings ? appendFindingsInstruction(prompt, 'expert') : prompt;
}

/** Собирает промпт председателя по результатам экспертов */
export function buildChairPrompt(
  task: string,
  expertResults: AgentResult[],
  maxExpertTextLength: number,
  consensus = false,
  findings = false
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

  return findings ? appendFindingsInstruction(prompt, 'chair') : prompt;
}
