import { useMemo, useState, useDeferredValue } from 'react';
import type { ReactElement } from 'react';
import type { IconProps } from '@stevederico/skateboard-ui/icons';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import Sparkles from '@stevederico/skateboard-ui/icons/Sparkles';
import Brain from '@stevederico/skateboard-ui/icons/Brain';
import Wrench from '@stevederico/skateboard-ui/icons/Wrench';
import Terminal from '@stevederico/skateboard-ui/icons/Terminal';
import FileText from '@stevederico/skateboard-ui/icons/FileText';
import FilePen from '@stevederico/skateboard-ui/icons/FilePen';
import Search from '@stevederico/skateboard-ui/icons/Search';
import Bot from '@stevederico/skateboard-ui/icons/Bot';
import Globe from '@stevederico/skateboard-ui/icons/Globe';
import ChevronRight from '@stevederico/skateboard-ui/icons/ChevronRight';
import Check from '@stevederico/skateboard-ui/icons/Check';
import Copy from '@stevederico/skateboard-ui/icons/Copy';
import X from '@stevederico/skateboard-ui/icons/X';
import Markdown from '../lib/markdownRender';
import { formatDate, shortModel, formatTokens } from '../lib/format';
import { useCopy } from '../lib/useCopy';
import { stripCommandTags } from '../lib/markdown';

const ICON_SIZE = 16;
const SMALL_ICON_SIZE = 14;
const PREVIEW_MAX = 48;
const RESULT_MAX = 6000;

/** An icon component from the skateboard-ui icon set. */
type IconComponent = (props: IconProps) => ReactElement;

/** A paired tool call: its input plus the result that came back. */
interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: string | null;
  isError: boolean;
}

/** One renderable item inside an assistant turn: prose text or a tool call. */
type AssistantItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolCall };

/** Token-usage block from an assistant record. */
interface Usage {
  output_tokens?: number;
}

/** A derived chat message ready to render in the transcript. */
type Message =
  | { role: 'system'; text: string; timestamp?: string }
  | { role: 'user'; text: string; timestamp?: string }
  | {
      role: 'assistant';
      thinking: string;
      items: AssistantItem[];
      model: string;
      usage: Usage | null;
      timestamp?: string;
    };

/** A raw transcript record (claude JSONL or grok-normalized; shapes vary by `type`). */
interface RawRecord {
  type?: string;
  timestamp?: string;
  content?: unknown;
  message?: {
    content?: unknown;
    model?: string;
    usage?: Usage | null;
  };
}

