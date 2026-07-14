import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import Copy from '@stevederico/skateboard-ui/icons/Copy';
import Check from '@stevederico/skateboard-ui/icons/Check';
import Terminal from '@stevederico/skateboard-ui/icons/Terminal';
import { useCopy } from '../lib/useCopy';
import { resumeCommand } from '../lib/resume';

/** Icon size for the copy/terminal glyphs (matches the transcript action row). */
const ICON_SIZE = 14;

/** Props for the {@link ResumeKey} copy control. */
interface ResumeKeyProps {
  /** Session id (transcript UUID) to resume. */
  id: string | null | undefined;
  /**
   * Conversation's working directory; when present the copied command is
   * prefixed with `cd <cwd> &&` so it resumes from anywhere.
   */
  cwd?: string | null;
  /** Agent source (`claude` | `grok`); picks the resume binary. */
  source?: string | null;
  /** Layout variant (default `full`). */
  variant?: 'full' | 'compact';
  /**
   * When true (full variant only), wrap the command instead of truncating
   * so long resume lines stay fully visible (e.g. in the info modal).
   */
  wrap?: boolean;
  /** Extra classes for the root element. */
  className?: string;
}

/**
 * Surface the resume shell command for a session so the user can copy it and
 * pick the conversation back up in their terminal (`claude --resume` or
 * `grok --resume` depending on source).
 *
 * Two layouts:
 *   - `full`    — terminal glyph + the mono command + a copy button. For the
 *                 open conversation's detail header.
 *   - `compact` — an icon-only copy button (command shown via tooltip/aria-label).
 *                 For dense session-list rows where the full command won't fit.
 *
 * Copy feedback flashes a check + an `aria-live` "Copied" message via {@link useCopy}.
 *
 * @returns Null when no id is available.
 */
export default function ResumeKey({
  id,
  cwd,
  source = 'claude',
  variant = 'full',
  wrap = false,
  className,
}: ResumeKeyProps) {
  const { copied, copy } = useCopy();
  const command = resumeCommand(id, cwd, source ?? 'claude');
  if (!command) return null;
  const CopyOrCheck = copied ? Check : Copy;

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label="Copy resume command for this conversation"
        title={command}
        className={cn(
          'flex items-center rounded p-1 text-muted-foreground transition-colors',
          'hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          className,
        )}
      >
        <CopyOrCheck size={ICON_SIZE} aria-hidden="true" className={copied ? 'text-success' : undefined} />
        <span className="sr-only" aria-live="polite">{copied ? 'Copied' : 'Copy resume command'}</span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        'flex min-w-0 max-w-full gap-2 text-xs text-muted-foreground',
        wrap ? 'items-start' : 'items-center overflow-hidden',
        className,
      )}
    >
      <Terminal size={ICON_SIZE} aria-hidden="true" className="mt-0.5 shrink-0" />
      <code
        className={cn(
          'min-w-0 flex-1 font-mono',
          wrap
            ? 'break-all whitespace-pre-wrap'
            : 'overflow-hidden text-ellipsis whitespace-nowrap',
        )}
      >
        {command}
      </code>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label="Copy resume command"
        className="flex shrink-0 items-center rounded p-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <CopyOrCheck size={ICON_SIZE} aria-hidden="true" className={copied ? 'text-success' : undefined} />
        <span className="sr-only" aria-live="polite">{copied ? 'Copied' : ''}</span>
      </button>
    </div>
  );
}
