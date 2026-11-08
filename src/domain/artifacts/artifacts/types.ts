/**
 * @fileoverview Типы артефактов запусков консилиума
 * @module lv24-opencode-consilium
 */

import type { AgentUsage } from '../../types.js';

/** Ссылка на сохранённый артефакт */
export interface ArtifactRef {
  id: string;
  dir: string;
}

/** Результат одного эксперта внутри артефакта */
export interface ArtifactExpert {
  agent: string;
  model?: string;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  duration?: number;
  text: string;
  usage?: AgentUsage;
}

/** Сохранённый запуск консилиума */
export interface ArtifactRun {
  version: 1;
  id: string;
  createdAt: string;
  task: string;
  success: boolean;
  text: string;
  experts: ArtifactExpert[];
  models: Record<string, string | undefined>;
  /** Агент-председатель, чтобы replay восстановил именно его */
  chairAgent?: string;
  usage?: AgentUsage;
  consensus?: unknown;
  metadata?: Record<string, unknown>;
}

/** Допустимые символы идентификатора артефакта */
export const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Максимальная длина текста эксперта в отчёте */
export const MAX_EXPERT_TEXT_CHARS = 4000;
