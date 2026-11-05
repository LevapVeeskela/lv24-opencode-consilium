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
