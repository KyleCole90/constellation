import { PanelLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useWorkspace, workspaceStore } from "~/stores/workspace";

import { Button } from "./ui/button";

export const toggleSidebar = () => {
  const { prefs, setPrefs } = workspaceStore().getState();
  setPrefs({ sidebarOpen: !prefs.sidebarOpen });
};

/**
 * Every screen's title bar: the screen's icon, the screen it sits under, then the current page, all in one type step.
 * A school chip follows the breadcrumb, never the icon.
 */
export function ScreenHeader({
  icon: Icon,
  trail,
  title,
  heading = true,
  chip,
  actions,
}: {
  icon: LucideIcon;
  /** The screen this page sits under, as a link back to it. */
  trail?: ReactNode;
  title: ReactNode;
  /** North Star home keeps its hero as the page's only h1. */
  heading?: boolean;
  chip?: ReactNode;
  actions?: ReactNode;
}) {
  const sidebarOpen = useWorkspace((state) => state.prefs.sidebarOpen);
  const Title = heading ? "h1" : "p";
  return (
    <header
      data-testid="screen-header"
      className="flex h-10 flex-none items-center gap-2 border-b border-border px-4"
    >
      {!sidebarOpen && (
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label="Show sidebar"
          title="Show sidebar (⌘B)"
          onClick={toggleSidebar}
        >
          <PanelLeft />
        </Button>
      )}
      <nav
        data-testid="screen-crumbs"
        className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-screen"
      >
        <Icon aria-hidden className="size-4 flex-none text-muted-foreground" />
        {trail !== undefined && (
          <>
            <span className="min-w-0 shrink-[4] truncate font-medium text-muted-foreground [&_a:hover]:text-foreground">
              {trail}
            </span>
            <span aria-hidden className="flex-none font-medium text-tertiary-label">
              /
            </span>
          </>
        )}
        <Title className="min-w-0 truncate">{title}</Title>
        {chip}
      </nav>
      {actions && <div className="flex flex-none items-center gap-btn-gap">{actions}</div>}
    </header>
  );
}
