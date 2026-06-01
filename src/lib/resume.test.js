import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeCommand } from './resume.js';

test('resumeCommand builds the --resume command for a session id', () => {
  assert.equal(
    resumeCommand('8f3c1e22-0a4b-4c7d-9e10-abc123def456'),
    'claude --resume 8f3c1e22-0a4b-4c7d-9e10-abc123def456',
  );
});

test('resumeCommand prefixes a cd into the conversation cwd when given', () => {
  assert.equal(
    resumeCommand('abc', '/Users/sd/Desktop/projects/cc-review'),
    "cd '/Users/sd/Desktop/projects/cc-review' && claude --resume abc",
  );
});

test('resumeCommand shell-escapes a cwd containing a single quote', () => {
  assert.equal(
    resumeCommand('abc', "/tmp/o'brien"),
    "cd '/tmp/o'\\''brien' && claude --resume abc",
  );
});

test('resumeCommand returns empty string for a falsy id', () => {
  assert.equal(resumeCommand(''), '');
  assert.equal(resumeCommand(undefined), '');
  assert.equal(resumeCommand(null), '');
});
