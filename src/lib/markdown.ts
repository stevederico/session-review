/**
 * Pure markdown tokenizer for chat transcript prose.
 *
 * Contains no React/JSX and imports nothing, so it loads directly under
 * `node --test` and `node --check`. The React renderer lives in
 * `markdownRender` (also JSX-free — it builds nodes with
 * `React.createElement`) and imports `parseMarkdown` from here.
 * This file ALSO exports the pure inline tokenizer `parseInline`, used by the
 * renderer to turn inline markdown into tokens it then maps to React nodes.
 * No external dependencies.
 */

/** A single inline-level token produced by {@link parseInline}. */
export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: InlineToken[] }
  | { type: 'em'; children: InlineToken[] }
  | { type: 'del'; children: InlineToken[] }
  | { type: 'link'; href: string; children: InlineToken[] }
  | { type: 'autolink'; href: string };

/** One item in a list block; `children` is a nested sub-list, or null. */
export interface ListItem {
  /** The item's inline source text. */
  text: string;
  /** Task-list state: true/false for `[x]`/`[ ]`, or null for a plain item. */
  checked: boolean | null;
  /** Nested sub-list token, or null when the item has none. */
  children: ListBlock | null;
}

/** A list block (`<ul>`/`<ol>`), ordered or not, with its items. */
export interface ListBlock {
  type: 'list';
  ordered: boolean;
  items: ListItem[];
}

/** A single block-level token produced by {@link parseMarkdown}. */
export type BlockToken =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; code: string }
  | ListBlock
  | { type: 'blockquote'; text: string }
  | { type: 'hr' }
  | { type: 'table'; header: string[]; rows: string[][] };

// --- block-level regexes -----------------------------------------------------
const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^\n]*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;
const ORDERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const UNORDERED_RE = /^(\s*)[-*+]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

// --- inline-level regexes (ported from the former renderer INLINE_RULES) -----
// Sticky; matched at the current scan position. Order mirrors historical priority.
const STRONG_RE = /\*\*([^*]+)\*\*/y;
const DEL_RE = /~~([^~]+)~~/y;
const STAR_EM_RE = /\*([^*]+)\*/y;
const US_EM_RE = /\b_([^_]+)_\b/y; // underscore italics; word-boundary avoids snake_case
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/y;
const AUTOLINK_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/y;

/** True when a line is part of a GFM table (has at least one unescaped pipe). */
function isTableRow(line: string): boolean {
  return /\|/.test(line) && /\S/.test(line);
}

/** Split a single GFM table row into trimmed cells, dropping edge pipes. */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  // Drop empty leading/trailing cells produced by edge pipes.
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** True when a split table header row has at least one non-empty cell. */
function hasTableHeaderCells(line: string): boolean {
  return splitTableRow(line).some((cell) => cell !== '');
}

/** A line classified as a list item, with its marker kind and indent width. */
interface ListItemMatch {
  ordered: boolean;
  indent: number;
  content: string;
}

/**
 * Classify a line as a list item, capturing its leading-indent width.
 * @param line - The source line to classify.
 * @returns The match, or null when the line is not a list item.
 */
function matchListItem(line: string): ListItemMatch | null {
  const ordered = ORDERED_RE.exec(line);
  if (ordered) return { ordered: true, indent: ordered[1].length, content: ordered[3] };
  const unordered = UNORDERED_RE.exec(line);
  if (unordered) return { ordered: false, indent: unordered[1].length, content: unordered[2] };
  return null;
}

/** Build a list item token, detecting `[ ]` / `[x]` tasks; children set later by the parser. */
function makeListItem(content: string): ListItem {
  const task = TASK_RE.exec(content);
  if (task) {
    return { text: task[2], checked: task[1].toLowerCase() === 'x', children: null };
  }
  return { text: content, checked: null, children: null };
}

/**
 * Find an inline code span starting at `pos` (where `src[pos] === '`'`).
 * CommonMark code-span rule: an opening run of N backticks is closed by the
 * NEXT run of EXACTLY N backticks; runs of fewer/more backticks inside are
 * literal content. If the content both begins and ends with a space and is not
 * all whitespace, exactly one leading and one trailing space are stripped.
 *
 * @param src - Full inline source.
 * @param pos - Index of the first backtick of the opening run.
 * @returns `value` is the code text and `end` is the index just past the
 *   closing run; `null` when no closing run of exactly N backticks exists
 *   (caller treats the opening run as literal text).
 */
