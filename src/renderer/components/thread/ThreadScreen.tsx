import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Layers, PanelRight, Plus } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import type { LmsRef, ThreadId } from "~/shared/domain/ids";
import {
  NORTH_STAR_THREAD,
  isChatThread,
  selectConversation,
  selectCourse,
  selectInboxRows,
  selectQueueRows,
  selectSchoolGap,
  selectThreadName,
  selectThreadUi,
} from "~/renderer/stores/selectors";
import type { Thread, ThreadUi } from "~/renderer/stores/types";
import { useAiOn, useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { EmptyState } from "../EmptyState";
import { SchoolBadge } from "../SchoolBadge";
import { SettledMark } from "../SettleAction";
import { ScreenHeader } from "../ScreenHeader";
import { SCREEN_ICON } from "../screenIcons";
import { DisconnectedNotice } from "../screens/DisconnectedNotice";
import { NoSchool } from "../screens/NoSchool";
import { Button, buttonVariants } from "../ui/button";
import { SetupRail, SetupScreen, useSetupStep } from "../setup/SetupScreen";
import { ChatTimeline } from "./ChatTimeline";
import { Composer } from "./Composer";
import { ConversationLead } from "./ConversationLead";
import { RationaleContext, ThreadActionsContext } from "./context";
import { PinnedQueue } from "./PinnedQueue";
import {
  filterRows,
  followWorkUrl,
  fromInboxRows,
  fromQueueRows,
  liveFilter,
  workViewKey,
  type WorkRow,
  type WorkView,
} from "./queue.logic";
import { ThreadPanel } from "./ThreadPanel";
import { useChange } from "./useChange";
import { useThreadWork } from "./useThreadWork";

const useWorkRows = (thread: Thread): readonly WorkRow[] => {
  const queue = useWorkspace((state) =>
    thread.kind === "queue" || thread.kind === "grading"
      ? selectQueueRows(state, thread.assignment ?? null, thread.kind === "grading")
      : null,
  );
  const inbox = useWorkspace((state) =>
    thread.kind === "messages" ? selectInboxRows(state) : null,
  );
  return useMemo(() => {
    if (queue) return fromQueueRows(queue);
    return inbox ? fromInboxRows(inbox.filter((row) => row.course.ref === thread.course)) : [];
  }, [queue, inbox, thread.course]);
};

/** Back and Forward come here, so this only shows what is there and drafts nothing. */
const showWorkView = (thread: Thread, rows: readonly WorkRow[], ui: ThreadUi, view: WorkView) => {
  const state = workspaceStore().getState();
  if ("row" in view) {
    state.setThreadUi(thread.id, {
      current: view.row,
      panel: ui.panel === "batch" ? null : ui.panel,
    });
    state.focusChange(thread.id, rows.find((row) => row.key === view.row)?.change?.id ?? null);
  } else if (view.view === "batch") {
    state.setThreadUi(thread.id, { panel: "batch", queueOpen: true });
  } else {
    state.setThreadUi(thread.id, { current: null, panel: null, queueOpen: true });
    state.focusChange(thread.id, null);
  }
};

/** Keeps the URL naming what the thread shows, so Back steps through the list, the batch and each row in turn. */
const useWorkUrl = (
  thread: Thread,
  rows: readonly WorkRow[],
  ui: ThreadUi,
  view: WorkView | null,
  reviewable: boolean,
) => {
  const url = useSearch({ from: "/threads/$threadId" });
  const navigate = useNavigate({ from: "/threads/$threadId" });
  const seen = useRef<string | null>(null);
  // The URL this screen last wrote arriving is not a move, or a second click before it lands would be undone.
  const wrote = useRef<string | null>(null);
  useEffect(() => {
    if (!view) return;
    const urlKey = workViewKey(url);
    const moved = urlKey !== seen.current && urlKey !== wrote.current;
    if (urlKey === wrote.current) wrote.current = null;
    seen.current = urlKey;
    const step = followWorkUrl(url, view, moved, reviewable);
    if (!step) return;
    if ("show" in step) return showWorkView(thread, rows, ui, step.show);
    wrote.current = workViewKey(step.write);
    // The entry keeps what it carried, such as the chat a handoff came from.
    void navigate({ search: step.write, replace: step.replace, state: true });
  }, [url, view, reviewable, thread, rows, ui, navigate]);
};

export function PanelToggle({
  thread,
  onToggle,
  panelOpen,
}: {
  thread: Thread;
  onToggle: () => void;
  panelOpen: boolean;
}) {
  const focused = useChange(thread.focus);
  return (
    <Button
      variant={panelOpen ? "selected" : "ghost-muted"}
      size="icon"
      aria-label={panelOpen ? "Close panel" : "Open panel"}
      title={panelOpen ? "Close panel (Esc)" : "Open panel. ⌘D opens the preview."}
      aria-pressed={panelOpen}
      disabled={!focused && !panelOpen}
      onClick={onToggle}
    >
      <PanelRight />
    </Button>
  );
}

const tokenWords = (tokens: number): string =>
  tokens < 1000 ? `${tokens} tokens` : `${(tokens / 1000).toFixed(1)}k tokens`;
const dollars = (usd: number): string => (usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`);

/** What Claude's runs in this thread used and cost (docs/electron-spec.md, AI). Absent until one reports. */
function ThreadSpend({ thread }: { thread: Thread }) {
  if (!thread.spend) return null;
  const { tokens, usd } = thread.spend;
  return (
    <span
      data-testid="thread-spend"
      title="Claude's usage in this thread, billed to your Anthropic key"
      className="whitespace-nowrap text-meta text-muted-foreground"
    >
      {tokenWords(tokens)} · {dollars(usd)}
    </span>
  );
}

function ThreadHeader({
  thread,
  onTogglePanel,
  panelOpen,
}: {
  thread: Thread;
  onTogglePanel: () => void;
  panelOpen: boolean;
}) {
  const course = useWorkspace((state) => selectCourse(state, thread.course));
  const name = useWorkspace((state) => selectThreadName(state, thread.id));
  const schoolName = useWorkspace(
    (state) => state.schools.find((school) => school.id === course?.school)?.name,
  );
  if (thread.kind === "north-star") {
    return (
      <ScreenHeader
        icon={SCREEN_ICON.northStar}
        title={name}
        heading={false}
        actions={<ThreadSpend thread={thread} />}
      />
    );
  }
  if (thread.kind === "north-star-chat") {
    return (
      <ScreenHeader
        icon={SCREEN_ICON.northStar}
        trail={
          <Link to="/threads/$threadId" params={{ threadId: NORTH_STAR_THREAD }}>
            North Star
          </Link>
        }
        title={name}
        actions={
          <>
            <ThreadSpend thread={thread} />
            <SettledMark thread={thread} />
            <Link
              to="/threads/$threadId"
              params={{ threadId: NORTH_STAR_THREAD }}
              title="New chat (⌘N)"
              data-slot="button"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              <Plus />
              New chat
            </Link>
          </>
        }
      />
    );
  }
  const icon = course ? SCREEN_ICON.course : thread.kind === "queue" ? SCREEN_ICON.due : Layers;
  const crumb = course ? (
    <Link to="/courses/$courseId" params={{ courseId: course.ref }}>
      {course.code}
    </Link>
  ) : thread.kind === "queue" ? (
    <Link to="/due">What's due</Link>
  ) : (
    "All courses"
  );
  return (
    <ScreenHeader
      icon={icon}
      trail={crumb}
      title={thread.kind === "setup" && course ? "Set up" : name}
      chip={
        course && (
          <>
            <SchoolBadge school={course.school} />
            {thread.kind === "setup" && (
              <span
                data-testid="setup-school"
                className="min-w-0 truncate text-meta text-muted-foreground"
              >
                {schoolName}
              </span>
            )}
          </>
        )
      }
      actions={
        <>
          <ThreadSpend thread={thread} />
          <SettledMark thread={thread} />
          {thread.kind === "announcement" && course && !panelOpen && (
            <Link
              to="/courses/$courseId/announcements"
              params={{ courseId: course.ref }}
              data-slot="button"
              className={buttonVariants({ variant: "ghost-muted", size: "sm" })}
            >
              Posted announcements
            </Link>
          )}
          <PanelToggle thread={thread} onToggle={onTogglePanel} panelOpen={panelOpen} />
        </>
      }
    />
  );
}

function ThreadView({ thread }: { thread: Thread }) {
  const stored = useWorkspace((state) => selectThreadUi(state, thread.id));
  const rows = useWorkRows(thread);
  const filter = liveFilter(rows, stored.queueFilter);
  const shown = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const { ui, actions, link, cursor, currentKey, panelVisible } = useThreadWork(
    thread,
    rows,
    shown,
  );
  const { setUi } = actions;
  useEffect(() => {
    if (filter !== stored.queueFilter) setUi({ queueFilter: filter });
  }, [filter, stored.queueFilter, setUi]);
  const hasQueue =
    thread.kind === "queue" || thread.kind === "grading" || thread.kind === "messages";
  const step = useSetupStep(thread);
  // A batch is reviewed against its rows, not against the one student the chat was last on, so the list gets the chat's room.
  const batching = hasQueue && panelVisible && ui.panel === "batch" && ui.queueOpen;
  // The list is a place to manage grading, AI or not. Chat only earns room once there is a draft to talk about.
  const browsing = hasQueue && ui.queueOpen && rows.length > 0 && currentKey === null;
  const view = useMemo<WorkView | null>(
    () =>
      !hasQueue
        ? null
        : batching
          ? { view: "batch" }
          : currentKey
            ? { row: currentKey }
            : { view: "list" },
    [hasQueue, batching, currentKey],
  );
  useWorkUrl(thread, rows, ui, view, actions.batch.length > 0);
  const hero = thread.kind === "north-star";
  const gap = useWorkspace(selectSchoolGap);
  const noSchool = thread.kind === "queue" ? gap : null;
  // A draft card quotes the message it answers. With no draft, as after a Discard, the conversation shows on its own.
  const conversation = useWorkspace((state) =>
    thread.kind === "messages" && thread.focus === null && currentKey
      ? selectConversation(state, currentKey as LmsRef<"conversation">)
      : null,
  );

  return (
    <ThreadActionsContext.Provider value={actions}>
      <RationaleContext.Provider value={link}>
        <div className="panel-host relative flex min-h-0 flex-1">
          <main data-testid="thread-main" className="flex h-full min-w-0 flex-1 flex-col">
            <ThreadHeader
              thread={thread}
              panelOpen={panelVisible}
              onTogglePanel={() => actions.setUi({ panel: panelVisible ? null : "source" })}
            />
            {noSchool ? (
              <>
                <DisconnectedNotice />
                <NoSchool gap={noSchool} />
              </>
            ) : (
              <>
                {hasQueue && (
                  <PinnedQueue
                    thread={thread}
                    ui={ui}
                    shown={shown}
                    cursor={cursor}
                    currentKey={currentKey}
                    batching={batching}
                    fill={batching || browsing}
                  />
                )}
                {step !== undefined && <SetupRail thread={thread} />}
                {!batching && !browsing && !hero && (
                  <ChatTimeline
                    thread={thread}
                    ui={ui}
                    panelOpen={panelVisible}
                    {...(conversation && {
                      lead: <ConversationLead thread={thread} conversation={conversation} />,
                    })}
                    {...(step === undefined
                      ? {}
                      : { screen: true, stickOn: step, trail: <SetupScreen thread={thread} /> })}
                  />
                )}
                {!browsing && <Composer thread={thread} batching={batching} hero={hero} />}
              </>
            )}
          </main>
          {panelVisible && <ThreadPanel thread={thread} ui={ui} />}
        </div>
      </RationaleContext.Provider>
    </ThreadActionsContext.Provider>
  );
}

export function ThreadScreen({ threadId }: { threadId: ThreadId }) {
  const thread = useWorkspace((state) => state.threads[threadId]);
  const ai = useAiOn();
  if (!thread) return <EmptyState title="This thread doesn't exist any more." />;
  if (!ai && isChatThread(thread)) return <EmptyState title="Chats need an AI key." />;
  return <ThreadView key={threadId} thread={thread} />;
}
