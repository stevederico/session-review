import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, stripCommandTags } from './markdown.js';

test('stripCommandTags removes paired command meta tags with their content', () => {
  const input =
    '<command-message>foo is running</command-message>\n<command-name>/foo</command-name>\n<command-args>bar</command-args>\nactual content';
  assert.equal(stripCommandTags(input), 'actual content');
});

test('stripCommandTags removes local-command-caveat blocks', () => {
  assert.equal(
    stripCommandTags('before\n<local-command-caveat>caveat</local-command-caveat>\nafter'),
    'before\n\nafter',
  );
});

test('stripCommandTags strips unpaired/leftover command tags', () => {
  assert.equal(stripCommandTags('hi <command-name> there'), 'hi  there');
});

test('stripCommandTags leaves ordinary text untouched', () => {
  assert.equal(stripCommandTags('just normal text'), 'just normal text');
});

test('parseMarkdown drops command meta tags before parsing', () => {
  const tokens = parseMarkdown('<command-name>/x</command-name>\nhello');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, 'paragraph');
  assert.equal(tokens[0].text, 'hello');
});

test('fenced code block captures language and code', () => {
  const [token] = parseMarkdown('```js\nconst a = 1;\n```');
  assert.deepEqual(token, { type: 'code', lang: 'js', code: 'const a = 1;' });
});

test('# Title parses as a level-1 heading', () => {
  assert.deepEqual(parseMarkdown('# Title')[0], {
    type: 'heading',
    level: 1,
    text: 'Title',
  });
});

test('unordered list parses with ordered:false and two items', () => {
  const [token] = parseMarkdown('- a\n- b');
  assert.equal(token.type, 'list');
  assert.equal(token.ordered, false);
  assert.equal(token.items.length, 2);
});

test('task list checkboxes capture checked state', () => {
  const [token] = parseMarkdown('- [x] done\n- [ ] todo');
  assert.equal(token.items[0].checked, true);
  assert.equal(token.items[1].checked, false);
});

test('ordered list parses with ordered:true', () => {
  assert.equal(parseMarkdown('1. one')[0].ordered, true);
});

test('> quote parses as a blockquote', () => {
  assert.deepEqual(parseMarkdown('> quote')[0], {
    type: 'blockquote',
    text: 'quote',
  });
});

test('--- parses as a horizontal rule', () => {
  assert.deepEqual(parseMarkdown('---')[0], { type: 'hr' });
});

test('GFM table parses header columns and rows', () => {
  const [token] = parseMarkdown(
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
  );
  assert.equal(token.type, 'table');
  assert.equal(token.header.length, 2);
  assert.equal(token.rows.length, 2);
});

test('plain text parses as a paragraph', () => {
  assert.deepEqual(parseMarkdown('just words here')[0], {
    type: 'paragraph',
    text: 'just words here',
  });
});

// --- Issue 1: multi-backtick inline code spans (parseInline now pure/exported) ---

test('parseInline: single-backtick code span', () => {
  assert.deepEqual(parseInline('`code`'), [{ type: 'code', value: 'code' }]);
});

test('parseInline: double-backtick span keeps an inner single backtick', () => {
  assert.deepEqual(parseInline('``a`b``'), [{ type: 'code', value: 'a`b' }]);
});

test('parseInline: the motivating case is not truncated', () => {
  assert.deepEqual(parseInline('``git log --format=%h ` x``'), [
    { type: 'code', value: 'git log --format=%h ` x' },
  ]);
});

test('parseInline: strips one leading and trailing space when both present', () => {
  assert.deepEqual(parseInline('`` `code` ``'), [{ type: 'code', value: '`code`' }]);
});

test('parseInline: all-whitespace code span is left intact', () => {
  assert.deepEqual(parseInline('`   `'), [{ type: 'code', value: '   ' }]);
});

test('parseInline: unterminated backtick run is literal text', () => {
  assert.deepEqual(parseInline('a `` b'), [{ type: 'text', value: 'a `` b' }]);
});

test('parseInline: text + code + text coalesces plain runs', () => {
  assert.deepEqual(parseInline('see `id` here'), [
    { type: 'text', value: 'see ' },
    { type: 'code', value: 'id' },
    { type: 'text', value: ' here' },
  ]);
});

// --- Issue 1: other inline tokens (lock the contract) ---

