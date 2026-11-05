/**
 * @fileoverview Декодер NDJSON-потока OpenCode CLI
 * @module opencode-consilium
 */

import { StringDecoder } from 'string_decoder';
import type { AgentUsage } from './types.js';

/** Результат разбора потока событий */
export interface ParsedStream {
  /** Собранный текст ответа */
  text: string;
  /** Сообщения об ошибках из потока */
  errors: string[];
  /** Суммарный расход токенов и стоимость */
  usage: AgentUsage;
  /** Количество разобранных JSON-событий */
  eventCount: number;
}

/** Буферизованный декодер событий */
export interface EventDecoder {
  /** Добавляет очередной фрагмент потока */
  push(chunk: string | Buffer): void;
  /** Возвращает текущее состояние без завершения */
  snapshot(): ParsedStream;
  /** Завершает разбор (обрабатывает остаток буфера) */
  end(): ParsedStream;
}

const MAX_ERRORS = 20;
const MAX_ERROR_LENGTH = 500;

interface TextSegment {
  id: string | null;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Создаёт декодер NDJSON-потока.
 * Понимает события text, step_finish, error и message.part.updated.
 */
export function createEventDecoder(): EventDecoder {
  let buffer = '';
  let sawText = false;
  let eventCount = 0;

  const segments: TextSegment[] = [];
  const segmentIndex = new Map<string, number>();
  const errors: string[] = [];
  const usage: AgentUsage = {};
  const stringDecoder = new StringDecoder('utf8');

  function addError(message: string): void {
    if (errors.length >= MAX_ERRORS) return;
    errors.push(message.slice(0, MAX_ERROR_LENGTH));
  }

  function addUsage(field: Exclude<keyof AgentUsage, 'cost'>, value: number | undefined): void {
    if (value === undefined) return;
    const current = usage[field];
    usage[field] = (typeof current === 'number' ? current : 0) + value;
  }

  function appendText(text: string): void {
    segments.push({ id: null, text });
    sawText = true;
  }

  function storeTextById(id: string, text: string): void {
    const existing = segmentIndex.get(id);
    if (existing !== undefined) {
      segments[existing] = { id, text };
    } else {
      segmentIndex.set(id, segments.length);
      segments.push({ id, text });
    }
    sawText = true;
  }

  function handleStepFinish(part: Record<string, unknown>): void {
    const tokens = isRecord(part.tokens) ? part.tokens : undefined;
    if (tokens) {
      addUsage('inputTokens', asNumber(tokens.input));
      addUsage('outputTokens', asNumber(tokens.output));
      addUsage('reasoningTokens', asNumber(tokens.reasoning));
      const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
      if (cache) {
        addUsage('cacheReadTokens', asNumber(cache.read));
        addUsage('cacheWriteTokens', asNumber(cache.write));
      }
    }

    const cost = asNumber(part.cost);
    if (cost !== undefined) {
      usage.cost = (usage.cost ?? 0) + cost;
    }
  }

  function handleEvent(event: unknown): void {
    if (!isRecord(event)) return;
    eventCount += 1;

    const type = asString(event.type);
    const part = isRecord(event.part) ? event.part : undefined;

    if (type === 'text') {
      const text = part ? asString(part.text) : undefined;
      if (text !== undefined) appendText(text);
      return;
    }

    if (type === 'step_finish') {
      if (part) handleStepFinish(part);
      return;
    }

    if (type === 'error') {
      const errorPart = isRecord(event.error) ? event.error : undefined;
      const message =
        asString(errorPart?.message) ??
        asString(part?.message) ??
        safeStringify(event).slice(0, MAX_ERROR_LENGTH);
      addError(message);
      return;
    }

    if (type === 'message.part.updated') {
      if (!part || asString(part.type) !== 'text') return;
      const text = asString(part.text);
      if (text === undefined) return;
      const id = asString(part.id);
      if (id !== undefined) {
        storeTextById(id, text);
      } else {
        appendText(text);
      }
    }
  }

  function processLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      // Плейн-текст до первого текстового события сохраняем как ошибку
      if (!sawText) addError(trimmed);
      return;
    }

    handleEvent(event);
  }

  function buildSnapshot(): ParsedStream {
    return {
      text: segments.map(segment => segment.text).join(''),
      errors: [...errors],
      usage: { ...usage },
      eventCount
    };
  }

  return {
    push(chunk: string | Buffer): void {
      buffer += typeof chunk === 'string' ? chunk : stringDecoder.write(chunk);
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd !== -1) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        processLine(line);
        lineEnd = buffer.indexOf('\n');
      }
    },

    snapshot(): ParsedStream {
      return buildSnapshot();
    },

    end(): ParsedStream {
      buffer += stringDecoder.end();
      if (buffer.length > 0) {
        const rest = buffer;
        buffer = '';
        processLine(rest);
      }
      return buildSnapshot();
    }
  };
}

/** Разовый разбор JSON-вывода OpenCode CLI (обратная совместимость) */
export function parseJsonOutput(output: string): string {
  const decoder = createEventDecoder();
  decoder.push(output);
  return decoder.end().text;
}
