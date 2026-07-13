import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeCommand } from './resume.ts';

test('resumeCommand defaults to claude --resume', () => {
  assert.equal(
    resumeCommand('8f3c1e22-0a4b-4c7d-9e10-abc123def456'),
    'claude --resume 8f3c1e22-0a4b-4c7d-9e10-abc123def456',
  );
});

test('resumeCommand uses grok for grok sessions', () => {
  assert.equal(
    resumeCommand('019f0f3b-d25d-7fb1-bd62-4423600ad162', null, 'grok'),
    'grok --resume 019f0f3b-d25d-7fb1-bd62-4423600ad162',
  );
});

test('resumeCommand prefixes a cd into the conversation cwd when given', () => {
  assert.equal(
    resumeCommand('abc', '/Users/dev/projects/session-review', 'claude'),
    "cd '/Users/dev/projects/session-review' && claude --resume abc",
  );
});

test('resumeCommand shell-escapes a cwd containing a single quote', () => {
  assert.equal(
    resumeCommand('abc', "/tmp/o'brien", 'grok'),
    "cd '/tmp/o'\\''brien' && grok --resume abc",
  );
});

test('resumeCommand returns empty string for a falsy id', () => {
  assert.equal(resumeCommand(''), '');
  assert.equal(resumeCommand(undefined), '');
  assert.equal(resumeCommand(null), '');
});
