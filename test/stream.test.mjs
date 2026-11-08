import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventDecoder, parseJsonOutput } from '../dist/stream.js';

test('decoder собирает текст из нескольких чанков NDJSON', () => {
  const decoder = createEventDecoder();
  decoder.push('{"type":"text","part":{"text":"Hel');
  decoder.push('lo"}}\n{"type":"step_finish","part":{"cost":0.5,"tokens":{"input":10,"output":2,"cache":{"read":3,"write":1}}}}');
  const result = decoder.end();
  assert.equal(result.text, 'Hello');
  assert.equal(result.usage.cost, 0.5);
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 2);
  assert.equal(result.usage.cacheReadTokens, 3);
  assert.equal(result.usage.cacheWriteTokens, 1);
});

test('decoder понимает CRLF и несколько событий в одном чанке', () => {
  const decoder = createEventDecoder();
  decoder.push('{"type":"text","part":{"text":"A"}}\r\n{"type":"text","part":{"text":"B"}}\r\n');
  assert.equal(decoder.end().text, 'AB');
});

test('decoder собирает ошибки OpenCode', () => {
  const decoder = createEventDecoder();
  decoder.push('{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: x"}}\n');
  const result = decoder.end();
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Model unavailable/);
});

test('parseJsonOutput оставлен для обратной совместимости', () => {
  assert.equal(
    parseJsonOutput('{"type":"text","part":{"text":"x"}}\nnot json'),
    'x'
  );
});

test('decoder сохраняет структурированные ошибки OpenCode V2', () => {
  const decoder = createEventDecoder();
  decoder.push(
    '{"type":"error","error":{"type":"provider.free-limit","message":"Free usage limit reached","status":429,"retryAfterMs":82766000}}\n'
  );
  const result = decoder.end();
  assert.equal(result.errorDetails.length, 1);
  assert.equal(result.errorDetails[0].type, 'provider.free-limit');
  assert.equal(result.errorDetails[0].status, 429);
  assert.equal(result.errorDetails[0].retryAfterMs, 82766000);
});

test('decoder понимает обёртку properties и delta-текст', () => {
  const decoder = createEventDecoder();
  decoder.push('{"type":"text","properties":{"part":{"type":"text","delta":"Hel"}}}\n');
  decoder.push('{"type":"text","properties":{"part":{"type":"text","delta":"lo"}}}\n');
  assert.equal(decoder.end().text, 'Hello');
});

test('decoder собирает delta из message.part.updated', () => {
  const decoder = createEventDecoder();
  decoder.push('{"type":"message.part.updated","part":{"type":"text","id":"p1","delta":"A"}}\n');
  decoder.push('{"type":"message.part.updated","part":{"type":"text","id":"p1","delta":"B"}}\n');
  assert.equal(decoder.end().text, 'AB');
});

test('decoder сохраняет sessionID из событий', () => {
  const decoder = createEventDecoder();
  decoder.push('{"type":"step_start","sessionID":"ses_test123","part":{}}\n');
  decoder.push('{"type":"text","sessionID":"ses_test123","part":{"text":"ok"}}\n');
  const result = decoder.end();
  assert.equal(result.sessionID, 'ses_test123');
  assert.equal(result.text, 'ok');
});
