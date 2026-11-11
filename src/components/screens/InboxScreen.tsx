import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronLeft, Mail, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { LmsRef } from "~/domain/ids";
import type { Conversation } from "~/domain/lms";
import { cn } from "~/lib/utils";
import {
  INBOX_THREAD,
  selectConversation,
  selectInboxRows,
  selectThreadUi,
  type InboxRow,
} from "~/stores/selectors";
import type { RowKey, Thread, ThreadUi } from "~/stores/types";
import { useWorkspace, workspaceStore } from "~/stores/workspace";

import { EmptyState } from "../EmptyState";
import { SchoolBadge } from "../SchoolBadge";
import { ScreenHeader } from "../ScreenHeader";
import { SCREEN_ICON } from "../screenIcons";
import { StatusPill } from "../StatusPill";
import { ChatTimeline } from "../thread/ChatTimeline";
import { Composer } from "../thread/Composer";
import { ConversationLead } from "../thread/ConversationLead";
import { RationaleContext, ThreadActionsContext, useThreadActions } from "../thread/context";
import { SelectionBar } from "../thread/PinnedQueue";
import { fromConversationRows, type WorkRow } from "../thread/queue.logic";
import { ThreadPanel } from "../thread/ThreadPanel";
import { PanelToggle } from "../thread/ThreadScreen";
import { useThreadWork } from "../thread/useThreadWork";
import { Button } from "../ui/button";
import { CHIP, toggleState } from "../ui/toggle";
import type { SchoolFilter } from "./due.logic";
import {
  filterInbox,
  followInboxUrl,
  INBOX_STATUSES,
  messagingNotes,
  preview,
  statusCount,
  type InboxStatus,
} from "./inbox.logic";
import { FilterMenu, OVERFLOW_STATUS } from "./InboxFilterMenu";
import { markInboxOpened, showInInbox } from "./workLinks";

const store = () => workspaceStore().getState();

function ConversationRow({
  row,
  work,
  selected,
  current,
  cursor,
  drafting,
  onToggle,
}: {
  row: InboxRow;
  work: WorkRow;
  selected: boolean;
  current: boolean;
  cursor: boolean;
  drafting: boolean;
  onToggle: () => void;
}) {
  const { openRow } = useThreadActions();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (cursor) ref.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const { conversation, course, school } = row;
  return (
    <li
      ref={ref}
      data-row={conversation.ref}
      data-conversation={conversation.ref}
      data-current={current}
      data-unread={conversation.unread}
      className={cn(
        "focus-inset flex items-start gap-2 rounded-md py-row-y pr-row-end pl-row-x hover:bg-accent",
        current && "row-selected",
        cursor && "bg-accent",
      )}
    >
      <span className="flex h-5 flex-none items-center">
        <input
          type="checkbox"
          aria-label={`Select ${conversation.from}`}
          checked={selected}
          disabled={!work.open}
          onChange={onToggle}
          className="size-3.5 accent-primary"
        />
      </span>
      <button
        type="button"
        onClick={() => openRow(work)}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 truncate text-body", conversation.unread && "font-medium")}>
            {conversation.from}
          </span>
          {conversation.unread && (
            <span
              aria-label="Unread"
              title="Unread"
              className="size-1.5 flex-none rounded-full bg-info-foreground"
            />
          )}
          <span className="flex-1" />
          {drafting ? (
            <StatusPill tone="working" label="Drafting" />
          ) : (
            row.summary && <StatusPill tone={row.summary.tone} label={row.summary.label} />
          )}
        </span>
        <span className="mt-1 flex items-center gap-2">
          <SchoolBadge school={school} />
          <span className="flex-none text-meta text-secondary-label">{course.code}</span>
          <span className="min-w-[48px] flex-1 truncate text-meta text-secondary-label">
            {conversation.subject}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-meta text-muted-foreground">
          {preview(row)}
        </span>
      </button>
    </li>
  );
}

