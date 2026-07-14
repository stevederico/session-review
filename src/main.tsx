/**
 * Application entry point (Skateboard Application Shell Architecture).
 *
 * Session Review is a local, read-only viewer for coding-agent transcripts
 * (claude under ~/.claude/projects, grok under ~/.grok/sessions).
 * Shell:
 *   - sidebar logo picker → Browse | Analytics
 *   - sidebar list → conversations (Browse mode)
 *   - main → transcript (home) or analytics
 */
import { lazy, Suspense } from 'react';
import './assets/styles.css';
import { createSkateboardApp } from '@stevederico/skateboard-ui/App';
import type { AppRoute } from '@stevederico/skateboard-ui/App';
import { Spinner } from '@stevederico/skateboard-ui/shadcn/ui/spinner';
import constants from './constants.json';
import AppLayout from './components/AppLayout';
import BrowseView from './components/BrowseView';
import SettingsView from './components/SettingsView';

// Lazy Analytics keeps the Browse-first path lighter (bundle-dynamic-imports).
const AnalyticsView = lazy(() => import('./components/AnalyticsView'));

/** Centered spinner while a lazy route chunk loads. */
function RouteFallback() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Spinner />
    </div>
  );
}

/** Route table — paths are relative (no leading slash). */
const appRoutes: AppRoute[] = [
  { path: 'home', element: <BrowseView /> },
  {
    path: 'analytics',
    element: (
      <Suspense fallback={<RouteFallback />}>
        <AnalyticsView />
      </Suspense>
    ),
  },
];

createSkateboardApp({
  constants,
  appRoutes,
  defaultRoute: 'home',
  // Custom layout: mode picker + conversation list in the sidebar.
  overrides: { layout: AppLayout, settings: SettingsView },
});
