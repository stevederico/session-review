/**
 * Application entry point (Skateboard Application Shell Architecture).
 *
 * CC Review is a local, read-only viewer for Claude Code conversation
 * transcripts stored under ~/.claude/projects. Two routes:
 *   - home      → Browse (projects → sessions → transcript), with global
 *                 full-text search merged into the top bar
 *   - analytics → Token usage and estimated cost
 */
import './assets/styles.css';
import { createSkateboardApp } from '@stevederico/skateboard-ui/App';
import Layout from '@stevederico/skateboard-ui/Layout';
import constants from './constants.json';
import BrowseView from './components/BrowseView.jsx';
import AnalyticsView from './components/AnalyticsView.jsx';
import SettingsView from './components/SettingsView.jsx';

/** Route table — paths are relative (no leading slash). */
const appRoutes = [
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
