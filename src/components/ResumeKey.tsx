/**
 * Full resume command with copy control (info modal).
 *
 * Explicit single layout — no variant/boolean modes
 * (vercel-composition-patterns: patterns-explicit-variants).
 */
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import Copy from '@stevederico/skateboard-ui/icons/Copy';
import Check from '@stevederico/skateboard-ui/icons/Check';
import Terminal from '@stevederico/skateboard-ui/icons/Terminal';
import { useCopy } from '../lib/useCopy';
import { resumeCommand } from '../lib/resume';

/** Icon size for the copy/terminal glyphs. */
const ICON_SIZE = 14;

/** Props for {@link ResumeKey}. */
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
  /** Extra classes for the root element. */
  className?: string;
}

/**
 * Surface the full resume shell command so the user can copy it and reopen
 * the conversation in the terminal (`claude --resume` or `grok --resume`).
 * Command text wraps so long lines stay readable.
 *
 * @returns Null when no id is available.
 */
export default function ResumeKey({
  id,
  cwd,
  source = 'claude',
  className,
}: ResumeKeyProps) {
  const { copied, copy } = useCopy();
  const command = resumeCommand(id, cwd, source ?? 'claude');
  if (!command) return null;
  const CopyOrCheck = copied ? Check : Copy;

  return (
    <div
      className={cn(
        'flex min-w-0 max-w-full items-start gap-2 text-xs text-muted-foreground',
        className,
      )}
    >
      <Terminal size={ICON_SIZE} aria-hidden="true" className="mt-0.5 shrink-0" />
      <code className="min-w-0 flex-1 break-all font-mono whitespace-pre-wrap">
        {command}
      </code>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label="Copy resume command"
        className="flex shrink-0 items-center rounded p-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <CopyOrCheck
          size={ICON_SIZE}
          aria-hidden="true"
          className={copied ? 'text-success' : undefined}
        />
        <span className="sr-only" aria-live="polite">
          {copied ? 'Copied' : ''}
        </span>
      </button>
    </div>
  );
}
