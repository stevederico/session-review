import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, priceFor, costOf } from './cc-index.js';

test('extractText returns a plain string message body', () => {
  assert.equal(extractText({ message: { role: 'user', content: 'hello' } }), 'hello');
});

test('extractText flattens assistant content blocks', () => {
  const rec = {
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'A' },
        { type: 'thinking', thinking: 'B' },
        { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
        { type: 'tool_result' },
      ],
    },
  };
  const text = extractText(rec);
  assert.ok(text.includes('A'));
  assert.ok(text.includes('B'));
  assert.ok(text.includes('Bash'));
});

test('priceFor resolves opus input pricing', () => {
  assert.equal(priceFor('claude-opus-4-8').in, 15);
});

test('priceFor resolves haiku output pricing', () => {
  assert.equal(priceFor('claude-3-5-haiku').out, 4);
});

test('priceFor defaults unknown models to sonnet pricing', () => {
  assert.deepEqual(priceFor('whatever-unknown'), {
    in: 3,
    out: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  });
});

test('costOf prices 1M opus input tokens', () => {
  assert.equal(costOf({ in_tok: 1000000, out_tok: 0, model: 'claude-opus-4-8' }), 15);
});

test('costOf prices 1M sonnet output tokens', () => {
  assert.equal(costOf({ out_tok: 1000000, model: 'claude-sonnet-4-6' }), 15);
});
