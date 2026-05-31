import { useState } from 'react';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@stevederico/skateboard-ui/shadcn/ui/collapsible';
import {
  User,
  Sparkles,
  Brain,
  Wrench,
  ChevronRight,
  ChevronDown,
  TriangleAlert,
} from '@stevederico/skateboard-ui/icons';
import { formatDate, shortModel } from '../lib/format.js';

const ICON_SIZE = 16;

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

/**
 * Split text on triple-backtick fence lines into ordered segments.
 * Returns [{ type: 'code' | 'text', text }] preserving order.
 */
function splitFences(text) {
  const lines = String(text ?? '').split('\n');
  const segments = [];
  let buffer = [];
  let inFence = false;

  const flush = (type) => {
    if (buffer.length === 0) return;
    segments.push({ type, text: buffer.join('\n') });
    buffer = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      flush(inFence ? 'code' : 'text');
      inFence = !inFence;
      continue;
    }
    buffer.push(line);
  }
  flush(inFence ? 'code' : 'text');
  return segments;
}

/** Minimal markdown-ish renderer: fenced blocks become <pre>, rest is prose. */
function MarkdownText({ text }) {
  const segments = splitFences(text);
  return (
    <div className="flex flex-col gap-2">
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <pre
            key={i}
            className="overflow-x-auto rounded-md bg-muted p-3 text-copy-sm"
          >
            <code>{seg.text}</code>
          </pre>
        ) : (
          <div key={i} className="whitespace-pre-wrap text-copy-md">
            {seg.text}
          </div>
        ),
      )}
    </div>
  );
}

/** A collapsed-by-default disclosure with an icon label and chevron. */
function Disclosure({ icon, label, labelClassName, children }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex items-center gap-2 text-copy-sm text-muted-foreground',
          labelClassName,
        )}
      >
        <Chevron size={ICON_SIZE} />
        {icon}
        <span>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** A small role label with timestamp, used at the top of every turn. */
function TurnHeader({ icon, role, timestamp, extra }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>
        {icon}
        <span>{role}</span>
      </Badge>
      {extra}
      {timestamp ? (
        <span className="text-copy-sm text-muted-foreground">
          {formatDate(timestamp)}
        </span>
      ) : null}
    </div>
  );
}

/** Render a single user turn: typed prompt string or carried tool results. */
function UserTurn({ record }) {
  const content = record?.message?.content;
  return (
    <div className="flex flex-col gap-2">
      <TurnHeader
        icon={<User size={ICON_SIZE} />}
        role="You"
        timestamp={record.timestamp}
      />
      {typeof content === 'string' ? (
        <div className="whitespace-pre-wrap rounded-lg bg-muted p-4 text-copy-md">
          {content}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {(Array.isArray(content) ? content : []).map((block, i) => {
            if (block?.type === 'tool_result') {
              const isError = Boolean(block.is_error);
              return (
                <Disclosure
                  key={i}
                  icon={
                    isError ? (
                      <TriangleAlert size={ICON_SIZE} className="text-warning" />
                    ) : null
                  }
                  label="Tool result"
                  labelClassName={isError ? 'text-warning' : undefined}
                >
                  <pre className="overflow-x-auto rounded-md bg-muted p-3 text-copy-sm">
                    <code>{stringifyContent(block.content)}</code>
                  </pre>
                </Disclosure>
              );
            }
            if (block?.type === 'text') {
              return (
                <div
                  key={i}
                  className="whitespace-pre-wrap rounded-lg bg-muted p-4 text-copy-md"
                >
                  {block.text}
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

/** Render a single assistant turn: text, thinking, and tool-call blocks. */
function AssistantTurn({ record }) {
  const content = record?.message?.content;
  const model = record?.message?.model;
  const blocks = Array.isArray(content) ? content : [];
  return (
    <div className="flex flex-col gap-2">
      <TurnHeader
        icon={<Sparkles size={ICON_SIZE} />}
        role="Claude"
        timestamp={record.timestamp}
        extra={
          model ? (
            <Badge variant="secondary">{shortModel(model)}</Badge>
          ) : null
        }
      />
      <div className="flex flex-col gap-3">
        {blocks.map((block, i) => {
          if (block?.type === 'text') {
            return <MarkdownText key={i} text={block.text} />;
          }
          if (block?.type === 'thinking') {
            return (
              <Disclosure
                key={i}
                icon={<Brain size={ICON_SIZE} />}
                label="Thinking"
              >
                <div className="whitespace-pre-wrap text-copy-sm text-muted-foreground">
                  {block.thinking}
                </div>
              </Disclosure>
            );
          }
          if (block?.type === 'tool_use') {
            return (
              <Disclosure
                key={i}
                icon={<Wrench size={ICON_SIZE} />}
                label={block.name ?? 'tool'}
              >
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-copy-sm">
                  <code>{JSON.stringify(block.input ?? {}, null, 2)}</code>
                </pre>
              </Disclosure>
            );
          }
          if (block?.type === 'redacted_thinking') {
            return (
              <div key={i} className="text-copy-sm text-muted-foreground">
                [redacted thinking]
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

/** Render a system record as a small muted collapsible note. */
function SystemTurn({ record }) {
  const text =
    typeof record?.content === 'string'
      ? record.content
      : stringifyContent(record?.content);
  if (!text) return null;
  return (
    <Disclosure label="System">
      <div className="whitespace-pre-wrap text-copy-sm text-muted-foreground">
        {text}
      </div>
    </Disclosure>
  );
}

/**
 * Presentational transcript renderer for a Claude Code session.
 * Renders raw JSONL records in order as a vertical stack of turns.
 * Does no fetching; the parent owns loading/error/empty states.
 *
 * @param {object} props
 * @param {Array<object>} props.records - Raw Claude Code records, in order.
 * @param {object} [props.meta] - Session metadata (currently unused for layout).
 * @returns {JSX.Element|null} The transcript, or null when there are no records.
 */
export default function Transcript({ records }) {
  if (!Array.isArray(records) || records.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {records.map((record, i) => {
        const type = record?.type;
        if (type === 'user') return <UserTurn key={i} record={record} />;
        if (type === 'assistant')
          return <AssistantTurn key={i} record={record} />;
        if (type === 'system') return <SystemTurn key={i} record={record} />;
        // 'summary' and unknown types are ignored gracefully.
        return null;
      })}
    </div>
  );
}
