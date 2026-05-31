import { useState, useEffect, useCallback } from 'react';
import { Search, CircleAlert } from '@stevederico/skateboard-ui/icons';
import { apiRequest, apiRequestWithParams } from '@stevederico/skateboard-ui/Utilities';
import Header from '@stevederico/skateboard-ui/Header';
import { Input } from '@stevederico/skateboard-ui/shadcn/ui/input';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@stevederico/skateboard-ui/shadcn/ui/empty';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@stevederico/skateboard-ui/shadcn/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@stevederico/skateboard-ui/shadcn/ui/sheet';
import { relativeTime } from '../lib/format.js';
import Transcript from './Transcript.jsx';

/** Sentinel select value representing "search across every project". */
const ALL_PROJECTS = 'all';

/** Debounce delay (ms) before firing a search request. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Split a backend snippet on its literal `[`/`]` match delimiters and render the
 * bracketed spans as highlighted <mark>s, leaving the rest as plain text.
 *
 * @param {string} snippet - Snippet string with matched terms wrapped in `[` and `]`.
 * @returns {Array<JSX.Element>} React nodes for the highlighted snippet.
 */
function renderSnippet(snippet) {
  const text = snippet ?? '';
  // Split, keeping the bracketed groups as their own parts.
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

/**
 * A single search result row. Clickable/keyboard-activatable to open the
 * matching conversation.
 *
 * @param {Object} props
 * @param {Object} props.result - One row from /cc/search.
 * @param {Function} props.onOpen - Called with the result when activated.
 * @returns {JSX.Element}
 */
function ResultRow({ result, onOpen }) {
  const { name, project, role, ts, snippet } = result;
  const label = name || project || 'conversation';

  const handleActivate = () => onOpen(result);
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(result);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      aria-label={`Open conversation ${label}`}
      className="flex w-full cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
        <Badge variant="secondary">{role}</Badge>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {relativeTime(ts)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground break-words">{renderSnippet(snippet)}</p>
    </div>
  );
}

/**
 * Sheet body that fetches a single session and renders its transcript, with its
 * own loading / error states.
 *
 * @param {Object} props
 * @param {string} props.sessionId - Session id to load.
 * @returns {JSX.Element}
 */
function ResultSheetBody({ sessionId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest(`/cc/session/${sessionId}`);
      setData(result);
    } catch (err) {
      console.error('Failed to load session', err);
      setError("Couldn't load this conversation.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlert size={24} />
          </EmptyMedia>
          <EmptyTitle>Failed to load conversation</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={loadSession}>Try again</Button>
      </Empty>
    );
  }

  return <Transcript records={data?.records ?? []} meta={data?.meta ?? {}} />;
}

/**
 * Full-text search across all Claude Code sessions. Debounces the query,
 * optionally filters by project, highlights matched terms, and opens any result
 * in a side Sheet rendering the full transcript.
 *
 * @returns {JSX.Element}
 */
export default function SearchView() {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [project, setProject] = useState(ALL_PROJECTS);
  const [projects, setProjects] = useState([]);

  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  // Load the project list for the filter (non-blocking — failure just hides options).
  useEffect(() => {
    let active = true;
    apiRequest('/cc/projects')
      .then((rows) => {
        if (active) setProjects(Array.isArray(rows) ? rows : []);
      })
      .catch((err) => console.error('Failed to load projects', err));
    return () => {
      active = false;
    };
  }, []);

  // Debounce the raw query into debouncedQuery.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Run the search whenever the debounced query or project filter changes.
  const runSearch = useCallback(async (q, proj) => {
    if (!q) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = { q };
      if (proj && proj !== ALL_PROJECTS) params.project = proj;
      const rows = await apiRequestWithParams('/cc/search', params);
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
    runSearch(debouncedQuery, project);
  }, [debouncedQuery, project, runSearch]);

  const handleQueryChange = (e) => setQuery(e.target.value);
  const handleRetry = () => runSearch(debouncedQuery, project);
  const handleSheetOpenChange = (open) => {
    if (!open) setOpenId(null);
  };

  const hasQuery = debouncedQuery.length > 0;

  return (
    <>
      <Header title="Search" />

      <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              size={16}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={handleQueryChange}
              autoFocus
              aria-label="Search all conversations"
              placeholder="Search all conversations…"
              className="pl-8"
            />
          </div>

          <Select value={project} onValueChange={setProject}>
            <SelectTrigger className="w-full sm:w-56" aria-label="Filter by project">
              <SelectValue placeholder="All projects">
                {(value) => {
                  if (!value || value === ALL_PROJECTS) return 'All projects';
                  const p = projects.find((proj) => proj.project === value);
                  return p ? (p.name || p.cwd || p.project) : value;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.project} value={p.project}>
                  {p.name || p.cwd || p.project}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-1 flex-col" aria-live="polite">
          {renderResultsRegion({
            hasQuery,
            loading,
            error,
            results,
            onOpen: (result) => setOpenId(result.id),
            onRetry: handleRetry,
          })}
        </div>
      </div>

      <Sheet open={openId != null} onOpenChange={handleSheetOpenChange}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl">
          <SheetHeader className="border-b border-border">
            <SheetTitle>Conversation</SheetTitle>
            <SheetDescription>Full transcript for the selected result.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col overflow-y-auto">
            {openId != null && <ResultSheetBody sessionId={openId} />}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Pick the right results-region content for the current state.
 *
 * @param {Object} args
 * @param {boolean} args.hasQuery - Whether a (debounced) query exists.
 * @param {boolean} args.loading - Whether a search is in flight.
 * @param {?string} args.error - Error message, if any.
 * @param {Array<Object>} args.results - Search result rows.
 * @param {Function} args.onOpen - Open handler for a result.
 * @param {Function} args.onRetry - Retry handler for the error state.
 * @returns {JSX.Element}
 */
function renderResultsRegion({ hasQuery, loading, error, results, onOpen, onRetry }) {
  if (error) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlert size={48} />
          </EmptyMedia>
          <EmptyTitle>Something went wrong</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={onRetry}>Try again</Button>
      </Empty>
    );
  }

  if (!hasQuery) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Search size={48} />
          </EmptyMedia>
          <EmptyTitle>Search your conversations</EmptyTitle>
          <EmptyDescription>
            Type above to find messages across every session.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Spinner />
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Search size={48} />
          </EmptyMedia>
          <EmptyTitle>No matches</EmptyTitle>
          <EmptyDescription>Try different terms or another project.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {results.map((result, i) => (
        <ResultRow key={`${result.id}-${result.ts}-${i}`} result={result} onOpen={onOpen} />
      ))}
    </div>
  );
}
