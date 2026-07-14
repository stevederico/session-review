/**
 * Application shell layout — wider sidebar for conversation list,
 * Browse/Analytics mode picker in the header, main content via Outlet.
 */
import type { CSSProperties } from 'react';
import { Outlet } from 'react-router';
import TabBar from '@stevederico/skateboard-ui/TabBar';
import { SidebarProvider, SidebarInset } from '@stevederico/skateboard-ui/shadcn/ui/sidebar';
import { getState } from '@stevederico/skateboard-ui/Context';
import AppSidebar from './AppSidebar';

/**
 * Layout override for createSkateboardApp.
 * Sidebar holds the mode picker + conversations; main pane is the active route.
 */
export default function AppLayout() {
  const { state } = getState();
  const { sidebarVisible, tabBarVisible } = state.ui;
  const constants = state.constants;
  const showSidebar = !constants.hideSidebar && sidebarVisible;
  const showTabBar = !constants.hideTabBar && tabBarVisible;

  const sidebarStyle: CSSProperties & Record<`--${string}`, string> = {
    // Wider than skateboard default (12rem) so conversation rows fit.
    '--sidebar-width': '18rem',
    '--header-height': '3.5rem',
  };

  return (
    <div className="flex min-h-screen flex-col pt-[env(safe-area-inset-top)] pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <SidebarProvider defaultOpen={!constants.sidebarCollapsed} style={sidebarStyle}>
        {showSidebar ? <AppSidebar variant="inset" /> : null}
        <SidebarInset
          id="main"
          className={`border border-border/50 ${constants.hideSidebarInsetRounding ? 'md:peer-data-[variant=inset]:rounded-none' : ''}`}
        >
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
      {showTabBar ? <TabBar className="md:hidden" /> : null}
    </div>
  );
}
