import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, priceFor, costOf, canonicalProject, isConversational } from './cc-index.js';

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

test('canonicalProject uses the cwd basename for a plain repo', () => {
  assert.deepEqual(
    canonicalProject('/Users/dev/projects/session-review'),
    { key: '/Users/dev/projects/session-review', name: 'cc-review' }
  );
});

test('canonicalProject folds a git worktree into its parent repo', () => {
  assert.deepEqual(
    canonicalProject('/Users/dev/projects/demo-app/.claude/worktrees/crazy-johnson-a99b2c'),
    { key: '/Users/dev/projects/demo-app', name: 'dottie-desktop' }
  );
});

test('canonicalProject folds a dash-encoded worktree folder name', () => {
  const { name } = canonicalProject('', '-Users-dev-projects-demo-app--claude-worktrees-crazy-johnson-a99b2c');
  assert.equal(name, '-Users-dev-projects-demo-app');
});

test('canonicalProject prefers cwd over the encoded project fallback', () => {
  assert.equal(
    canonicalProject('/Users/dev/projects/demo-app', '-Users-dev-projects-demo-app').name,
    'onyx'
  );
});

test('canonicalProject strips a trailing slash', () => {
  assert.equal(canonicalProject('/Users/dev/projects/demo-app/').name, 'onyx');
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
