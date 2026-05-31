/**
 * Application entry point (Skateboard Application Shell Architecture).
 *
 * CC Review is a local, read-only viewer for Claude Code conversation
 * transcripts stored under ~/.claude/projects. Three routes:
 *   - home      → Browse (projects → sessions → transcript)
 *   - search    → Full-text search across every session
 *   - analytics → Token usage and estimated cost
 */
import './assets/styles.css';
import { createSkateboardApp } from '@stevederico/skateboard-ui/App';
import Layout from '@stevederico/skateboard-ui/Layout';
import constants from './constants.json';
import BrowseView from './components/BrowseView.jsx';
import SearchView from './components/SearchView.jsx';
import AnalyticsView from './components/AnalyticsView.jsx';

/** Route table — paths are relative (no leading slash). */
const appRoutes = [
  { path: 'home', element: <BrowseView /> },
  { path: 'search', element: <SearchView /> },
  { path: 'analytics', element: <AnalyticsView /> },
];

createSkateboardApp({
  constants,
  appRoutes,
  defaultRoute: 'home',
  overrides: { layout: Layout },
});
