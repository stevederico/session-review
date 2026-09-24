import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { CircleAlert, Search, X } from 'lucide-react';
import { apiRequestWithParams } from '@stevederico/skateboard-ui/Utilities';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import { Input } from '@stevederico/skateboard-ui/shadcn/ui/input';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import { relativeTime } from '../lib/format';

/** Debounce delay (ms) before firing a search request. */
const SEARCH_DEBOUNCE_MS = 300;

/** One row from the `/cc/search` endpoint. */
interface SearchResult {
  /** Session id, handed to `onSelect` when the row is opened. */
  id: string;
  name?: string;
  project?: string;
  role: string;
  ts: string;
  /** Snippet with matched terms wrapped in `[` and `]`. */
  snippet: string;
}

/**
 * Split a backend snippet on its literal `[`/`]` match delimiters and render the
 * bracketed spans as highlighted <mark>s, leaving the rest as plain text.
 *
 * @param snippet - Snippet string with matched terms wrapped in `[` and `]`.
 * @returns React nodes for the highlighted snippet.
 */
function renderSnippet(snippet: string | null | undefined) {
  const text = snippet ?? '';
  const parts = text.split(/\[([^\]]*)\]/g);
  return parts.map((part, i) =>
    // Odd indices are the captured (bracketed) match groups.
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-warning/30 px-0.5 text-foreground">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

/** Props for a single {@link ResultRow}. */
interface ResultRowProps {
  /** One row from /cc/search. */
  result: SearchResult;
  /** Called with the result when activated. */
  onOpen: (result: SearchResult) => void;
}

/**
 * A single search result row inside the dropdown. Clickable/keyboard-activatable
 * to open the matching conversation.
 */
function ResultRow({ result, onOpen }: ResultRowProps) {
  const { name, project, role, ts, snippet } = result;
  const label = name || project || 'conversation';

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(result);
    }
  };

  return (
    <div
      role="option"
      aria-selected="false"
      tabIndex={0}
      onClick={() => onOpen(result)}
      onKeyDown={handleKeyDown}
      aria-label={`Open conversation ${label}`}
      className="flex w-full cursor-pointer flex-col gap-1 rounded-md border border-transparent p-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
        <Badge variant="secondary">{role}</Badge>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {relativeTime(ts)}
        </span>
      </div>
      <p className="line-clamp-2 break-words text-sm text-muted-foreground">
        {renderSnippet(snippet)}
      </p>
    </div>
  );
}

/** Props for {@link HeaderSearch}. */
interface HeaderSearchProps {
  /** Called with a session id when a result is chosen. */
  onSelect?: (id: string) => void;
  /** Extra classes for the wrapper. */
  className?: string;
}

/**
 * Global conversation search that lives in the top bar. Debounces the query,
 * hits /cc/search, and shows matches in a dropdown; selecting a result hands its
 * session id to `onSelect` so the host view can open it in place.
 */
export default function HeaderSearch({ onSelect, className }: HeaderSearchProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce the raw query into debouncedQuery.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Run the search whenever the debounced query changes.
  const runSearch = useCallback(async (q: string) => {
    if (!q) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await apiRequestWithParams<SearchResult[]>('/cc/search', { q });
      setResults(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.error('Search failed', err);
      setError('Search failed. Please try again.');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    runSearch(debouncedQuery);
  }, [debouncedQuery, runSearch]);

  // Close the dropdown on outside click.
  useEffect(() => {
    const handleClick = (e: PointerEvent) => {
      if (wrapperRef.current && e.target instanceof Node && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleClick);
    return () => document.removeEventListener('pointerdown', handleClick);
  }, []);

  const handleQueryChange = (e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setOpen(true);
  };

  const handleClear = () => {
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (query) handleClear();
      else setOpen(false);
    }
  };

  const handleOpenResult = (result: SearchResult) => {
    onSelect?.(result.id);
    setOpen(false);
  };

  const hasQuery = debouncedQuery.length > 0;
  const showDropdown = open && hasQuery;

  return (
    <div ref={wrapperRef} className={cn('relative flex h-full min-w-0', className)}>
      <div className="relative flex h-full min-w-0 flex-1 items-center">
        <Search
          size={16}
          aria-hidden="true"
          className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 text-muted-foreground lg:left-6"
        />
        <Input
          ref={inputRef}
          type="search"
          value={query}
          onChange={handleQueryChange}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="header-search-results"
          aria-label="Search all conversations"
          placeholder="Search all conversations…"
          className={cn(
            'h-full w-full min-w-0 rounded-none border-0 bg-transparent py-0 pl-10 pr-10 shadow-none',
            'lg:pl-12 lg:pr-12',
            'focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0',
            'dark:bg-transparent',
          )}
        />
        {query ? (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:right-5"
          >
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {showDropdown ? (
        <div
          id="header-search-results"
          role="listbox"
          aria-live="polite"
          className="absolute inset-x-0 top-full z-50 max-h-[28rem] overflow-y-auto border-b border-border bg-popover p-2 shadow-lg"
        >
          {error ? (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <CircleAlert size={16} aria-hidden="true" />
              {error}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center p-6">
              <Spinner />
            </div>
          ) : results.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No matches. Try different terms.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {results.map((result, i) => (
                <ResultRow
                  key={`${result.id}-${result.ts}-${i}`}
                  result={result}
                  onOpen={handleOpenResult}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