function matchCodeSpan(src: string, pos: number): { value: string; end: number } | null {
  let openLen = 0;
  while (src[pos + openLen] === '`') openLen++;
  const contentStart = pos + openLen;

  let i = contentStart;
  while (i < src.length) {
    if (src[i] === '`') {
      let runLen = 0;
      while (src[i + runLen] === '`') runLen++;
      if (runLen === openLen) {
        let value = src.slice(contentStart, i);
        // Strip one leading + one trailing space iff both present and content
        // is not entirely whitespace (CommonMark code-span trimming).
        if (
          value.length >= 2 &&
          value[0] === ' ' &&
          value[value.length - 1] === ' ' &&
          value.trim() !== ''
        ) {
          value = value.slice(1, -1);
        }
        return { value, end: i + runLen };
      }
      i += runLen; // shorter/longer run: skip the whole run as content, keep scanning
      continue;
    }
    i++;
  }
  return null; // unterminated -> caller emits the backtick run as literal text
}

/**
 * Try every emphasis/link/autolink rule (sticky, anchored at `pos`), returning
 * the FIRST that matches exactly at `pos` in historical priority order:
 * strong > del > *em* > _em_ > link > autolink. Container tokens recurse via
 * `parseInline` for their children.
 *
 * @param src - Full inline source.
 * @param pos - Current scan position.
 * @returns The matched token plus the index just past it, or null.
 */
function matchInlineRule(src: string, pos: number): { token: InlineToken; end: number } | null {
  // NOTE: these emphasis/link regexes are module-level sticky (/y) and shared.
  // The recursive parseInline(m[1]) below re-runs them on the child text, which
  // mutates their `lastIndex`. So capture `end` into a local BEFORE recursing —
  // reading `RE.lastIndex` after the recursive call would see the child's
  // (often 0) value, leaving `pos` stuck and looping forever.
  STRONG_RE.lastIndex = pos;
  let m = STRONG_RE.exec(src);
  if (m && m.index === pos) {
    const end = STRONG_RE.lastIndex;
    return { token: { type: 'strong', children: parseInline(m[1]) }, end };
  }
  DEL_RE.lastIndex = pos;
  m = DEL_RE.exec(src);
  if (m && m.index === pos) {
    const end = DEL_RE.lastIndex;
    return { token: { type: 'del', children: parseInline(m[1]) }, end };
  }
  STAR_EM_RE.lastIndex = pos;
  m = STAR_EM_RE.exec(src);
  if (m && m.index === pos) {
    const end = STAR_EM_RE.lastIndex;
    return { token: { type: 'em', children: parseInline(m[1]) }, end };
  }
  US_EM_RE.lastIndex = pos;
  m = US_EM_RE.exec(src);
  if (m && m.index === pos) {
    const end = US_EM_RE.lastIndex;
    return { token: { type: 'em', children: parseInline(m[1]) }, end };
  }
  LINK_RE.lastIndex = pos;
  m = LINK_RE.exec(src);
  if (m && m.index === pos) {
    const end = LINK_RE.lastIndex;
    return { token: { type: 'link', href: m[2], children: parseInline(m[1]) }, end };
  }
  AUTOLINK_RE.lastIndex = pos;
  m = AUTOLINK_RE.exec(src);
  if (m && m.index === pos) {
    return { token: { type: 'autolink', href: m[1] }, end: AUTOLINK_RE.lastIndex };
  }
  return null;
}

/**
 * Tokenize inline markdown into a flat array of inline tokens. Pure (no React)
 * so it is unit-testable under `node --test`. Adjacent plain characters coalesce
 * into one `{type:'text'}` token. Inline code is highest priority and is never
 * re-parsed; container tokens (strong/em/del/link) carry parsed `children`.
 *
 * @param text - Inline markdown source.
 * @returns Inline tokens (see {@link InlineToken} for shapes).
 */
export function parseInline(text: string | null | undefined): InlineToken[] {
  const src = String(text ?? '');
  const tokens: InlineToken[] = [];
  let plain = '';
  let pos = 0;

  const flush = () => {
    if (plain) {
      tokens.push({ type: 'text', value: plain });
      plain = '';
    }
  };

  while (pos < src.length) {
    const ch = src[pos];

    // 1) Inline code (highest priority; contents not reparsed).
    if (ch === '`') {
      const span = matchCodeSpan(src, pos);
      if (span) {
        flush();
        tokens.push({ type: 'code', value: span.value });
        pos = span.end;
        continue;
      }
      // Unterminated: emit the entire backtick run as literal text, advance past it.
      let run = 0;
      while (src[pos + run] === '`') run++;
      plain += src.slice(pos, pos + run);
      pos += run;
      continue;
    }

    // 2) Emphasis / link / autolink, first match at this position wins.
    const hit = matchInlineRule(src, pos);
    if (hit) {
      flush();
      tokens.push(hit.token);
      pos = hit.end;
      continue;
    }

    // 3) Plain char.
    plain += ch;
    pos++;
  }

  flush();
  return tokens;
}

