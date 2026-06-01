import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import Copy from '@stevederico/skateboard-ui/icons/Copy';
import Check from '@stevederico/skateboard-ui/icons/Check';
import Terminal from '@stevederico/skateboard-ui/icons/Terminal';
import { useCopy } from '../lib/useCopy.js';
import { resumeCommand } from '../lib/resume.js';

/** Icon size for the copy/terminal glyphs (matches the transcript action row). */
const ICON_SIZE = 14;

/**
 * Surface the `claude --resume <id>` command for a session so the user can copy
 * it and pick the conversation back up in their terminal.
 *
 * Two layouts:
 *   - `full`    — terminal glyph + the mono command + a copy button. For the
 *                 open conversation's detail header.
 *   - `compact` — an icon-only copy button (command shown via tooltip/aria-label).
 *                 For dense session-list rows where the full command won't fit.
 *
 * Copy feedback flashes a check + an `aria-live` "Copied" message via {@link useCopy}.
 *
 * @param {Object} props
 * @param {string} props.id - Session id (transcript UUID) to resume.
 * @param {string} [props.cwd] - Conversation's working directory; when present the
 *   copied command is prefixed with `cd <cwd> &&` so it resumes from anywhere.
 * @param {'full'|'compact'} [props.variant] - Layout variant (default `full`).
 * @param {string} [props.className] - Extra classes for the root element.
 * @returns {JSX.Element|null} Null when no id is available.
 */
export default function ResumeKey({ id, cwd, variant = 'full', className }) {
  const { copied, copy } = useCopy();
  const command = resumeCommand(id, cwd);
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
    <div className={cn('flex min-w-0 items-center gap-2 text-xs text-muted-foreground', className)}>
      <Terminal size={ICON_SIZE} aria-hidden="true" className="shrink-0" />
      <code className="min-w-0 truncate font-mono">{command}</code>
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