function ConversationPane({
  thread,
  ui,
  conversation,
  panelOpen,
  onTogglePanel,
  onClose,
}: {
  thread: Thread;
  ui: ThreadUi;
  conversation: Conversation;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onClose: () => void;
}) {
  const last = conversation.messages.at(-1);
  const state = workspaceStore().getState();
  return (
    <>
      <div
        data-testid="conversation-header"
        className="flex h-10 flex-none items-center gap-2 border-b border-border pr-2 pl-4"
      >
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label="Back to Messages"
          title="Back to Messages"
          onClick={onClose}
          data-inbox-back
          className="-ml-2"
        >
          <ChevronLeft />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-title">{conversation.subject}</h2>
        {!conversation.unread && last && !last.mine && (
          <Button
            variant="ghost-muted"
            size="icon"
            aria-label="Mark unread"
            title="Mark unread"
            onClick={() => state.setConversationRead(conversation.ref, false)}
          >
            <Mail />
          </Button>
        )}
        <PanelToggle thread={thread} onToggle={onTogglePanel} panelOpen={panelOpen} />
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label="Close conversation"
          title="Close conversation"
          onClick={onClose}
          data-inbox-close
        >
          <X />
        </Button>
      </div>
      <ChatTimeline
        key={conversation.ref}
        thread={thread}
        ui={ui}
        panelOpen={panelOpen}
        scoped
        quotedAbove
        lead={<ConversationLead thread={thread} conversation={conversation} />}
      />
      <Composer thread={thread} />
    </>
  );
}

