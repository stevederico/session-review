import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCost, formatTokens, relativeTime, shortModel } from './format.js';

test('formatCost compacts thousands', () => {
  assert.equal(formatCost(1500), '$1.5k');
});

test('formatCost shows two decimals for whole-dollar range', () => {
  assert.equal(formatCost(3.4), '$3.40');
});

test('formatCost returns $0 for zero', () => {
  assert.equal(formatCost(0), '$0');
});

test('formatCost shows three decimals for sub-dollar amounts', () => {
  assert.ok(formatCost(0.012).startsWith('$0.012'));
});

test('formatTokens compacts billions', () => {
  assert.equal(formatTokens(2600000000), '2.6B');
});

test('formatTokens compacts millions', () => {
  assert.equal(formatTokens(3400000), '3.4M');
});

test('formatTokens compacts thousands', () => {
  assert.equal(formatTokens(1200), '1.2k');
});

test('formatTokens leaves small counts as-is', () => {
  assert.equal(formatTokens(42), '42');
});

test('shortModel strips claude- prefix', () => {
  assert.equal(shortModel('claude-opus-4-8'), 'opus-4-8');
});

test('shortModel strips synthetic suffix', () => {
  assert.equal(shortModel('claude-opus-4-8,<synthetic>'), 'opus-4-8');
});

test('relativeTime returns "now" for the current moment', () => {
  const nowIso = new Date().toISOString();
  assert.equal(relativeTime(nowIso), 'now');
});
