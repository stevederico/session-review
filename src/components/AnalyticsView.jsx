import { useCallback, useEffect, useState } from 'react';
import MessagesSquare from '@stevederico/skateboard-ui/icons/MessagesSquare';
import MessageCircle from '@stevederico/skateboard-ui/icons/MessageCircle';
import Coins from '@stevederico/skateboard-ui/icons/Coins';
import TrendingUp from '@stevederico/skateboard-ui/icons/TrendingUp';
import DollarSign from '@stevederico/skateboard-ui/icons/DollarSign';
import CircleAlert from '@stevederico/skateboard-ui/icons/CircleAlert';
import BarChart3 from '@stevederico/skateboard-ui/icons/ChartColumn';
import Header from '@stevederico/skateboard-ui/Header';
import { apiRequest } from '@stevederico/skateboard-ui/Utilities';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@stevederico/skateboard-ui/shadcn/ui/empty';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Card, CardContent } from '@stevederico/skateboard-ui/shadcn/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@stevederico/skateboard-ui/shadcn/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@stevederico/skateboard-ui/shadcn/ui/select';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@stevederico/skateboard-ui/shadcn/ui/tooltip';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import {
  formatCost,
  formatTokens,
  formatDate,
  formatDayShort,
  relativeTime,
  shortModel,
} from '../lib/format.js';

/**
 * Sort options for the projects list. Each defines how to read its numeric
 * sort key (`get`) and how to render the value shown on the right (`format`).
 * `isDate` keys sort by timestamp and size their bar by recency, not magnitude.
 */
const PROJECT_SORTS = [
  { value: 'cost', label: 'Cost', get: (p) => Number(p.cost) || 0, format: (p) => formatCost(p.cost) },
  {
    value: 'tokens',
    label: 'Tokens',
    get: (p) => Number(p.tokens) || 0,
    format: (p) => `${formatTokens(p.tokens)} tokens`,
  },
  {
    value: 'messages',
    label: 'Messages',
    get: (p) => Number(p.messages) || 0,
    format: (p) => `${Number(p.messages).toLocaleString()} msgs`,
  },
  {
    value: 'sessions',
    label: 'Sessions',
    get: (p) => Number(p.sessions) || 0,
    format: (p) => `${Number(p.sessions).toLocaleString()} sessions`,
  },
  {
    value: 'updated',
    label: 'Last updated',
    isDate: true,
    get: (p) => Date.parse(p.updated) || 0,
    format: (p) => relativeTime(p.updated),
  },
  {
    value: 'created',
    label: 'Date created',
    isDate: true,
    get: (p) => Date.parse(p.created) || 0,
    format: (p) => formatDate(p.created),
  },
];

const COST_DISCLAIMER = 'Costs are estimates based on public per-model pricing.';

/**
 * Analytics dashboard for Claude Code usage and cost.
 *
 * Fetches `/cc/stats` on mount and renders summary stat cards (including
 * average tokens/day), a tokens-per-day bar chart with per-bar date labels and
 * a hover/focus tooltip showing the day and its token count, a by-model table,
 * and a projects breakdown sortable by cost, tokens, messages, sessions, or
 * created/updated date. Handles loading, error, and empty states.
 *
 * @returns {JSX.Element} The analytics view.
 */
