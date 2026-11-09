/**
 * @fileoverview SARIF 2.1.0 экспорт находок консилиума.
 * @module lv24-opencode-consilium/sarif
 */

import type {
  Finding,
  FindingSeverity,
  FindingsSummary
} from '../council/findings.js';

/** Имя инструмента в SARIF-документе. */
export const SARIF_TOOL_NAME = 'lv24-opencode-consilium';

/** Схема SARIF 2.1.0. */
export const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';

/** Домашняя страница инструмента по умолчанию. */
export const SARIF_INFORMATION_URI =
  'https://github.com/LevapVeeskela/lv24-opencode-consilium';

/** Опции построения SARIF-отчёта. */
export interface SarifOptions {
  /** Версия инструмента для `tool.driver.version`. */
  version: string;
  /** Ссылка на документацию инструмента. */
  informationUri?: string;
}

/** Уровень SARIF для серьёзности находки. */
export type SarifLevel = 'error' | 'warning' | 'note';

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0
};

interface SarifRule {
  id: string;
  shortDescription: { text: string };
}

/** Стабильный slug категории для ruleId. */
function categorySlug(category: string): string {
  const slug = category
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'general';
}

/** Сопоставление серьёзности консилиума уровню SARIF. */
export function sarifLevel(severity: FindingSeverity): SarifLevel {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note';
}

/** Нормализует путь к файлу в URI с прямыми слэшами. */
function normalizeUri(file: string): string {
  return file.replace(/\\/g, '/');
}

function compareFindings(left: Finding, right: Finding): number {
  const bySeverity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (bySeverity !== 0) return bySeverity;
  if (left.claim < right.claim) return -1;
  if (left.claim > right.claim) return 1;
  if (left.fingerprint < right.fingerprint) return -1;
  if (left.fingerprint > right.fingerprint) return 1;
  return 0;
}

function buildRules(findings: readonly Finding[]): SarifRule[] {
  const byId = new Map<string, SarifRule>();
  for (const finding of findings) {
    const id = `consilium/${categorySlug(finding.category)}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      shortDescription: { text: finding.category }
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function buildMessage(finding: Finding): Record<string, string> {
  if (typeof finding.evidence !== 'string' || finding.evidence.length === 0) {
    return { text: finding.claim };
  }
  return {
    text: finding.claim,
    markdown: `${finding.claim}\n\n${finding.evidence}`
  };
}

function buildLocations(finding: Finding): object[] | undefined {
  if (typeof finding.file !== 'string' || finding.file.length === 0) return undefined;
  const physicalLocation: Record<string, unknown> = {
    artifactLocation: { uri: normalizeUri(finding.file) }
  };
  if (
    typeof finding.line === 'number' &&
    Number.isFinite(finding.line) &&
    finding.line > 0
  ) {
    physicalLocation['region'] = { startLine: Math.floor(finding.line) };
  }
  return [{ physicalLocation }];
}

/**
 * Строит SARIF 2.1.0 документ по сводке находок.
 * Порядок результатов детерминирован: серьёзность по убыванию, затем claim.
 */
export function buildSarifReport(
  findings: FindingsSummary | undefined,
  options: SarifOptions
): object {
  const sorted = [...(findings?.items ?? [])].sort(compareFindings);
  const rules = buildRules(sorted);

  const results = sorted.map(finding => {
    const ruleId = `consilium/${categorySlug(finding.category)}`;
    const locations = buildLocations(finding);
    return {
      ruleId,
      level: sarifLevel(finding.severity),
      message: buildMessage(finding),
      ...(locations === undefined ? {} : { locations }),
      partialFingerprints: {
        primaryLocationLineHash: finding.fingerprint
      },
      properties: {
        category: finding.category,
        confidence: finding.confidence,
        sources: finding.sources.map(source =>
          source.model === undefined
            ? { agent: source.agent }
            : { agent: source.agent, model: source.model }
        ),
        contested: finding.contested,
        rejectedBy: [...finding.rejectedBy],
        severity: finding.severity
      }
    };
  });

  return {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            version: options.version,
            informationUri: options.informationUri ?? SARIF_INFORMATION_URI,
            rules
          }
        },
        results,
        invocations: [{ executionSuccessful: true }]
      }
    ]
  };
}
