import { useMemo, useState } from 'react';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import {
  Sparkles,
  Brain,
  Wrench,
  Terminal,
  FileText,
  FilePen,
  Search,
  Bot,
  Globe,
  ChevronRight,
  Check,
  Copy,
  X,
} from '@stevederico/skateboard-ui/icons';
import Markdown from '../lib/markdownRender.js';
import { formatDate, shortModel, formatTokens } from '../lib/format.js';
import { useCopy } from '../lib/useCopy.js';

const ICON_SIZE = 16;
const SMALL_ICON_SIZE = 14;
const PREVIEW_MAX = 48;
const RESULT_MAX = 6000;

// Tool name -> icon. Names not listed fall back to a generic wrench.
const TOOL_ICONS = {
  Bash: Terminal,
  Read: FileText,
  Edit: FilePen,
  Write: FilePen,
  Grep: Search,
  Glob: Search,
  Task: Bot,
  WebFetch: Globe,
  WebSearch: Globe,
};

// Input keys (in priority order) that make a good one-line tool preview.
const PREVIEW_KEYS = ['command', 'query', 'url', 'path', 'file_path', 'pattern', 'name'];

/** Coerce arbitrary tool-result/text content into a printable string. */
function stringifyContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text ?? '';
        return JSON.stringify(part, null, 2);
      })
      .join('\n');
  }
  return JSON.stringify(content, null, 2);
}

/** Pick a short, single-line preview string from a tool's input object. */
function toolPreview(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of PREVIEW_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      const flat = value.replace(/\s+/g, ' ').trim();
      return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
    }
  }
  return '';
}

/**
 * True when a result string looks like markdown worth rich-rendering.
 *
 * Requires a *strong* signal — a fenced code block, a heading, a markdown
 * link, or a GFM table separator. Bare `- `/`> `/`1. ` lines are deliberately
 * excluded: they fire constantly on plain logs, diffs, and ASCII trees, and
 * rich-rendering those mangles whitespace-significant output. The plain-text
 * fallback (a `<pre>`) already renders non-markdown results cleanly, so a false
 * negative here is harmless while a false positive corrupts the output.
 */
