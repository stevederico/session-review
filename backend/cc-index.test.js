import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractText,
  priceFor,
  costOf,
  canonicalProject,
  isConversational,
  resolveProject,
  toIso,
  decodeGrokCwd,
  grokToolName,
  stringifyGrokOutput,
  grokUpdatesToRecords,
} from './cc-index.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

test('priceFor resolves grok family pricing', () => {
  assert.equal(priceFor('grok-4.5').in, 3);
  assert.equal(priceFor('grok-build').out, 15);
});

test('toIso converts unix seconds to ISO', () => {
  assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
});

test('toIso prefers agentTimestampMs', () => {
  assert.equal(toIso(1, 0), '1970-01-01T00:00:00.000Z');
});

test('decodeGrokCwd URL-decodes the group folder name', () => {
  assert.equal(
    decodeGrokCwd('%2FUsers%2Fdev%2Fprojects', tmpdir()),
    '/Users/dev/projects',
  );
});

test('grokToolName prefers rawInput.variant', () => {
  assert.equal(grokToolName({ title: 'Write', rawInput: { variant: 'CursorWrite' } }), 'CursorWrite');
});

test('grokToolName falls back to title prefix', () => {
  assert.equal(grokToolName({ title: 'Edit `/tmp/x`' }), 'Edit');
});

test('stringifyGrokOutput prefers tool_output_for_prompt', () => {
  assert.equal(
    stringifyGrokOutput({
      rawOutput: { EditsApplied: { tool_output_for_prompt: 'Wrote file' } },
    }),
    'Wrote file',
  );
});

test('grokUpdatesToRecords normalizes user + assistant + tool to Claude shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-sess-'));
  const lines = [
    {
      timestamp: 1000,
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
        _meta: { agentTimestampMs: 1000000 },
      },
    },
    {
      timestamp: 1001,
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking…' },
        },
      },
    },
    {
      timestamp: 1002,
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Read',
          rawInput: { path: '/tmp/a' },
        },
      },
    },
    {
      timestamp: 1003,
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          rawOutput: { tool_output_for_prompt: 'file body' },
        },
      },
    },
    {
      timestamp: 1004,
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        },
      },
    },
    {
      timestamp: 1005,
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'turn_completed',
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            cachedReadTokens: 40,
            modelUsage: { 'grok-4.5': {} },
          },
        },
      },
    },
  ];
  writeFileSync(join(dir, 'updates.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const records = grokUpdatesToRecords(dir);
  assert.equal(records[0].type, 'user');
  assert.equal(records[0].message.content, 'hello');
  assert.equal(records[1].type, 'assistant');
  const blocks = records[1].message.content;
  assert.ok(blocks.some((b) => b.type === 'thinking' && b.thinking.includes('thinking')));
  assert.ok(blocks.some((b) => b.type === 'text' && b.text === 'done'));
  assert.ok(blocks.some((b) => b.type === 'tool_use' && b.id === 't1'));
  assert.equal(records[1].message.model, 'grok-4.5');
  assert.equal(records[2].type, 'user');
  assert.equal(records[2].message.content[0].type, 'tool_result');
  assert.equal(records[2].message.content[0].content, 'file body');
});

test('costOf prices 1M opus input tokens', () => {
  assert.equal(costOf({ in_tok: 1000000, out_tok: 0, model: 'claude-opus-4-8' }), 15);
});

test('costOf prices 1M sonnet output tokens', () => {
  assert.equal(costOf({ out_tok: 1000000, model: 'claude-sonnet-4-6' }), 15);
});

test('canonicalProject uses the cwd basename for a plain repo', () => {
  assert.deepEqual(
    canonicalProject('/Users/dev/projects/session-review'),
    { key: '/Users/dev/projects/session-review', name: 'session-review' }
  );
});

test('canonicalProject folds a git worktree into its parent repo', () => {
  assert.deepEqual(
    canonicalProject('/Users/dev/projects/demo-app/.claude/worktrees/crazy-johnson-a99b2c'),
    { key: '/Users/dev/projects/demo-app', name: 'demo-app' }
  );
});

test('canonicalProject folds a dash-encoded worktree folder name', () => {
  const { name } = canonicalProject('', '-Users-dev-projects-demo-app--claude-worktrees-crazy-johnson-a99b2c');
  assert.equal(name, '-Users-dev-projects-demo-app');
});

test('canonicalProject prefers cwd over the encoded project fallback', () => {
  assert.equal(
    canonicalProject('/Users/dev/projects/demo-app', '-Users-dev-projects-demo-app').name,
    'demo-app'
  );
});

test('canonicalProject strips a trailing slash', () => {
  assert.equal(canonicalProject('/Users/dev/projects/demo-app/').name, 'demo-app');
});

test('isConversational counts a typed user prompt (string content)', () => {
  assert.equal(isConversational({ type: 'user', message: { content: 'hello there' } }), true);
});

test('isConversational counts an assistant text reply', () => {
  assert.equal(
    isConversational({ type: 'assistant', message: { content: [{ type: 'text', text: 'sure' }] } }),
    true
  );
});

test('isConversational rejects a tool_result (user-role plumbing)', () => {
  assert.equal(
    isConversational({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    false
  );
});

test('isConversational rejects a tool_use-only assistant record', () => {
  assert.equal(
    isConversational({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
    false
  );
});

test('isConversational rejects an empty text block', () => {
  assert.equal(
    isConversational({ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } }),
    false
  );
});

test('resolveProject honors a manual override', () => {
  const overrides = new Map([['abc', '/Users/dev/projects/other-app']]);
  assert.deepEqual(
    resolveProject({ id: 'abc', cwd: '/Users/dev/projects' }, overrides),
    { key: '/Users/dev/projects/other-app', name: 'other-app' }
  );
});

test('resolveProject falls back to canonical project when unset', () => {
  assert.equal(
    resolveProject({ id: 'xyz', cwd: '/Users/dev/projects/demo-app' }, new Map()).name,
    'demo-app'
  );
});

test('resolveProject works without an overrides map', () => {
  assert.equal(
    resolveProject({ id: 'x', cwd: '/Users/dev/projects/demo-app' }).name,
    'demo-app'
  );
});