test('parseInline: strong with text children', () => {
  assert.deepEqual(parseInline('**bold**'), [
    { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
  ]);
});

test('parseInline: star emphasis', () => {
  assert.deepEqual(parseInline('*em*'), [
    { type: 'em', children: [{ type: 'text', value: 'em' }] },
  ]);
});

test('parseInline: underscore italics at word boundary', () => {
  assert.deepEqual(parseInline('_em_'), [
    { type: 'em', children: [{ type: 'text', value: 'em' }] },
  ]);
});

test('parseInline: snake_case is NOT italicized', () => {
  assert.deepEqual(parseInline('foo_bar_baz'), [{ type: 'text', value: 'foo_bar_baz' }]);
});

test('parseInline: strikethrough', () => {
  assert.deepEqual(parseInline('~~gone~~'), [
    { type: 'del', children: [{ type: 'text', value: 'gone' }] },
  ]);
});

test('parseInline: markdown link', () => {
  assert.deepEqual(parseInline('[text](https://x.com)'), [
    { type: 'link', href: 'https://x.com', children: [{ type: 'text', value: 'text' }] },
  ]);
});

test('parseInline: bare autolink (text equals href)', () => {
  assert.deepEqual(parseInline('see https://x.com/a now'), [
    { type: 'text', value: 'see ' },
    { type: 'autolink', href: 'https://x.com/a' },
    { type: 'text', value: ' now' },
  ]);
});

test('parseInline: code is not reparsed for emphasis', () => {
  assert.deepEqual(parseInline('`**not bold**`'), [{ type: 'code', value: '**not bold**' }]);
});

test('parseInline: emphasis children are themselves tokenized (nested code)', () => {
  assert.deepEqual(parseInline('**a `b` c**'), [
    {
      type: 'strong',
      children: [
        { type: 'text', value: 'a ' },
        { type: 'code', value: 'b' },
        { type: 'text', value: ' c' },
      ],
    },
  ]);
});

test('parseInline: empty/null input yields no tokens', () => {
  assert.deepEqual(parseInline(''), []);
  assert.deepEqual(parseInline(null), []);
});

// --- Issue 2: nested lists ---

test('nested unordered list attaches to previous item', () => {
  const [token] = parseMarkdown('- a\n  - b');
  assert.equal(token.type, 'list');
  assert.equal(token.ordered, false);
  assert.equal(token.items.length, 1);
  assert.equal(token.items[0].text, 'a');
  assert.equal(token.items[0].children.type, 'list');
  assert.equal(token.items[0].children.items[0].text, 'b');
});

test('two top-level items stay siblings (no false nesting)', () => {
  const [token] = parseMarkdown('- a\n- b');
  assert.equal(token.items.length, 2);
  assert.equal(token.items[0].children, null);
  assert.equal(token.items[1].children, null);
});

test('nested sub-list may be ordered under an unordered parent', () => {
  const [token] = parseMarkdown('- a\n  1. b\n  2. c');
  assert.equal(token.ordered, false);
  assert.equal(token.items[0].children.ordered, true);
  assert.equal(token.items[0].children.items.length, 2);
});

test('item after a nested block returns to the parent level', () => {
  const [token] = parseMarkdown('- a\n  - b\n- c');
  assert.equal(token.items.length, 2);
  assert.equal(token.items[0].children.items[0].text, 'b');
  assert.equal(token.items[1].text, 'c');
  assert.equal(token.items[1].children, null);
});

test('deeply nested (3 levels) builds nested list tokens without looping', () => {
  const [token] = parseMarkdown('- a\n  - b\n    - c');
  const lvl2 = token.items[0].children;
  assert.equal(lvl2.items[0].text, 'b');
  assert.equal(lvl2.items[0].children.items[0].text, 'c');
  assert.equal(lvl2.items[0].children.items[0].children, null);
});

test('non-nested ordered list items report children:null', () => {
  const [token] = parseMarkdown('1. one\n2. two');
  assert.equal(token.items[0].children, null);
  assert.equal(token.items[1].children, null);
});

test('task list items carry children:null', () => {
  const [token] = parseMarkdown('- [x] done\n- [ ] todo');
  assert.equal(token.items[0].checked, true);
  assert.equal(token.items[0].children, null);
  assert.equal(token.items[1].children, null);
});

// --- Issue 3: empty-table fallback ---

test('a bare pipe is not a table; falls through to paragraph/line', () => {
  const tokens = parseMarkdown('|\n| --- |\n| 1 |');
  assert.notEqual(tokens[0].type, 'table');
});

test('header with empty cells only is not a table', () => {
  const tokens = parseMarkdown('|  |  |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(tokens.every((t) => t.type !== 'table'));
});

test('valid GFM table still parses (regression guard)', () => {
  const [token] = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
  assert.equal(token.type, 'table');
  assert.equal(token.header.length, 2);
  assert.equal(token.rows.length, 2);
});
