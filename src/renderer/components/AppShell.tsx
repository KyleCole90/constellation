import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import type { LmsRef, ThreadId } from "~/shared/domain/ids";
import {
  INBOX_THREAD,
  NORTH_STAR_THREAD,
  selectChangesShown,
  selectCourse,
  summarizeFor,
} from "~/renderer/stores/selectors";
import { expiredNoticeText, useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { CommandPalette } from "./CommandPalette";
import { toggleSidebar } from "./ScreenHeader";
import { SettleToast } from "./SettleAction";
import { Sidebar, useJumpOrder } from "./Sidebar";
import { stepThread } from "./sidebar.logic";
import { Button } from "./ui/button";
import { useNewThread } from "./useNewThread";

const MOD_HOLD_MS = 220;

export const isMod = (event: KeyboardEvent): boolean => event.metaKey || event.ctrlKey;

function NoticeBar({ thread }: { thread: ThreadId | null }) {
  const notice = useWorkspace((state) => state.notice);
  // A change on screen already says so on its card and beside its Send button, and one problem gets one banner.
  const covered = useWorkspace((state) => {
    const open = thread && state.threads[thread];
    if (!open) return false;
    return selectChangesShown(state, open).some((id) => {
      const change = state.changes[id];
      if (
        !change ||
        summarizeFor(change, state.connections[change.school]?.status).banner !== "reconnect"
      )
        return false;
      return (
        state.notice ===
        expiredNoticeText(
          state.schools.find((school) => school.id === change.school)?.name ?? change.school,
        )
      );
    });
  });
  if (!notice || covered) return null;
  return (
    <div
      role="status"
      data-testid="notice-bar"
      className="fade-in flex flex-none items-center gap-2 border-b border-warning/25 bg-warning/10 px-banner-x py-banner-y text-body text-warning-foreground"
    >
      <span className="min-w-0 flex-1">{notice}</span>
      <Button
        variant="ghost-muted"
        size="icon"
        aria-label="Dismiss"
        onClick={() => workspaceStore().getState().dismissNotice()}
      >
        <X />
      </Button>
    </div>
  );
}

function useHeldModifier() {
  useEffect(() => {
    let timer: number | undefined;
    const release = () => {
      window.clearTimeout(timer);
      delete document.body.dataset["modHeld"];
    };
    const down = (event: KeyboardEvent) => {
      if (event.key !== "Meta" && event.key !== "Control") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        document.body.dataset["modHeld"] = "true";
      }, MOD_HOLD_MS);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      release();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);
}

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname === "/welcome" || pathname === "/setup" ? (
    <Outlet />
  ) : (
    <AppFrame pathname={pathname} />
  );
}

function AppFrame({ pathname }: { pathname: string }) {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const newThread = useNewThread();
  const sidebarOpen = useWorkspace((state) => state.prefs.sidebarOpen);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const activeThread = (params.threadId ?? null) as ThreadId | null;
  const order = useJumpOrder(activeThread);
  const courseRef = useWorkspace((state) =>
    activeThread
      ? (state.threads[activeThread]?.course ?? null)
      : ((params.courseId ?? null) as LmsRef<"course"> | null),
  );
  useHeldModifier();

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!isMod(event)) return;
    const goTo = (threadId: ThreadId | null | undefined) => {
      if (threadId) void navigate({ to: "/threads/$threadId", params: { threadId } });
    };
    const key = event.key.toLowerCase();
    if (key === "k") {
      event.preventDefault();
      setPaletteOpen((open) => !open);
    } else if (key === "b") {
      event.preventDefault();
      toggleSidebar();
    } else if (/^[1-9]$/.test(event.key)) {
      event.preventDefault();
      goTo(order[Number(event.key) - 1]);
    } else if (event.shiftKey && (event.code === "BracketLeft" || event.code === "BracketRight")) {
      event.preventDefault();
      goTo(stepThread(order, activeThread, event.code === "BracketRight" ? 1 : -1));
    } else if (key === "n") {
      if (workspaceStore().getState().aiOn()) {
        event.preventDefault();
        goTo(NORTH_STAR_THREAD);
      }
    } else if (event.shiftKey && key === "o") {
      const state = workspaceStore().getState();
      const course = selectCourse(state, courseRef);
      if (course && newThread) {
        event.preventDefault();
        newThread(course);
      }
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden">
      {sidebarOpen && <Sidebar onSearch={() => setPaletteOpen(true)} activeThread={activeThread} />}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <NoticeBar thread={pathname === "/inbox" ? INBOX_THREAD : activeThread} />
        <Outlet />
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <SettleToast />
    </div>
  );
}
