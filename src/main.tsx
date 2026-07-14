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
import './assets/styles.css';
import { createSkateboardApp } from '@stevederico/skateboard-ui/App';
import type { AppRoute } from '@stevederico/skateboard-ui/App';
import constants from './constants.json';
import AppLayout from './components/AppLayout';
import BrowseView from './components/BrowseView';
import AnalyticsView from './components/AnalyticsView';
import SettingsView from './components/SettingsView';

/** Route table — paths are relative (no leading slash). */
const appRoutes: AppRoute[] = [
  { path: 'home', element: <BrowseView /> },
  { path: 'analytics', element: <AnalyticsView /> },
];

createSkateboardApp({
  constants,
  appRoutes,
  defaultRoute: 'home',
  // Custom layout: mode picker + conversation list in the sidebar.
  overrides: { layout: AppLayout, settings: SettingsView },
});