/**
 * Parse a (possibly nested) list beginning at `lines[start]`. Lines whose indent
 * equals `baseIndent` join this list; a line indented MORE than `baseIndent`
 * starts a nested sub-list attached to the previous item's `children` (its kind,
 * ordered or unordered, is independent of the parent). A blank line, a non-list
 * line, or a line indented LESS than `baseIndent` ends this level. A same-level
 * line whose marker kind differs ends this list (so `- a` then `1. b` stay two
 * separate sibling lists, matching the historical behavior). Always advances `i`,
 * so it cannot loop forever.
 *
 * @param lines - All source lines.
 * @param start - Index of the first item line at this level.
 * @param baseIndent - Indent width that defines THIS level.
 * @returns The list token and the index of the first line after the list at
 *   this level.
 */
function parseList(lines: string[], start: number, baseIndent: number): { list: ListBlock; next: number } {
  const first = matchListItem(lines[start]);
  const ordered = Boolean(first?.ordered);
  const items: ListItem[] = [];
  let i = start;
  let last: ListItem | null = null; // most recently pushed item, to host a nested child

  while (i < lines.length) {
    if (lines[i].trim() === '') break; // blank line ends the list
    const item = matchListItem(lines[i]);
    if (!item) break; // non-list line ends the list
    if (item.indent < baseIndent) break; // dedent past this level -> caller handles

    if (item.indent > baseIndent) {
      // Deeper indent: nested sub-list attached to the previous item.
      if (last) {
        const { list, next } = parseList(lines, i, item.indent);
        last.children = list;
        i = next;
        continue;
      }
      // No previous item (only at level start, which can't be deeper) -> fall through.
    }

    if (item.indent === baseIndent && item.ordered !== ordered) break; // kind switch ends list
    last = makeListItem(item.content);
    items.push(last);
    i++;
  }

  return { list: { type: 'list', ordered, items }, next: i };
}

/**
 * Strip Claude Code slash-command meta tags from raw message text.
 *
 * Transcripts embed XML-like markers (`<command-message>`, `<command-name>`,
 * `<command-args>`, `<local-command-caveat>`, `<local-command-stdout>`, …) that
 * are noise when reading a conversation. Remove the whole element (open tag,
 * content, close tag) for any `<command-*>` / `<local-command-*>` pair, then
 * drop any leftover unpaired tags and collapse the blank lines left behind.
 *
 * @param text - Raw message text.
 * @returns Text with command meta tags removed.
 */
export function stripCommandTags(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/<((?:local-)?command-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:local-)?command-[a-z-]+\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse a markdown source string into a flat array of block tokens.
 * Pure (no React) so it can be unit-tested. Never throws on malformed
 * input — anything unrecognized falls through to a paragraph.
 *
 * @param rawSrc - Raw markdown text.
 * @returns Flat array of block tokens (see {@link BlockToken} for shapes).
 */
export function parseMarkdown(rawSrc: string | null | undefined): BlockToken[] {
  const src = stripCommandTags(rawSrc);
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const tokens: BlockToken[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block — parse first so its contents are never reinterpreted.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const lang = fence[3].trim().split(/\s+/)[0] || '';
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = FENCE_RE.exec(lines[i]);
        if (close && close[2][0] === marker) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      tokens.push({ type: 'code', lang, code: body.join('\n') });
      continue;
    }

    // Blank line — skip.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Horizontal rule.
    if (HR_RE.test(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading) {
      tokens.push({
        type: 'heading',
        level: heading[1].length,
        text: heading[2].trim(),
      });
      i++;
      continue;
    }

    // GFM table — header row + `|---|` separator, with >=1 non-empty header cell.
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1]) &&
      hasTableHeaderCells(line)
    ) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      tokens.push({ type: 'table', header, rows });
      continue;
    }

    // Blockquote — consecutive `>` lines joined.
    if (BLOCKQUOTE_RE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i])) {
        quoted.push(BLOCKQUOTE_RE.exec(lines[i])?.[1] ?? '');
        i++;
      }
      tokens.push({ type: 'blockquote', text: quoted.join('\n').trim() });
      continue;
    }

    // List — indentation determines nesting depth.
    const firstItem = matchListItem(line);
    if (firstItem) {
      const { list, next } = parseList(lines, i, firstItem.indent);
      tokens.push(list);
      i = next;
      continue;
    }

    // Paragraph — consecutive non-blank lines that aren't another block.
    const para: string[] = [];
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === '') break;
      if (FENCE_RE.test(next) || HR_RE.test(next) || HEADING_RE.test(next)) break;
      if (BLOCKQUOTE_RE.test(next) || matchListItem(next)) break;
      if (
        isTableRow(next) &&
        i + 1 < lines.length &&
        TABLE_SEP_RE.test(lines[i + 1]) &&
        hasTableHeaderCells(next)
      ) break;
      para.push(next);
      i++;
    }
    tokens.push({ type: 'paragraph', text: para.join('\n') });
  }

  return tokens;
}