export default function AnalyticsView() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [projectSort, setProjectSort] = useState('cost');

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest('/cc/stats');
      setStats(data);
    } catch (err) {
      console.error('Failed to load analytics stats', err);
      setError(err?.message ?? 'Could not load analytics. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleRetry = () => loadStats();

  if (loading) {
    return (
      <>
        <Header title="Analytics" />
        <div className="flex flex-1 items-center justify-center p-8">
          <Spinner className="size-6" />
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Header title="Analytics" />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleAlert size={24} />
            </EmptyMedia>
            <EmptyTitle>Failed to load analytics</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
          <Button onClick={handleRetry}>Try again</Button>
        </Empty>
      </>
    );
  }

  const totals = stats?.totals;
  const byModel = stats?.byModel ?? [];
  const byProject = stats?.byProject ?? [];
  const byDay = stats?.byDay ?? [];

  if (!totals || totals.sessions === 0) {
    return (
      <>
        <Header title="Analytics" />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BarChart3 size={24} />
            </EmptyMedia>
            <EmptyTitle>No usage yet</EmptyTitle>
            <EmptyDescription>
              Once you have Claude Code sessions, your usage and cost stats will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const dailyAscending = [...byDay].reverse();
  const dailyTokenTotal = dailyAscending.reduce((sum, d) => sum + (Number(d.tokens) || 0), 0);
  // Average over days that actually had activity, matching the chart below.
  const avgTokensPerDay = dailyAscending.length ? dailyTokenTotal / dailyAscending.length : 0;

  const statCards = [
    { label: 'Sessions', value: totals.sessions.toLocaleString(), Icon: MessagesSquare },
    { label: 'Messages', value: totals.messages.toLocaleString(), Icon: MessageCircle },
    { label: 'Tokens', value: formatTokens(totals.tokens), Icon: Coins },
    { label: 'Avg Tokens/Day', value: formatTokens(avgTokensPerDay), Icon: TrendingUp },
    { label: 'Est. Cost', value: formatCost(totals.cost), Icon: DollarSign },
  ];

  const activeSort = PROJECT_SORTS.find((s) => s.value === projectSort) ?? PROJECT_SORTS[0];
  const sortedProjects = [...byProject].sort((a, b) => activeSort.get(b) - activeSort.get(a));
  // Bar baseline: date sorts scale by recency within [min, max]; others from 0.
  const sortValues = sortedProjects.map(activeSort.get);
  const maxSort = sortValues.reduce((max, v) => Math.max(max, v), 0);
  const minSort = activeSort.isDate
    ? sortValues.reduce((min, v) => Math.min(min, v), maxSort)
    : 0;
  const sortRange = maxSort - minSort;
  const maxDailyTokens = dailyAscending.reduce(
    (max, d) => Math.max(max, Number(d.tokens) || 0),
    0,
  );

  return (
    <>
      <Header title="Analytics" />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {statCards.map(({ label, value, Icon }) => (
            <Card key={label}>
              <CardContent className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-label-sm text-muted-foreground">{label}</span>
                  <span className="text-heading-lg">{value}</span>
                </div>
                <Icon size={24} className="text-muted-foreground" aria-hidden="true" />
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="mt-3 text-label-sm text-muted-foreground">{COST_DISCLAIMER}</p>

        <h2 className="mt-8 mb-3 text-heading-md">Tokens per day</h2>
        {dailyAscending.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent activity.</p>
        ) : (
          <div role="group" aria-label="Token usage per day">
            <div className="flex h-32 items-end gap-0.5">
              {dailyAscending.map((day) => (
                <Tooltip key={day.day}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`${formatDate(day.day)}: ${formatTokens(day.tokens)} tokens`}
                        className={cn(
                          'flex-1 cursor-pointer rounded-t bg-primary transition-opacity hover:opacity-80 focus-visible:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          (Number(day.tokens) || 0) === 0 && 'opacity-20',
                        )}
                        style={{
                          height: `${maxDailyTokens ? Math.max(((Number(day.tokens) || 0) / maxDailyTokens) * 100, 2) : 0}%`,
                        }}
                      />
                    }
                  />
                  <TooltipContent>
                    <span className="font-medium">{formatDate(day.day)}</span>
                    {' · '}
                    {formatTokens(day.tokens)} tokens
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
            {/* X-axis: one M/D label per bar, rotated vertical so it fits any column width. */}
            <div className="mt-1.5 flex gap-0.5" aria-hidden="true">
              {dailyAscending.map((day) => (
                <span
                  key={day.day}
                  className="flex-1 text-center text-label-sm leading-none tabular-nums text-muted-foreground [writing-mode:vertical-rl]"
                >
                  {formatDayShort(day.day)}
                </span>
              ))}
            </div>
          </div>
        )}

        <h2 className="mt-8 mb-3 text-heading-md">By model</h2>
        {byModel.length === 0 ? (
          <p className="text-sm text-muted-foreground">No model usage recorded.</p>
        ) : (
          <Card>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                    <TableHead className="text-right">Output tokens</TableHead>
                    <TableHead className="text-right">Est. cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byModel.map((row) => (
                    <TableRow key={row.models}>
                      <TableCell className="font-medium">{shortModel(row.models)}</TableCell>
                      <TableCell className="text-right">
                        {Number(row.sessions).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">{formatTokens(row.out_tok)}</TableCell>
                      <TableCell className="text-right">{formatCost(row.cost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <div className="mt-8 mb-3 flex items-center justify-between gap-4">
          <h2 className="text-heading-md">Projects</h2>
          <Select value={projectSort} onValueChange={setProjectSort}>
            <SelectTrigger className="w-40" aria-label="Sort projects by" size="sm">
              <SelectValue placeholder="Sort by">
                {(value) =>
                  PROJECT_SORTS.find((s) => s.value === value)?.label ?? value
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PROJECT_SORTS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {sortedProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No project activity recorded.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {sortedProjects.map((project) => {
              const value = activeSort.get(project);
              const width = sortRange ? Math.max(((value - minSort) / sortRange) * 100, 2) : 0;
              return (
                <div key={project.project} className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium">{project.name}</span>
                      <span className="text-label-sm text-muted-foreground">
                        {Number(project.sessions).toLocaleString()} sessions ·{' '}
                        {Number(project.messages).toLocaleString()} msgs ·{' '}
                        {formatTokens(project.tokens)} tokens
                      </span>
                    </div>
                    <span className="shrink-0 text-right tabular-nums">
                      {activeSort.format(project)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-md bg-muted">
                    <div
                      className="h-full rounded-md bg-primary"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-3 text-label-sm text-muted-foreground">{COST_DISCLAIMER}</p>
      </div>
    </>
  );
}
