/**
 * Self-contained markdown -> React renderer for chat transcript prose.
 *
 * The pure block tokenizer (`parseMarkdown`) lives in `markdown.js` so it is
 * unit-testable by `node --test`. This module maps those tokens to elements and
 * handles inline formatting. It is deliberately JSX-free — the React tree is
 * built with `React.createElement` (aliased `h`) rather than JSX — so the file
 * keeps a plain `.js` extension and stays checkable by `node --check` (a `.jsx`
 * file is not). It re-exports `parseMarkdown` for convenience. No external
 * dependencies beyond React and the shared icon set.
 */

import { createElement as h, useMemo } from 'react';
import { Square, SquareCheck, Copy, Check } from '@stevederico/skateboard-ui/icons';
import { parseMarkdown, parseInline } from './markdown.js';
import { useCopy } from './useCopy.js';

export { parseMarkdown };

const ICON_SIZE = 14;

// --- inline rendering --------------------------------------------------------
const CODE_CLASS = 'rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]';
const LINK_CLASS = 'text-primary underline underline-offset-2 hover:opacity-80';

/**
 * Render an array of inline tokens (from `parseInline`) to React nodes.
 * Recurses for container tokens. Emits the same elements, classNames, and
 * attributes the renderer has always produced; text tokens are returned as bare
 * strings (React escapes them), so embedded HTML shows as literal text.
 *
 * @param {Array<object>} tokens - Inline tokens.
 * @returns {Array<(string|object)>} Mixed strings and React nodes.
 */
function renderInline(tokens) {
  return tokens.map((tok, idx) => {
    const key = `i${idx}`;
    switch (tok.type) {
      case 'text':
        return tok.value;
      case 'code':
        return h('code', { key, className: CODE_CLASS }, tok.value);
      case 'strong':
        return h('strong', { key }, renderInline(tok.children));
      case 'em':
        return h('em', { key }, renderInline(tok.children));
      case 'del':
        return h('del', { key }, renderInline(tok.children));
      case 'link':
        return h(
          'a',
          { key, href: tok.href, target: '_blank', rel: 'noopener noreferrer', className: LINK_CLASS },
          renderInline(tok.children),
        );
      case 'autolink':
        return h(
          'a',
          { key, href: tok.href, target: '_blank', rel: 'noopener noreferrer', className: LINK_CLASS },
          tok.href,
        );
      default:
        return null;
    }
  });
}

/** Parse + render inline markdown text in one step (drop-in for the old parseInline). */
function inline(text) {
  return renderInline(parseInline(text));
}

// --- block components --------------------------------------------------------
const HEADING_CLASSES = {
  1: 'text-2xl',
  2: 'text-xl',
  3: 'text-lg',
  4: 'text-base',
  5: 'text-sm',
  6: 'text-xs',
};

/** Render a heading token as the matching h1..h6 element. */
function Heading({ level, text }) {
  return h(
    `h${level}`,
    {
      className: `${HEADING_CLASSES[level] ?? 'text-base'} font-sans font-semibold tracking-tight mt-5 mb-2 first:mt-0`,
    },
    inline(text),
  );
}

/** Render a list token as <ul>/<ol>; task items show check icons; nested sub-lists render inside their <li>. */
function List({ ordered, items }) {
  const Tag = ordered ? 'ol' : 'ul';
  const isTaskList = items.some((it) => it.checked !== null);
  return h(
    Tag,
    {
      className: `${ordered ? 'list-decimal' : 'list-disc'} ${isTaskList ? 'list-none pl-0' : 'pl-5'} my-2 space-y-1`,
    },
    items.map((item, idx) => {
      // A nested sub-list (already a {type:'list',...} token) renders recursively;
      // null when the item has no sub-list, which React ignores.
      const nested = item.children
        ? h(List, { key: 'nested', ordered: item.children.ordered, items: item.children.items })
        : null;

      if (item.checked !== null) {
        const Icon = item.checked ? SquareCheck : Square;
        return h(
          'li',
          { key: idx, className: 'flex items-start gap-2 list-none' },
          h(Icon, {
            size: ICON_SIZE,
            className: 'mt-1 shrink-0 text-muted-foreground',
            'aria-hidden': 'true',
          }),
          h(
            'span',
            { className: item.checked ? 'line-through text-muted-foreground' : undefined },
            inline(item.text),
            nested,
          ),
        );
      }
      return h('li', { key: idx }, inline(item.text), nested);
    }),
  );
}

