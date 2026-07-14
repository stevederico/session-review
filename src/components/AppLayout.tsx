/**
 * Application shell layout — wider sidebar for conversation list,
 * Browse/Analytics mode picker in the header, search above main content.
 */
import { useState, type CSSProperties } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import TabBar from '@stevederico/skateboard-ui/TabBar';
import { SidebarProvider, SidebarInset } from '@stevederico/skateboard-ui/shadcn/ui/sidebar';
import { getState } from '@stevederico/skateboard-ui/Context';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import Info from '@stevederico/skateboard-ui/icons/Info';
import AppSidebar from './AppSidebar';
import HeaderSearch from './HeaderSearch';
import SessionInfoDialog from './SessionInfoDialog';

/**
 * Layout override for createSkateboardApp.
 * Sidebar holds the mode picker + conversations; search sits above the
 * main content outlet (hidden on Settings); main pane is the active route.
 */
export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { state } = getState();
  const { sidebarVisible, tabBarVisible } = state.ui;
  const constants = state.constants;
  const showSidebar = !constants.hideSidebar && sidebarVisible;
  const showTabBar = !constants.hideTabBar && tabBarVisible;
  // Conversation search is for Browse/Analytics only — not Settings chrome.
  const showSearch = !location.pathname.toLowerCase().includes('/settings');
  const sessionId = searchParams.get('session') ?? '';
  const [infoOpen, setInfoOpen] = useState(false);

  const sidebarStyle: CSSProperties & Record<`--${string}`, string> = {
    // Wider than skateboard default (12rem) so conversation rows fit.
    '--sidebar-width': '18rem',
    '--header-height': '3.5rem',
  };

  /** Open a hit from global search on the Browse route with session selected. */
  const handleSelectSession = (id: string) => {
    navigate(`/app/home?session=${encodeURIComponent(id)}`);
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
          className={`flex min-h-0 flex-col border border-border/50 ${constants.hideSidebarInsetRounding ? 'md:peer-data-[variant=inset]:rounded-none' : ''}`}
        >
          {showSearch ? (
            <header className="flex h-(--header-height) w-full shrink-0 items-stretch border-b border-border">
              <HeaderSearch
                onSelect={handleSelectSession}
                className="h-full min-w-0 flex-1"
              />
              <div className="flex shrink-0 items-center pr-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 border-0 shadow-none"
                  aria-label={
                    sessionId
                      ? 'Conversation info'
                      : 'Conversation info (select a conversation first)'
                  }
                  disabled={!sessionId}
                  onClick={() => setInfoOpen(true)}
                >
                  <Info size={18} strokeWidth={2} aria-hidden />
                </Button>
              </div>
              <SessionInfoDialog
                open={infoOpen}
                onOpenChange={setInfoOpen}
                sessionId={sessionId}
              />
            </header>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
      {showTabBar ? <TabBar className="md:hidden" /> : null}
    </div>
  );
}
