/**
 * @fileoverview Сбор структурированных находок из ответов экспертов и председателя.
 * @module lv24-opencode-consilium
 */

import type { AgentResult } from '../domain/types.js';
import {
  mergeFindings,
  parseFindingsBlock
} from '../domain/council/findings.js';
import type {
  FindingsSummary,
  RawFinding,
  RejectedPosition
} from '../domain/council/findings.js';

/** Запись для слияния: один ответ агента с разобранными находками */
interface FindingsEntry {
  agent: string;
  model?: string;
  findings: RawFinding[];
  rejected?: Array<{ claim: string; reason?: string }>;
}

/**
 * Разбирает ответы экспертов и председателя и сливает находки.
 * Отсутствие блока не считается падением: причина попадает в parseErrors.
 */
export function collectFindings(
  experts: AgentResult[],
  chair?: AgentResult
): FindingsSummary {
  const entries: FindingsEntry[] = [];
  const parseErrors: string[] = [];
  const results = chair === undefined ? experts : [...experts, chair];

  for (const result of results) {
    if (typeof result.text !== 'string' || result.text.trim().length === 0) {
      continue;
    }

    const parsed = parseFindingsBlock(result.text);
    if (parsed.error !== undefined) {
      parseErrors.push(`${result.agent}: ${parsed.error}`);
      continue;
    }
    if (parsed.findings.length === 0 && parsed.rejected.length === 0) {
      continue;
    }

    const entry: FindingsEntry = {
      agent: result.agent,
      findings: parsed.findings
    };
    if (result.model !== undefined && result.model.length > 0) {
      entry.model = result.model;
    }
    if (parsed.rejected.length > 0) {
      entry.rejected = parsed.rejected.map((item: RejectedPosition) => ({
        claim: item.claim,
        reason: item.reason
      }));
    }
    entries.push(entry);
  }

  const summary = mergeFindings(entries);
  summary.parseErrors = parseErrors;
  return summary;
}
