/**
 * Application entry point (Skateboard Application Shell Architecture).
 *
 * Session Review is a local, read-only viewer for coding-agent transcripts
 * (Claude Code under ~/.claude/projects, Grok CLI under ~/.grok/sessions).
 * Two routes:
 *   - home      → Browse (projects → sessions → transcript), with global
 *                 full-text search merged into the top bar
 *   - analytics → Token usage and estimated cost
 */
import './assets/styles.css';
import { createSkateboardApp } from '@stevederico/skateboard-ui/App';
import type { AppRoute } from '@stevederico/skateboard-ui/App';
import Layout from '@stevederico/skateboard-ui/Layout';
import constants from './constants.json';
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
  // Override the shell settings page so transcript reindexing lives under Settings.
  overrides: { layout: Layout, settings: SettingsView },
});