/** Render a GFM table token with a header row and zebra-striped body. */
function Table({ header, rows }) {
  return h(
    'div',
    { className: 'overflow-x-auto my-3' },
    h(
      'table',
      { className: 'w-full text-sm' },
      h(
        'thead',
        null,
        h(
          'tr',
          { className: 'border-b border-border' },
          header.map((cell, idx) =>
            h(
              'th',
              { key: idx, className: 'px-3 py-1.5 text-left align-top font-semibold' },
              inline(cell),
            ),
          ),
        ),
      ),
      h(
        'tbody',
        null,
        rows.map((row, rIdx) =>
          h(
            'tr',
            { key: rIdx, className: 'odd:bg-muted/30' },
            row.map((cell, cIdx) =>
              h(
                'td',
                { key: cIdx, className: 'px-3 py-1.5 text-left align-top' },
                inline(cell),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** A fenced code block with a language label and a copy-to-clipboard button. */
function CodeBlock({ lang, code }) {
  const { copied, copy } = useCopy();
  const Icon = copied ? Check : Copy;
  return h(
    'div',
    { className: 'rounded-lg border border-border overflow-hidden my-3' },
    h(
      'div',
      {
        className:
          'flex items-center justify-between bg-muted px-3 py-1.5 text-copy-sm text-muted-foreground',
      },
      h('span', { className: 'font-mono' }, (lang || 'text').toLowerCase()),
      h(
        'button',
        {
          type: 'button',
          onClick: () => copy(code),
          'aria-label': 'Copy code',
          className: 'text-muted-foreground transition-colors hover:text-foreground',
        },
        h(Icon, { size: ICON_SIZE, 'aria-hidden': 'true' }),
        h('span', { className: 'sr-only', 'aria-live': 'polite' }, copied ? 'Copied' : ''),
      ),
    ),
    h(
      'pre',
      { className: 'overflow-x-auto bg-card p-3' },
      h('code', { className: 'font-mono text-copy-sm leading-relaxed whitespace-pre' }, code),
    ),
  );
}

/** Render a single block token to a React element. */
function renderBlock(token, key) {
  switch (token.type) {
    case 'heading':
      return h(Heading, { key, level: token.level, text: token.text });
    case 'code':
      return h(CodeBlock, { key, lang: token.lang, code: token.code });
    case 'list':
      return h(List, { key, ordered: token.ordered, items: token.items });
    case 'table':
      return h(Table, { key, header: token.header, rows: token.rows });
    case 'blockquote':
      return h(
        'blockquote',
        {
          key,
          className:
            'border-l-2 border-primary bg-muted/40 pl-3 py-1 my-2 text-muted-foreground',
        },
        inline(token.text),
      );
    case 'hr':
      return h('hr', { key, className: 'my-4 border-border' });
    case 'paragraph':
      return h(
        'p',
        {
          key,
          className: 'leading-relaxed text-foreground my-2 whitespace-pre-wrap break-words',
        },
        inline(token.text),
      );
    default:
      return null;
  }
}

/**
 * Render a markdown string as React nodes. Parses block structure with
 * `parseMarkdown`, then renders each block (with inline formatting inside
 * paragraph/heading/list-item/table-cell text). Builds real React nodes —
 * never uses `dangerouslySetInnerHTML` — so raw HTML shows as literal text.
 *
 * @param {object} props
 * @param {string} props.children - The markdown source to render.
 * @param {string} [props.className] - Optional wrapper class names.
 * @returns {JSX.Element} The rendered markdown.
 */
export default function Markdown({ children, className }) {
  // Tokenizing is O(n) over the source; re-run only when the source changes.
  const tokens = useMemo(() => parseMarkdown(children), [children]);
  return h(
    'div',
    { className },
    tokens.map((token, idx) => renderBlock(token, idx)),
  );
}
