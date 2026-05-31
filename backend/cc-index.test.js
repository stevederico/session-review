import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, priceFor, costOf, canonicalProject, isConversational, resolveProject, archivePathFor } from './cc-index.js';

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
    canonicalProject('/Users/sd/Desktop/projects/cc-review'),
    { key: '/Users/sd/Desktop/projects/cc-review', name: 'cc-review' }
  );
});

test('canonicalProject folds a git worktree into its parent repo', () => {
  assert.deepEqual(
    canonicalProject('/Users/sd/Desktop/projects/dottie-desktop/.claude/worktrees/crazy-johnson-a99b2c'),
    { key: '/Users/sd/Desktop/projects/dottie-desktop', name: 'dottie-desktop' }
  );
});

test('canonicalProject folds a dash-encoded worktree folder name', () => {
  const { name } = canonicalProject('', '-Users-sd-Desktop-projects-dottie-desktop--claude-worktrees-crazy-johnson-a99b2c');
  assert.equal(name, '-Users-sd-Desktop-projects-dottie-desktop');
});

test('canonicalProject prefers cwd over the encoded project fallback', () => {
  assert.equal(
    canonicalProject('/Users/sd/Desktop/projects/onyx', '-Users-sd-Desktop-projects-onyx').name,
    'onyx'
  );
});

test('canonicalProject strips a trailing slash', () => {
  assert.equal(canonicalProject('/Users/sd/Desktop/projects/onyx/').name, 'onyx');
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
  const overrides = new Map([['abc', '/Users/sd/Desktop/projects/fund-admin']]);
  assert.deepEqual(
    resolveProject({ id: 'abc', cwd: '/Users/sd/Desktop/projects' }, overrides),
    { key: '/Users/sd/Desktop/projects/fund-admin', name: 'fund-admin' }
  );
});

test('resolveProject falls back to canonical project when unset', () => {
  assert.equal(
    resolveProject({ id: 'xyz', cwd: '/Users/sd/Desktop/projects/onyx' }, new Map()).name,
    'onyx'
  );
});

test('resolveProject works without an overrides map', () => {
  assert.equal(
    resolveProject({ id: 'x', cwd: '/Users/sd/Desktop/projects/onyx' }).name,
    'onyx'
  );
});

test('archivePathFor mirrors project/id under the archive dir', () => {
  const p = archivePathFor('-Users-sd-Desktop-projects-onyx', 'abc-123');
  assert.ok(p.endsWith('/databases/archive/-Users-sd-Desktop-projects-onyx/abc-123.jsonl'));
});

test('archivePathFor tolerates a missing project folder', () => {
  assert.ok(archivePathFor('', 'abc-123').endsWith('/databases/archive/_/abc-123.jsonl'));
});
