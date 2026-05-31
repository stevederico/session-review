import { useCallback, useEffect, useState } from 'react';
import MessagesSquare from '@stevederico/skateboard-ui/icons/MessagesSquare';
import MessageCircle from '@stevederico/skateboard-ui/icons/MessageCircle';
import Coins from '@stevederico/skateboard-ui/icons/Coins';
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
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import { formatCost, formatTokens, shortModel } from '../lib/format.js';

const COST_DISCLAIMER = 'Costs are estimates based on public per-model pricing.';

/**
 * Analytics dashboard for Claude Code usage and cost.
 *
 * Fetches `/cc/stats` on mount and renders summary stat cards, a by-model
 * table, a top-projects cost breakdown, and a 60-day activity bar chart.
 * Handles loading, error, and empty states.
 *
 * @returns {JSX.Element} The analytics view.
 */
export default function AnalyticsView() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  const statCards = [
    { label: 'Sessions', value: totals.sessions.toLocaleString(), Icon: MessagesSquare },
    { label: 'Messages', value: totals.messages.toLocaleString(), Icon: MessageCircle },
    { label: 'Tokens', value: formatTokens(totals.tokens), Icon: Coins },
    { label: 'Est. Cost', value: formatCost(totals.cost), Icon: DollarSign },
  ];

  const maxProjectCost = byProject.reduce((max, p) => Math.max(max, Number(p.cost) || 0), 0);
  const dailyAscending = [...byDay].reverse();
  const maxDailyMessages = dailyAscending.reduce(
    (max, d) => Math.max(max, Number(d.messages) || 0),
    0,
  );

  return (
    <>
      <Header title="Analytics" />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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

        <h2 className="mt-8 mb-3 text-heading-md">Top projects</h2>
        {byProject.length === 0 ? (
          <p className="text-sm text-muted-foreground">No project activity recorded.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {byProject.map((project) => (
              <div key={project.project} className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium">{project.name}</span>
                    <span className="text-label-sm text-muted-foreground">
                      {Number(project.sessions).toLocaleString()} sessions ·{' '}
                      {Number(project.messages).toLocaleString()} msgs
                    </span>
                  </div>
                  <span className="shrink-0 text-right tabular-nums">
                    {formatCost(project.cost)}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-md bg-muted">
                  <div
                    className="h-full rounded-md bg-primary"
                    style={{
                      width: `${maxProjectCost ? ((Number(project.cost) || 0) / maxProjectCost) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <h2 className="mt-8 mb-3 text-heading-md">Activity (last 60 days)</h2>
        {dailyAscending.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent activity.</p>
        ) : (
          <div className="flex h-32 items-end gap-0.5" role="img" aria-label="Messages per day for the last 60 days">
            {dailyAscending.map((day) => (
              <div
                key={day.day}
                title={`${day.day}: ${Number(day.messages).toLocaleString()} msgs / ${formatCost(day.cost)}`}
                className={cn(
                  'flex-1 rounded-t bg-primary transition-opacity hover:opacity-80',
                  (Number(day.messages) || 0) === 0 && 'opacity-20',
                )}
                style={{
                  height: `${maxDailyMessages ? Math.max(((Number(day.messages) || 0) / maxDailyMessages) * 100, 2) : 0}%`,
                }}
              />
            ))}
          </div>
        )}
        <p className="mt-3 text-label-sm text-muted-foreground">{COST_DISCLAIMER}</p>
      </div>
    </>
  );
}
