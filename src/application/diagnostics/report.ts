/**
 * @fileoverview Форматирование отчёта диагностики Consilium
 * @module lv24-opencode-consilium
 */

import type { DoctorCheck } from './types.js';

/**
 * Форматирует отчёт диагностики для консоли
 */
export function formatDoctorReport(checks: DoctorCheck[]): string {
  const icons: Record<DoctorCheck['status'], string> = {
    ok: '✅',
    warn: '⚠️',
    fail: '❌'
  };

  const lines: string[] = [];
  let okCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const check of checks) {
    lines.push(`${icons[check.status]} [${check.id}] ${check.message}`);
    if (check.hint) {
      lines.push(`   ↳ ${check.hint}`);
    }

    if (check.status === 'ok') {
      okCount += 1;
    } else if (check.status === 'warn') {
      warnCount += 1;
    } else {
      failCount += 1;
    }
  }

  lines.push('');
  lines.push(`Итого: ${okCount} ok, ${warnCount} warnings, ${failCount} errors`);

  const verdict = failCount > 0 ? 'FAIL' : warnCount > 0 ? 'WARN' : 'PASS';
  lines.push(`Вердикт: ${verdict}`);

  return lines.join('\n');
}