function looksLikeMarkdown(text) {
  if (!text) return false;
  return /```|~~~|^#{1,6}\s+\S|\[[^\]]+\]\([^)\s]+\)|\|\s*:?-{2,}/m.test(text);
}

/**
 * Walk raw Claude Code JSONL records into an ordered list of chat messages,
 * pairing each `tool_use` block with the `tool_result` that carries its output
 * so input + result render in a single pill (mirroring Claude / ChatGPT).
 *
 * @param {Array<object>} records - Raw records, in chronological order.
 * @returns {Array<object>} Ordered messages:
 *   `{ role:'system', text, timestamp }`,
 *   `{ role:'user', text, timestamp }`,
 *   `{ role:'assistant', thinking, items:[{kind:'text',text}|{kind:'tool',tool}],
 *      model, usage, timestamp }`.
 *   Each tool item's `tool` is `{ id, name, input, result, isError }`.
 */
function deriveMessages(records) {
  const messages = [];
  const toolsById = new Map();

  for (const record of Array.isArray(records) ? records : []) {
    const type = record?.type;

    if (type === 'assistant') {
      const blocks = Array.isArray(record?.message?.content) ? record.message.content : [];
      const thinkingParts = [];
      const items = [];

      for (const block of blocks) {
        if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
          const text = block.thinking ?? block.text ?? '';
          if (text) thinkingParts.push(text);
        } else if (block?.type === 'text') {
          if (block.text) items.push({ kind: 'text', text: block.text });
        } else if (block?.type === 'tool_use') {
          const tool = {
            id: block.id ?? `tool-${items.length}`,
            name: block.name ?? 'tool',
            input: block.input ?? {},
            result: null,
            isError: false,
          };
          items.push({ kind: 'tool', tool });
          if (block.id) toolsById.set(block.id, tool);
        }
      }

      messages.push({
        role: 'assistant',
        thinking: thinkingParts.join('\n\n'),
        items,
        model: record?.message?.model ?? '',
        usage: record?.message?.usage ?? null,
        timestamp: record?.timestamp,
      });
      continue;
    }

    if (type === 'user') {
      const content = record?.message?.content;

      if (typeof content === 'string') {
        if (content.trim()) {
          messages.push({ role: 'user', text: content, timestamp: record?.timestamp });
        }
        continue;
      }

      // Array content carries tool results (attach, no user turn) plus any
      // stray text blocks (which DO count as a user message).
      const blocks = Array.isArray(content) ? content : [];
      const userTextParts = [];

      for (const block of blocks) {
        if (block?.type === 'tool_result') {
          const resultText = stringifyContent(block.content);
          const existing = block.tool_use_id ? toolsById.get(block.tool_use_id) : null;
          if (existing) {
            existing.result = resultText;
            existing.isError = Boolean(block.is_error);
          } else {
            // Orphaned result — surface it via a synthetic tool so nothing is lost.
            const synthetic = {
              role: 'assistant',
              thinking: '',
              items: [
                {
                  kind: 'tool',
                  tool: {
                    id: block.tool_use_id ?? 'orphan',
                    name: 'tool_result',
                    input: {},
                    result: resultText,
                    isError: Boolean(block.is_error),
                  },
                },
              ],
              model: '',
              usage: null,
              timestamp: record?.timestamp,
            };
            messages.push(synthetic);
          }
        } else if (block?.type === 'text' && block.text) {
          userTextParts.push(block.text);
        }
      }

      if (userTextParts.length) {
        messages.push({
          role: 'user',
          text: userTextParts.join('\n\n'),
          timestamp: record?.timestamp,
        });
      }
      continue;
    }

    if (type === 'system') {
      const text =
        typeof record?.content === 'string' ? record.content : stringifyContent(record?.content);
      if (text && text.trim()) {
        messages.push({ role: 'system', text, timestamp: record?.timestamp });
      }
      continue;
    }
    // 'summary' and unknown types are skipped.
  }

  return messages;
}

/** Centered, muted system notice. */
function MessageSystem({ text }) {
  return (
    <div className="px-4 text-center text-copy-sm italic text-muted-foreground">{text}</div>
  );
}

/** Right-aligned user prompt bubble with a timestamp beneath it. */
function MessageUser({ text, timestamp }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 leading-relaxed text-foreground sm:max-w-[36rem]">
        <Markdown className="break-words">{text}</Markdown>
      </div>
      {timestamp ? (
        <span className="px-1 text-copy-sm text-muted-foreground">{formatDate(timestamp)}</span>
      ) : null}
    </div>
  );
}

/** Collapsed-by-default disclosure for the assistant's thinking trace. */
function ThinkingDisclosure({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-fit items-center gap-1.5 rounded text-copy-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Brain size={SMALL_ICON_SIZE} aria-hidden="true" />
        <span>Thinking</span>
        <ChevronRight
          size={SMALL_ICON_SIZE}
          aria-hidden="true"
          className={cn('transition-transform motion-safe:duration-200', open && 'rotate-90')}
        />
      </button>
      {open ? (
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/50 p-3 font-mono text-copy-sm leading-relaxed text-muted-foreground motion-safe:animate-in motion-safe:fade-in">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** Expandable capsule showing one tool call's input and (when present) result. */
function ToolPill({ tool }) {
  const { name, input, result, isError } = tool;
  const [open, setOpen] = useState(isError);
  const ToolIcon = TOOL_ICONS[name] ?? Wrench;
  const label = String(name).replace(/_/g, ' ');
  const preview = toolPreview(input);
  const hasResult = result != null && result !== '';
  const resultText = hasResult
    ? result.length > RESULT_MAX
      ? `${result.slice(0, RESULT_MAX)}\n… (truncated)`
      : result
    : '';

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <ToolIcon size={ICON_SIZE} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-copy-md text-foreground">{label}</span>
        {preview ? (
          <span className="truncate font-mono text-copy-sm text-muted-foreground">{preview}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {isError ? (
            <X size={SMALL_ICON_SIZE} aria-label="Error" className="text-destructive" />
          ) : hasResult ? (
            <Check size={SMALL_ICON_SIZE} aria-label="Completed" className="text-success" />
          ) : null}
          <ChevronRight
            size={SMALL_ICON_SIZE}
            aria-hidden="true"
            className={cn(
              'text-muted-foreground transition-transform motion-safe:duration-200',
              open && 'rotate-90',
            )}
          />
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-border p-3 motion-safe:animate-in motion-safe:fade-in">
          <div className="text-label-sm text-muted-foreground">Input</div>
          <pre className="overflow-x-auto rounded bg-muted/50 p-2 font-mono text-copy-sm leading-relaxed text-foreground">
            <code>{JSON.stringify(input ?? {}, null, 2)}</code>
          </pre>

          {hasResult ? (
            <>
              <div className={cn('text-label-sm', isError ? 'text-destructive' : 'text-muted-foreground')}>
                Result
              </div>
              {!isError && looksLikeMarkdown(resultText) ? (
                <div className="max-h-72 overflow-y-auto rounded bg-muted/50 p-2">
                  <Markdown>{resultText}</Markdown>
                </div>
              ) : (
                <pre
                  className={cn(
                    'max-h-72 overflow-y-auto rounded bg-muted/50 p-2 font-mono text-copy-sm leading-relaxed whitespace-pre-wrap break-words',
                    isError ? 'text-destructive' : 'text-foreground',
                  )}
                >
                  <code>{resultText}</code>
                </pre>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Muted action row beneath an assistant message: copy + model/token meta. */
function AssistantActions({ text, model, usage }) {
  const { copied, copy } = useCopy();
  const CopyIcon = copied ? Check : Copy;
  const tokens = usage?.output_tokens;

  return (
    <div className="flex items-center gap-3 text-copy-sm text-muted-foreground">
      <button
        type="button"
        onClick={() => copy(text)}
        aria-label="Copy message"
        className="flex items-center gap-1 rounded p-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <CopyIcon
          size={SMALL_ICON_SIZE}
          aria-hidden="true"
          className={copied ? 'text-success' : undefined}
        />
        <span className="sr-only" aria-live="polite">
          {copied ? 'Copied' : ''}
        </span>
      </button>
      {model ? <span>{shortModel(model)}</span> : null}
      {Number(tokens) > 0 ? <span>{formatTokens(tokens)} tokens</span> : null}
    </div>
  );
}

/** Full-width, no-bubble assistant turn: identity, thinking, content, actions. */
function MessageAssistant({ message }) {
  const { thinking, items, model, usage, timestamp } = message;
  const assistantText = items
    .filter((item) => item.kind === 'text')
    .map((item) => item.text)
    .join('\n\n');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Sparkles size={ICON_SIZE} aria-hidden="true" className="text-app" />
        <span className="text-label-sm text-foreground">Claude</span>
        {model ? (
          <span className="text-copy-sm text-muted-foreground">{shortModel(model)}</span>
        ) : null}
        {timestamp ? (
          <span className="ml-auto text-copy-sm text-muted-foreground">{formatDate(timestamp)}</span>
        ) : null}
      </div>

      {thinking ? <ThinkingDisclosure text={thinking} /> : null}

      {items.map((item, i) =>
        item.kind === 'text' ? (
          <Markdown key={i}>{item.text}</Markdown>
        ) : (
          <ToolPill key={item.tool.id ?? i} tool={item.tool} />
        ),
      )}

      {assistantText || model || Number(usage?.output_tokens) > 0 ? (
        <AssistantActions text={assistantText} model={model} usage={usage} />
      ) : null}
    </div>
  );
}

/**
 * Read-only chat-style renderer for a Claude Code session transcript.
 * Derives a message model from raw JSONL records (pairing tool calls with
 * their results) and renders it as an editorial, single-column conversation —
 * right-aligned user bubbles, full-width assistant turns, collapsible thinking,
 * and expandable tool pills. Does no fetching; the parent owns loading / error
 * / empty states above this component.
 *
 * @param {object} props
 * @param {Array<object>} props.records - Raw Claude Code records, in order.
 * @param {object} [props.meta] - Session metadata (not required for layout).
 * @returns {JSX.Element|null} The transcript, or null when there are no records.
 */
export default function Transcript({ records, meta }) {
  void meta; // accepted for a stable caller signature; layout needs only records
  // Derive once per records change — deriveMessages walks every record and the
  // children re-parse markdown, so re-running it on unrelated re-renders (search
  // typing, scroll) freezes large sessions.
  const messages = useMemo(
    () => (Array.isArray(records) ? deriveMessages(records) : []),
    [records],
  );
  if (messages.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-4 selection:bg-app/20">
      {messages.map((message, i) => {
        if (message.role === 'system') return <MessageSystem key={i} text={message.text} />;
        if (message.role === 'user')
          return <MessageUser key={i} text={message.text} timestamp={message.timestamp} />;
        return <MessageAssistant key={i} message={message} />;
      })}
    </div>
  );
}
