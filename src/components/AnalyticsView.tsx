import { useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import MessagesSquare from '@stevederico/skateboard-ui/icons/MessagesSquare';
import MessageCircle from '@stevederico/skateboard-ui/icons/MessageCircle';
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
} from '../lib/format';

/** Per-project rollup row from `/cc/stats` (`byProject`). */
interface ProjectStat {
  project: string;
  name: string;
  cost: number;
  tokens: number;
  messages: number;
  sessions: number;
  updated: string;
  created: string;
}

/** Per-model rollup row from `/cc/stats` (`byModel`). */
interface ModelStat {
  models: string;
  sessions: number;
  out_tok: number;
  cost: number;
}

/** Per-day rollup row from `/cc/stats` (`byDay`). */
interface DayStat {
  day: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

/** Grand totals from `/cc/stats` (`totals`). */
interface StatTotals {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

/** Full `/cc/stats` response shape. */
interface Stats {
  totals: StatTotals;
  byModel: ModelStat[];
  byProject: ProjectStat[];
  byDay: DayStat[];
}

/** Per-month rollup bucket aggregated client-side from {@link DayStat} rows. */
interface MonthBucket {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

/** A row averaged over a period — a day row or a month bucket. */
type MetricRow = DayStat | MonthBucket;

/** Which clickable summary period is showing: per-day, per-month, or total. */
type Period = 'day' | 'month' | 'total';

/** One option in the projects-list sort control. */
interface ProjectSortOption {
  value: string;
  label: string;
  /** Read the numeric sort key from a project row. */
  get: (p: ProjectStat) => number;
  /** Render the value shown on the right of the row. */
  format: (p: ProjectStat) => string;
  /** Date keys sort by recency and size their bar within [min, max]. */
  isDate?: boolean;
}

/**
 * Sort options for the projects list. Each defines how to read its numeric
 * sort key (`get`) and how to render the value shown on the right (`format`).
 * `isDate` keys sort by timestamp and size their bar by recency, not magnitude.
 */
const PROJECT_SORTS: ProjectSortOption[] = [
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

/** Period cycle for the clickable Avg Tokens and Est. Cost summary cards. */
const PERIOD_CYCLE: Period[] = ['day', 'month', 'total'];

/**
 * Next period in {@link PERIOD_CYCLE}, wrapping around to the start. Shaped as a
 * setState updater so it can be passed straight to a state setter.
 * @param period - The current period.
 * @returns The next period to display.
 */
const nextPeriod = (period: Period): Period =>
  PERIOD_CYCLE[(PERIOD_CYCLE.indexOf(period) + 1) % PERIOD_CYCLE.length];

/**
 * Arithmetic mean of a list of numbers.
 * @param values - The numbers to average.
 * @returns The mean, or 0 when the list is empty.
 */
const mean = (values: number[]): number =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;

/**
 * Format a count for display, allowing one decimal place so per-period averages
 * (e.g. 3.4 sessions/day) read sensibly while whole totals stay clean.
 * @param n - The count to format.
 * @returns Localized number string.
 */
const formatCount = (n: number): string =>
  Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });

/** Label + formatted value for one period of a summary card. */
interface PeriodView {
  label: string;
  value: string;
}

/**
 * Build the three period views (day / month / total) for a summary card.
 * @param noun - Metric name used in the average labels, e.g. 'Tokens'.
 * @param totalLabel - Label shown in the total view, e.g. 'Est. Cost'.
 * @param format - Formats a metric value for display.
 * @param values - Per-period values.
 * @returns A label + value for each period.
 */
const periodViews = (
  noun: string,
  totalLabel: string,
  format: (n: number) => string,
  { day, month, total }: { day: number; month: number; total: number },
): Record<Period, PeriodView> => ({
  day: { label: `Avg ${noun}/Day`, value: format(day) },
  month: { label: `Avg ${noun}/Month`, value: format(month) },
  total: { label: totalLabel, value: format(total) },
});

/**
 * Analytics dashboard for local agent usage and cost.
 *
 * Fetches `/cc/stats` on mount and renders summary stat cards (each cycles
 * through per-day, per-month, and total when clicked), a tokens-per-day bar
 * chart with per-bar date labels and
 * a hover/focus tooltip showing the day and its token count, a by-model table,
 * and a projects breakdown sortable by cost, tokens, messages, sessions, or
 * created/updated date. Handles loading, error, and empty states.
 *
 * @returns The analytics view.
 */
export default function AnalyticsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [projectSort, setProjectSort] = useState('cost');
  // The Avg Tokens and Est. Cost cards each cycle day → month → total on click.
  const [tokenPeriod, setTokenPeriod] = useState<Period>('day');
  const [costPeriod, setCostPeriod] = useState<Period>('total');
  const [sessionPeriod, setSessionPeriod] = useState<Period>('total');
  const [messagePeriod, setMessagePeriod] = useState<Period>('total');

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<Stats>('/cc/stats');
      setStats(data);
    } catch (err) {
      console.error('Failed to load analytics stats', err);
      setError(err instanceof Error ? err.message : 'Could not load analytics. Please try again.');
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
              Once you have coding-agent sessions, your usage and cost stats will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const dailyAscending = [...byDay].reverse();

  // Roll the per-day rows up into per-month buckets (YYYY-MM) so the cards can
  // average over months too. byDay already covers every day that had activity.
  const monthMap = new Map<string, MonthBucket>();
  for (const day of byDay) {
    const month = String(day.day).slice(0, 7);
    const bucket = monthMap.get(month) ?? { sessions: 0, messages: 0, tokens: 0, cost: 0 };
    bucket.sessions += Number(day.sessions) || 0;
    bucket.messages += Number(day.messages) || 0;
    bucket.tokens += Number(day.tokens) || 0;
    bucket.cost += Number(day.cost) || 0;
    monthMap.set(month, bucket);
  }
  const byMonth = [...monthMap.values()];

  // Averages run over the periods that actually had activity, matching the chart.
  const avg = (rows: MetricRow[], key: keyof MonthBucket): number =>
    mean(rows.map((r) => Number(r[key]) || 0));

  // Each clickable card maps its current period to a label + formatted value.
  const sessionViews = periodViews('Sessions', 'Sessions', formatCount, {
    day: avg(byDay, 'sessions'), month: avg(byMonth, 'sessions'), total: Number(totals.sessions) || 0,
  });
  const messageViews = periodViews('Messages', 'Messages', formatCount, {
    day: avg(byDay, 'messages'), month: avg(byMonth, 'messages'), total: Number(totals.messages) || 0,
  });
  const tokenViews = periodViews('Tokens', 'Total Tokens', formatTokens, {
    day: avg(byDay, 'tokens'), month: avg(byMonth, 'tokens'), total: Number(totals.tokens) || 0,
  });
  const costViews = periodViews('Cost', 'Est. Cost', formatCost, {
    day: avg(byDay, 'cost'), month: avg(byMonth, 'cost'), total: Number(totals.cost) || 0,
  });

  const statCards = [
    {
      key: 'sessions',
      label: sessionViews[sessionPeriod].label,
      value: sessionViews[sessionPeriod].value,
      Icon: MessagesSquare,
      onClick: () => setSessionPeriod(nextPeriod),
    },
    {
      key: 'messages',
      label: messageViews[messagePeriod].label,
      value: messageViews[messagePeriod].value,
      Icon: MessageCircle,
      onClick: () => setMessagePeriod(nextPeriod),
    },
    {
      key: 'avgTokens',
      label: tokenViews[tokenPeriod].label,
      value: tokenViews[tokenPeriod].value,
      Icon: TrendingUp,
      onClick: () => setTokenPeriod(nextPeriod),
    },
    {
      key: 'cost',
      label: costViews[costPeriod].label,
      value: costViews[costPeriod].value,
      Icon: DollarSign,
      onClick: () => setCostPeriod(nextPeriod),
    },
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
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {statCards.map(({ key, label, value, Icon, onClick }) => {
            const interactive = Boolean(onClick);
            return (
              <Card
                key={key}
                {...(interactive
                  ? {
                      role: 'button',
                      tabIndex: 0,
                      onClick,
                      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onClick();
                        }
                      },
                      'aria-label': `${label}. Activate to change the time period.`,
                      className:
                        'cursor-pointer transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    }
                  : {})}
              >
                <CardContent className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-label-sm text-muted-foreground">{label}</span>
                    <span className="text-heading-lg">{value}</span>
                  </div>
                  <Icon size={24} className="text-muted-foreground" aria-hidden="true" />
                </CardContent>
              </Card>
            );
          })}
        </div>

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
          <Select value={projectSort} onValueChange={(value) => setProjectSort(value ?? 'cost')}>
            <SelectTrigger className="w-40" aria-label="Sort projects by" size="sm">
              <SelectValue placeholder="Sort by" />
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
      </div>
    </>
  );
}
