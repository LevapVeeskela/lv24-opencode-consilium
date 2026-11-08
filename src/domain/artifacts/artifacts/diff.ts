/**
 * @fileoverview Сравнение артефактов запусков консилиума
 * @module lv24-opencode-consilium
 */

import type { ArtifactRun } from './types.js';

/** Сравнивает два артефакта и возвращает markdown-отчёт */
export function diffArtifacts(a: ArtifactRun, b: ArtifactRun): string {
  const lines: string[] = [];
  lines.push(`# Сравнение запусков: ${a.id} ↔ ${b.id}`);
  lines.push('');
  lines.push(`- Задача: ${a.task === b.task ? 'без изменений' : 'ИЗМЕНИЛАСЬ'}`);
  if (a.task !== b.task) {
    lines.push(`  - Было: ${a.task}`);
    lines.push(`  - Стало: ${b.task}`);
  }
  lines.push(`- Даты: ${a.createdAt} → ${b.createdAt}`);
  lines.push(`- Статус: ${a.success ? '✅' : '❌'} → ${b.success ? '✅' : '❌'}`);
  lines.push('');
  lines.push('## Модели');
  lines.push('');
  lines.push('| Агент | Было | Стало |');
  lines.push('| --- | --- | --- |');
  const names = new Set<string>([...Object.keys(a.models), ...Object.keys(b.models)]);
  if (names.size === 0) {
    lines.push('| — | — | — |');
  } else {
    for (const name of [...names].sort()) {
      const before = a.models[name] ?? '—';
      const after = b.models[name] ?? '—';
      const mark = before === after ? '' : ' ⚠';
      lines.push(`| ${name} | ${before} | ${after}${mark} |`);
    }
  }
  lines.push('');
  lines.push('## Эксперты');
  lines.push('');
  lines.push('| Агент | Статус | Δ символов |');
  lines.push('| --- | --- | --- |');
  const mapA = new Map(a.experts.map(e => [e.agent, e]));
  const mapB = new Map(b.experts.map(e => [e.agent, e]));
  const allAgents = new Set<string>([...mapA.keys(), ...mapB.keys()]);
  if (allAgents.size === 0) {
    lines.push('| — | нет экспертов | — |');
  } else {
    for (const name of [...allAgents].sort()) {
      const ea = mapA.get(name);
      const eb = mapB.get(name);
      if (ea !== undefined && eb === undefined) {
        lines.push(`| ${name} | удалён | −${ea.text.length} |`);
      } else if (ea === undefined && eb !== undefined) {
        lines.push(`| ${name} | добавлен | +${eb.text.length} |`);
      } else if (ea !== undefined && eb !== undefined) {
        const delta = eb.text.length - ea.text.length;
        const status =
          ea.text === eb.text && ea.success === eb.success ? 'без изменений' : 'изменён';
        const deltaStr = delta === 0 ? '0' : delta > 0 ? `+${delta}` : `${delta}`;
        lines.push(`| ${name} | ${status} | ${deltaStr} |`);
      }
    }
  }
  lines.push('');
  lines.push('## Итоговый текст');
  lines.push('');
  const delta = b.text.length - a.text.length;
  lines.push(`- Длина: ${a.text.length} → ${b.text.length} (Δ ${delta >= 0 ? `+${delta}` : `${delta}`})`);
  lines.push(`- Текст ${a.text === b.text ? 'без изменений' : 'ИЗМЕНИЛСЯ'}`);
  lines.push('');
  return lines.join('\n');
}