/** One content block inside a message (shape varies by agent / version). */
interface ContentBlock {
  type?: string;
  thinking?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

function isContentBlock(v: unknown): v is ContentBlock {
  return typeof v === 'object' && v !== null;
}

function isRawRecord(v: unknown): v is RawRecord {
  return typeof v === 'object' && v !== null;
}

function contentBlocks(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? content.filter(isContentBlock) : [];
}

/** Session metadata passed alongside the records (not required for layout). */
type TranscriptMeta = object;

// Tool name -> icon. Names not listed fall back to a generic wrench.
// Includes claude and grok tool names / variants.
const TOOL_ICONS: Record<string, IconComponent> = {
  Bash: Terminal,
  Read: FileText,
  Edit: FilePen,
  Write: FilePen,
  Grep: Search,
  Glob: Search,
  Task: Bot,
  WebFetch: Globe,
  WebSearch: Globe,
  run_terminal_command: Terminal,
  read_file: FileText,
  search_replace: FilePen,
  list_dir: FileText,
  grep: Search,
  web_search: Globe,
  web_fetch: Globe,
  open_page: Globe,
  CursorWrite: FilePen,
  CursorRead: FileText,
};

// Input keys (in priority order) that make a good one-line tool preview.
const PREVIEW_KEYS = ['command', 'query', 'url', 'path', 'file_path', 'pattern', 'name'];

/** Coerce arbitrary tool-result/text content into a printable string. */
function stringifyContent(content: unknown): string {
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
function toolPreview(input: Record<string, unknown> | null | undefined): string {
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
function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  return /```|~~~|^#{1,6}\s+\S|\[[^\]]+\]\([^)\s]+\)|\|\s*:?-{2,}/m.test(text);
}

/**
 * Walk normalized transcript records into an ordered list of chat messages,
 * pairing each `tool_use` block with the `tool_result` that carries its output
 * so input + result render in a single pill.
 *
 * Claude records arrive as-is; grok sessions are normalized by the
 * indexer into the same shape. Individual content blocks are read via a loose
 * {@link ContentBlock} shape while the returned {@link Message} list is strongly typed.
 *
 * @param records - Raw records, in chronological order.
 * @returns Ordered, ready-to-render chat messages.
 */
function deriveMessages(records: unknown[]): Message[] {
  const messages: Message[] = [];
  const toolsById = new Map<string, ToolCall>();

  for (const raw of Array.isArray(records) ? records : []) {
    if (!isRawRecord(raw)) continue;
    const record = raw;
    const type = record?.type;

    if (type === 'assistant') {
      const blocks = contentBlocks(record?.message?.content);
      const thinkingParts: string[] = [];
      const items: AssistantItem[] = [];

      for (const block of blocks) {
        if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
          const text = block.thinking ?? block.text ?? '';
          if (text) thinkingParts.push(text);
        } else if (block?.type === 'text') {
          if (block.text) items.push({ kind: 'text', text: block.text });
        } else if (block?.type === 'tool_use') {
          const tool: ToolCall = {
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
        const text = stripCommandTags(content);
        if (text.trim()) {
          messages.push({ role: 'user', text, timestamp: record?.timestamp });
        }
        continue;
      }

      // Array content carries tool results (attach, no user turn) plus any
      // stray text blocks (which DO count as a user message).
      const blocks = contentBlocks(content);
      const userTextParts: string[] = [];

      for (const block of blocks) {
        if (block?.type === 'tool_result') {
          const resultText = stringifyContent(block.content);
          const existing = block.tool_use_id ? toolsById.get(block.tool_use_id) : null;
          if (existing) {
            existing.result = resultText;
            existing.isError = Boolean(block.is_error);
          } else {
            // Orphaned result — surface it via a synthetic tool so nothing is lost.
            const synthetic: Message = {
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

      const userText = stripCommandTags(userTextParts.join('\n\n'));
      if (userText.trim()) {
        messages.push({
          role: 'user',
          text: userText,
          timestamp: record?.timestamp,
        });
      }
      continue;
    }

    if (type === 'system') {
      const text =
        typeof record?.content === 'string' ? record.content : stringifyContent(record?.content);
      const cleanText = stripCommandTags(text);
      if (cleanText && cleanText.trim()) {
        messages.push({ role: 'system', text: cleanText, timestamp: record?.timestamp });
      }
      continue;
    }
    // 'summary' and unknown types are skipped.
  }

  return messages;
}

/** Centered, muted system notice. */
function MessageSystem({ text }: { text: string }) {
  return (
    <div className="px-4 text-center text-xs italic text-muted-foreground [content-visibility:auto] [contain-intrinsic-size:auto_32px]">
      {text}
    </div>
  );
}

/** Right-aligned user prompt bubble with a timestamp beneath it. */
function MessageUser({ text, timestamp }: { text: string; timestamp?: string }) {
  return (
    <div className="flex flex-col items-end gap-1.5 [content-visibility:auto] [contain-intrinsic-size:auto_80px]">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3.5 py-2.5 text-sm leading-relaxed text-foreground sm:max-w-[36rem]">
        <Markdown className="break-words text-sm leading-relaxed">{text}</Markdown>
      </div>
      {timestamp ? (
        <span className="px-1 text-xs text-muted-foreground">{formatDate(timestamp)}</span>
      ) : null}
    </div>
  );
}

/** Collapsed-by-default disclosure for the assistant's thinking trace. */
function ThinkingDisclosure({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-fit items-center gap-1.5 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-muted-foreground motion-safe:animate-in motion-safe:fade-in">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** Expandable capsule showing one tool call's input and (when present) result. */
function ToolPill({ tool }: { tool: ToolCall }) {
  const { name, input, result, isError } = tool;
  const [open, setOpen] = useState(isError);
  const ToolIcon = TOOL_ICONS[name] ?? Wrench;
  const label = String(name).replace(/_/g, ' ');
  const preview = toolPreview(input);
  const hasResult = result != null && result !== '';
  const resultText = !hasResult || result == null
    ? ''
    : result.length > RESULT_MAX
      ? `${result.slice(0, RESULT_MAX)}\n… (truncated)`
      : result;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <ToolIcon size={ICON_SIZE} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {preview ? (
          <span className="truncate font-mono text-xs text-muted-foreground">{preview}</span>
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
          <div className="text-xs font-medium text-muted-foreground">Input</div>
          <pre className="overflow-x-auto rounded bg-muted/50 p-2 font-mono text-xs leading-relaxed text-foreground">
            <code>{JSON.stringify(input ?? {}, null, 2)}</code>
          </pre>

          {hasResult ? (
            <>
              <div
                className={cn(
                  'text-xs font-medium',
                  isError ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                Result
              </div>
              {!isError && looksLikeMarkdown(resultText) ? (
                <div className="max-h-72 overflow-y-auto rounded bg-muted/50 p-2 text-sm">
                  <Markdown>{resultText}</Markdown>
                </div>
              ) : (
                <pre
                  className={cn(
                    'max-h-72 overflow-y-auto rounded bg-muted/50 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words',
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
function AssistantActions({ text, model, usage }: { text: string; model: string; usage: Usage | null }) {
  const { copied, copy } = useCopy();
  const CopyIcon = copied ? Check : Copy;
  const tokens = usage?.output_tokens;

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => copy(text)}
        aria-label="Copy message"
        className={cn(
          'flex items-center gap-1 rounded p-1 transition-opacity transition-colors',
          // Show on message hover/focus; stay visible while "Copied" feedback is up.
          'opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100',
          'focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          'hover:text-foreground',
          copied && 'opacity-100 text-success',
        )}
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

/** The assistant variant of {@link Message}. */
type AssistantMessage = Extract<Message, { role: 'assistant' }>;

/** Full-width, no-bubble assistant turn: identity, thinking, content, actions. */
function MessageAssistant({ message }: { message: AssistantMessage }) {
  const { thinking, items, model, usage, timestamp } = message;
  const assistantText = items
    .filter((item): item is Extract<AssistantItem, { kind: 'text' }> => item.kind === 'text')
    .map((item) => item.text)
    .join('\n\n');

  return (
    <div className="group/message flex flex-col gap-2.5 [content-visibility:auto] [contain-intrinsic-size:auto_400px]">
      <div className="flex items-center gap-2 text-xs">
        <Sparkles size={ICON_SIZE} aria-hidden="true" className="text-app" />
        <span className="font-medium text-foreground">Assistant</span>
        {model ? (
          <span className="text-muted-foreground">{shortModel(model)}</span>
        ) : null}
        {timestamp ? (
          <span className="ml-auto text-muted-foreground">{formatDate(timestamp)}</span>
        ) : null}
      </div>

      {thinking ? <ThinkingDisclosure text={thinking} /> : null}

      <div className="flex flex-col gap-2 text-sm leading-relaxed">
        {items.map((item, i) =>
          item.kind === 'text' ? (
            <Markdown key={i}>{item.text}</Markdown>
          ) : (
            <ToolPill key={item.tool.id ?? i} tool={item.tool} />
          ),
        )}
      </div>

      {assistantText || model || Number(usage?.output_tokens) > 0 ? (
        <AssistantActions text={assistantText} model={model} usage={usage} />
      ) : null}
    </div>
  );
}

/** Props for {@link Transcript}. */
interface TranscriptProps {
  /** Normalized transcript records, in order. */
  records: unknown[];
  /** Session metadata (not required for layout). */
  meta?: TranscriptMeta;
}

/**
 * Read-only chat-style renderer for a local agent session transcript.
 * Derives a message model from normalized records (pairing tool calls with
 * their results) and renders it as an editorial, single-column conversation —
 * right-aligned user bubbles, full-width assistant turns, collapsible thinking,
 * and expandable tool pills. Does no fetching; the parent owns loading / error
 * / empty states above this component.
 *
 * @returns The transcript, or null when there are no records.
 */
export default function Transcript({ records, meta }: TranscriptProps) {
  void meta; // accepted for a stable caller signature; layout needs only records
  // Derive once per records change — deriveMessages walks every record and the
  // children re-parse markdown, so re-running it on unrelated re-renders (search
  // typing, scroll) freezes large sessions.
  const messages = useMemo(
    () => (Array.isArray(records) ? deriveMessages(records) : []),
    [records],
  );
  // Defer the (potentially huge) message list so urgent updates (search typing,
  // scroll) stay responsive while the heavy transcript re-renders in the background.
  const deferredMessages = useDeferredValue(messages);
  if (deferredMessages.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 text-sm leading-relaxed selection:bg-app/20 sm:px-6">
      {deferredMessages.map((message, i) => {
        if (message.role === 'system') return <MessageSystem key={i} text={message.text} />;
        if (message.role === 'user')
          return <MessageUser key={i} text={message.text} timestamp={message.timestamp} />;
        return <MessageAssistant key={i} message={message} />;
      })}
    </div>
  );
}