function InboxView({ thread }: { thread: Thread }) {
  const inbox = useWorkspace(selectInboxRows);
  const [status, setStatus] = useState<InboxStatus>("all");
  const [school, setSchool] = useState<SchoolFilter>("all");
  const schools = useWorkspace((state) => state.schools);
  const current = useWorkspace((state) => selectThreadUi(state, thread.id).current);

  const rows = useMemo(() => fromConversationRows(inbox), [inbox]);
  // The one you have open stays, even after opening it stopped it being unread.
  const listed = useMemo(() => {
    const matching = new Set(filterInbox(inbox, status, school));
    return inbox.filter((row) => matching.has(row) || row.conversation.ref === current);
  }, [inbox, status, school, current]);
  const shown = useMemo(() => fromConversationRows(listed), [listed]);
  const { conversation: inUrl } = useSearch({ from: "/inbox" });
  const navigate = useNavigate({ from: "/inbox" });
  const onOpen = useCallback(
    (row: WorkRow) => {
      if (row.kind !== "conversation") return;
      markInboxOpened(row.key);
      if (row.key !== inUrl) void navigate({ search: { conversation: row.key } });
    },
    [inUrl, navigate],
  );
  const { ui, actions, link, cursor, currentKey, panelVisible } = useThreadWork(
    thread,
    rows,
    shown,
    onOpen,
  );
  const open = useWorkspace((state) =>
    currentKey ? selectConversation(state, currentKey as LmsRef<"conversation">) : null,
  );
  const notes = useWorkspace(
    useShallow((state) => messagingNotes(state.schools, (id) => state.capabilitiesFor(id))),
  );

  const toggle = (key: RowKey) =>
    actions.setUi({
      selected: ui.selected.includes(key)
        ? ui.selected.filter((other) => other !== key)
        : [...ui.selected, key],
    });
  const closeConversation = useCallback(() => {
    store().setThreadUi(thread.id, { current: null, panel: null });
    store().focusChange(thread.id, null);
  }, [thread.id]);
  const close = () => {
    closeConversation();
    void navigate({ search: {} });
  };

  const lastUrl = useRef(inUrl);
  useEffect(() => {
    const arrived = lastUrl.current === inUrl;
    lastUrl.current = inUrl;
    const { current } = selectThreadUi(store(), thread.id);
    const open = selectInboxRows(store()).find((row) => row.conversation.ref === current);
    const step = followInboxUrl(arrived, inUrl, open?.conversation.ref ?? null);
    if (!step) return;
    if ("write" in step) void navigate({ search: { conversation: step.write }, replace: true });
    else if (step.open) showInInbox(step.open);
    else closeConversation();
  }, [inUrl, navigate, thread.id, closeConversation]);

  return (
    <ThreadActionsContext.Provider value={actions}>
      <RationaleContext.Provider value={link}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScreenHeader icon={SCREEN_ICON.inbox} title="Messages" />
          <div className="inbox-row flex min-h-0 flex-1">
            <section
              data-testid="inbox-list"
              className="inbox-list flex w-[320px] flex-none flex-col border-r border-border"
            >
              <div className="flex flex-none items-center gap-1 border-b border-border px-2 py-2">
                <div role="group" aria-label="Filter by status" className="flex gap-1">
                  {INBOX_STATUSES.filter((option) => option.status !== OVERFLOW_STATUS).map(
                    (option) => (
                      <button
                        key={option.status}
                        type="button"
                        aria-pressed={status === option.status}
                        onClick={() => setStatus(option.status)}
                        className={cn(CHIP, "gap-1 px-1.5", toggleState(status === option.status))}
                      >
                        {option.label}
                        <span className="tabular-nums text-tertiary-label">
                          {statusCount(inbox, option.status)}
                        </span>
                      </button>
                    ),
                  )}
                </div>
                {schools.length > 1 && (
                  <div role="group" aria-label="Filter by school" className="flex gap-1">
                    {schools.map((one) => (
                      <button
                        key={one.id}
                        type="button"
                        aria-pressed={school === one.id}
                        onClick={() => setSchool(school === one.id ? "all" : one.id)}
                        className={cn(CHIP, "px-1.5", toggleState(school === one.id))}
                      >
                        {one.abbr}
                      </button>
                    ))}
                  </div>
                )}
                <FilterMenu
                  status={status}
                  onStatus={setStatus}
                  waiting={statusCount(inbox, OVERFLOW_STATUS)}
                />
              </div>
              {notes.map((note) => (
                <p
                  key={note}
                  data-testid="messaging-note"
                  className="flex-none border-b border-border px-3 py-2 text-meta text-secondary-label"
                >
                  {note}
                </p>
              ))}
              <ul
                data-testid="conversation-list"
                className="min-h-0 flex-1 overflow-y-auto px-2 py-1"
              >
                {listed.length === 0 && (
                  <li className="px-3 py-3 text-center text-meta text-muted-foreground">
                    Nothing in this view.
                  </li>
                )}
                {listed.map((row, index) => {
                  const work = shown[index];
                  return (
                    work && (
                      <ConversationRow
                        key={row.conversation.ref}
                        row={row}
                        work={work}
                        selected={ui.selected.includes(work.key)}
                        current={work.key === currentKey}
                        cursor={index === cursor}
                        drafting={actions.drafting.has(work.key)}
                        onToggle={() => toggle(work.key)}
                      />
                    )
                  );
                })}
              </ul>
              {ui.selected.length > 0 && (
                <SelectionBar rows={rows} selected={ui.selected} batching={ui.panel === "batch"} />
              )}
            </section>
            <div className="inbox-pane panel-host relative flex min-w-0 flex-1">
              <main data-testid="thread-main" className="flex h-full min-w-0 flex-1 flex-col">
                {open ? (
                  <ConversationPane
                    thread={thread}
                    ui={ui}
                    conversation={open}
                    panelOpen={panelVisible}
                    onTogglePanel={() => actions.setUi({ panel: panelVisible ? null : "source" })}
                    onClose={close}
                  />
                ) : (
                  <EmptyState title="Pick a conversation to read it and reply." />
                )}
              </main>
              {panelVisible && <ThreadPanel thread={thread} ui={ui} />}
            </div>
          </div>
        </div>
      </RationaleContext.Provider>
    </ThreadActionsContext.Provider>
  );
}

export function InboxScreen() {
  const thread = useWorkspace((state) => state.threads[INBOX_THREAD]);
  if (!thread) return <EmptyState title="Messages aren't ready yet." />;
  return <InboxView thread={thread} />;
}
