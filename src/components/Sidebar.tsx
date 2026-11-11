import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, CircleCheck, History, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import type { LmsRef, SchoolId, ThreadId } from "~/domain/ids";
import type { Course, School } from "~/domain/lms";
import { shellContents } from "~/domain/setup";
import { cn } from "~/lib/utils";
import {
  NORTH_STAR_THREAD,
  selectCourseWaiting,
  selectSchoolWaiting,
  selectSetupOffers,
  selectThreadName,
  selectThreadStatus,
  selectUnreadCount,
  withoutChatThreads,
  type SetupOffer,
} from "~/stores/selectors";
import type { Thread } from "~/stores/types";
import { useAiOn, useWorkspace, workspaceStore, type WorkspaceState } from "~/stores/workspace";

import { Brand, SchoolStar } from "./Brand";
import { SCREEN_ICON } from "./screenIcons";
import { RowAction, SettledArea, SweepChip, openSettled, useRowAction } from "./SettleAction";
import { useStartSetup } from "./setup/Offers";
import { STATUS_VIEW, connectionStatus } from "./settings/connection.logic";
import { CompactStatus, StatusPill } from "./StatusPill";
import { TokenDialog } from "./TokenDialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import {
  ROW,
  chatsNewestFirst,
  courseChoiceAfterToggle,
  courseRows,
  describeWaiting,
  isInCourse,
  keptChat,
  onCoursePages,
  setupGroupKey,
  setupGroupLabel,
  settledNewestFirst,
  sidebarJumpOrder,
  visibleThreads,
} from "./sidebar.logic";
import { useNewThread } from "./useNewThread";

// The school's own status line already says its token ran out, so its threads don't each repeat it.
const WAITS_ON_SCHOOL = /reconnect/i;

const schoolStatus = (state: WorkspaceState, school: SchoolId) =>
  connectionStatus(state.connections[school], Boolean(state.syncing[school]));

const toggleSchool = (school: SchoolId) => {
  const { prefs, setPrefs } = workspaceStore().getState();
  const { [school]: wasCollapsed, ...rest } = prefs.collapsed;
  setPrefs({ collapsed: wasCollapsed ? rest : { ...prefs.collapsed, [school]: true } });
};

const toggleCourse = (course: LmsRef<"course">, inCourse: boolean) => {
  const { prefs, setPrefs } = workspaceStore().getState();
  const { [course]: choice, ...rest } = prefs.courseOpen ?? {};
  const next = courseChoiceAfterToggle(choice, inCourse);
  setPrefs({ courseOpen: next === undefined ? rest : { ...rest, [course]: next } });
};

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        "size-3 flex-none text-muted-foreground transition-transform duration-100",
        open && "rotate-90",
      )}
    />
  );
}

function ThreadRow({
  thread,
  jump,
  active,
  railSelected = false,
  reveal = false,
  handedOff = false,
  icon,
}: {
  thread: Thread;
  jump: number | null;
  active: boolean;
  railSelected?: boolean;
  reveal?: boolean;
  handedOff?: boolean;
  icon?: ReactNode;
}) {
  const status = useWorkspace(useShallow((state) => selectThreadStatus(state, thread.id)));
  const name = useWorkspace((state) => selectThreadName(state, thread.id));
  const row = useRowAction(thread, "settle");
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (reveal) link.current?.scrollIntoView({ block: "nearest" });
  }, [reveal]);
  return (
    <li className="group/row relative" {...row.li}>
      <Link
        ref={link}
        to="/threads/$threadId"
        params={{ threadId: thread.id }}
        aria-current={active ? "true" : undefined}
        title={name}
        data-rail-selected={railSelected || undefined}
        className={cn(ROW, active && "row-selected", row.link)}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate rail:sr-only">{name}</span>
        {handedOff && (
          <span
            data-testid="handed-off-mark"
            title="The open thread came from this chat"
            className={cn(
              "jump-hide flex-none text-meta text-muted-foreground rail:hidden",
              row.status,
            )}
          >
            Handed off
          </span>
        )}
        {status && !WAITS_ON_SCHOOL.test(status.label) && (
          <CompactStatus {...status} className={cn("jump-hide rail:hidden", row.status)} />
        )}
        {row.swept && <SweepChip verb="settle" />}
        {jump !== null && (
          <span className="jump-number rounded border border-input bg-popover px-1 text-meta text-foreground">
            ⌘{jump}
          </span>
        )}
      </Link>
      <RowAction thread={thread} verb="settle" />
    </li>
  );
}

function ScreenRow({
  to,
  icon,
  title,
  tooltip = title,
  trailing,
  active,
}: {
  to: "/due" | "/inbox" | "/calendar";
  icon: ReactNode;
  title: string;
  tooltip?: string;
  trailing?: ReactNode;
  active: boolean;
}) {
  return (
    <li>
      <Link to={to} title={tooltip} className={cn(ROW, "relative", active && "row-selected")}>
        {icon}
        <span className="min-w-0 flex-1 truncate rail:sr-only">{title}</span>
        {trailing}
      </Link>
    </li>
  );
}

// A rail dot sits on its icon's top-right corner, so it reads as part of the glyph. Its colour is its meaning: blue unread, amber waiting on you.
const RAIL_DOT = "absolute top-1.5 left-[calc(50%+3px)] size-1.5 rounded-full";

const schoolRail = (school: SchoolId) => ({
  borderLeftColor: `color-mix(in srgb, var(--school-${school}, var(--border)) 22%, transparent)`,
});

function ThreadList({
  threads,
  expandKey,
  school,
  order,
  activeThread,
  kept = activeThread,
}: {
  threads: readonly Thread[];
  expandKey: string;
  school?: SchoolId;
  order: readonly ThreadId[];
  activeThread: ThreadId | null;
  kept?: ThreadId | null;
}) {
  const showAll = useWorkspace((state) => Boolean(state.prefs.expandedThreads[expandKey]));
  const entries = visibleThreads(threads, kept, showAll);
  const showMore = () => {
    const { prefs, setPrefs } = workspaceStore().getState();
    setPrefs({ expandedThreads: { ...prefs.expandedThreads, [expandKey]: true } });
  };
  return (
    <ul className={school && "ml-[13px] border-l pl-1.5"} style={school && schoolRail(school)}>
      {entries.map((entry) => {
        if ("more" in entry)
          return (
            <li key={`more-${entry.more[0]?.id}`}>
              <button
                type="button"
                onClick={showMore}
                className={cn(ROW, "text-meta text-muted-foreground")}
              >
                Show {entry.more.length} more
              </button>
            </li>
          );
        const position = order.indexOf(entry.id);
        const handedOff = entry.id === kept && kept !== activeThread;
        return (
          <ThreadRow
            key={entry.id}
            thread={entry}
            jump={position >= 0 ? position + 1 : null}
            active={entry.id === activeThread}
            reveal={handedOff}
            handedOff={handedOff}
          />
        );
      })}
    </ul>
  );
}

function CourseGroup({
  course,
  threads,
  order,
  activeThread,
  pathname,
}: {
  course: Course;
  threads: readonly Thread[];
  order: readonly ThreadId[];
  activeThread: ThreadId | null;
  pathname: string;
}) {
  const choice = useWorkspace((state) => state.prefs.courseOpen?.[course.ref]);
  const waiting = describeWaiting(
    useWorkspace(useShallow((state) => selectCourseWaiting(state, course.ref))),
  );
  const newThread = useNewThread();
  const onCourse = onCoursePages(course.ref, pathname);
  const inCourse = isInCourse(course.ref, threads, activeThread, pathname);
  const open = choice ?? inCourse;
  const name = `${course.code} ${course.title}`;
  const described = waiting.count > 0 ? `${name}. ${waiting.label}` : name;
  return (
    <div>
      <div className="group/course relative flex items-center">
        <button
          type="button"
          onClick={() => toggleCourse(course.ref, inCourse)}
          aria-label={`${open ? "Collapse" : "Expand"} ${course.code}`}
          aria-expanded={open}
          className="absolute left-0.5 z-[1] flex h-btn-sm w-[18px] items-center justify-center"
        >
          <Chevron open={open} />
        </button>
        <Link
          to="/courses/$courseId"
          params={{ courseId: course.ref }}
          title={described}
          aria-label={described}
          className={cn(ROW, "pl-5.25 text-foreground", onCourse && "row-selected")}
        >
          <span className="text-meta font-medium whitespace-nowrap">{course.code}</span>
          <span className="min-w-0 flex-1 truncate text-meta text-secondary-label">
            {course.title}
          </span>
          {waiting.count > 0 && (
            <CompactStatus
              tone={waiting.tone}
              label={waiting.label}
              className={cn(newThread && "group-hover/course:invisible")}
            />
          )}
        </Link>
        {newThread && (
          <button
            type="button"
            onClick={() => newThread(course)}
            aria-label={`New thread in ${course.code}`}
            title={`New thread in ${course.code}`}
            className="absolute right-0 hidden size-btn-sm items-center justify-center rounded bg-popover text-muted-foreground group-hover/course:flex hover:text-foreground focus-visible:flex"
          >
            <Plus className="size-3" />
          </button>
        )}
      </div>
      {open && (
        <ThreadList
          threads={threads}
          expandKey={course.ref}
          school={course.school}
          order={order}
          activeThread={activeThread}
        />
      )}
    </div>
  );
}

function OfferRow({
  offer: { shell, thread, words },
  activeThread,
}: {
  offer: SetupOffer;
  activeThread: ThreadId | null;
}) {
  const start = useStartSetup();
  const active = thread !== null && thread === activeThread;
  return (
    <li
      data-testid="setup-offer"
      data-surface="sidebar"
      data-course={shell.ref}
      aria-current={active}
    >
      <button
        type="button"
        title={`${shell.code} ${shell.title}, ${shell.termName}. ${words}.`}
        onClick={() => start(shell.ref)}
        className={cn(ROW, "group/offer", thread ? "pl-5.25" : "", active && "row-selected")}
      >
        {thread && <span className="text-meta whitespace-nowrap text-secondary-label">Set up</span>}
        <span className="text-meta font-medium whitespace-nowrap text-foreground">
          {shell.code}
        </span>
        <span className="min-w-0 flex-1 truncate text-meta text-secondary-label">
          {thread ? words : shellContents(shell)}
        </span>
        {!thread && (
          <span className="text-meta whitespace-nowrap text-muted-foreground opacity-0 group-hover/offer:opacity-100 group-focus-visible/offer:opacity-100 [@media(hover:none)]:opacity-100">
            Set up
          </span>
        )}
      </button>
    </li>
  );
}

export function SidebarOffers({
  school,
  activeThread,
}: {
  school: SchoolId;
  activeThread: ThreadId | null;
}) {
  const offers = useWorkspace(selectSetupOffers).filter((offer) => offer.school.id === school);
  const key = setupGroupKey(school);
  const open = useWorkspace((state) => Boolean(state.prefs.expandedThreads[key]));
  const dismissed = useWorkspace((state) => state.prefs.offersDismissed);
  const started = offers.filter((offer) => offer.thread !== null);
  const waiting = offers.filter((offer) => offer.thread === null && !dismissed?.[offer.shell.ref]);
  const toggle = () => {
    const { prefs, setPrefs } = workspaceStore().getState();
    const { [key]: _open, ...rest } = prefs.expandedThreads;
    setPrefs({ expandedThreads: open ? rest : { ...rest, [key]: true } });
  };
  return (
    <>
      {started.length > 0 && (
        <ul>
          {started.map((offer) => (
            <OfferRow key={offer.shell.ref} offer={offer} activeThread={activeThread} />
          ))}
        </ul>
      )}
      {waiting.length > 0 && (
        <>
          <button
            type="button"
            data-testid="setup-offers-toggle"
            data-offers-school={school}
            aria-expanded={open}
            title={waiting.map((offer) => offer.shell.code).join(", ")}
            onClick={toggle}
            className={cn(ROW, "relative pl-5.25 text-meta text-muted-foreground")}
          >
            <span className="absolute left-0.5 flex w-[18px] justify-center">
              <Chevron open={open} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {setupGroupLabel(waiting.map((offer) => offer.shell))}
            </span>
          </button>
          {open && (
            <ul className="ml-[13px] border-l pl-1.5" style={schoolRail(school)}>
              {waiting.map((offer) => (
                <OfferRow key={offer.shell.ref} offer={offer} activeThread={activeThread} />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function SchoolGroup({
  school,
  courses,
  threadsOf,
  order,
  activeThread,
  pathname,
}: {
  school: School;
  courses: readonly Course[];
  threadsOf: (course: LmsRef<"course">) => readonly Thread[];
  order: readonly ThreadId[];
  activeThread: ThreadId | null;
  pathname: string;
}) {
  const status = useWorkspace((state) => schoolStatus(state, school.id));
  const collapsed = useWorkspace((state) => Boolean(state.prefs.collapsed[school.id]));
  const waiting = describeWaiting(
    useWorkspace(useShallow((state) => selectSchoolWaiting(state, school.id))),
  );
  const [connecting, setConnecting] = useState(false);
  const view = STATUS_VIEW[status];
  const described = [
    school.name,
    school.host,
    view.label,
    ...(waiting.count > 0 ? [waiting.label] : []),
  ].join(". ");
  return (
    <div className="mt-3 rail:hidden">
      <button
        type="button"
        onClick={() => toggleSchool(school.id)}
        aria-expanded={!collapsed}
        title={described}
        aria-label={described}
        data-testid="school-row"
        data-connection={status}
        data-attention={view.needsAttention}
        className={cn(ROW, "gap-1 text-meta font-medium text-foreground")}
      >
        <Chevron open={!collapsed} />
        <SchoolStar school={school.id} />
        <span className="min-w-0 flex-1 truncate">{school.name}</span>
        {status === "syncing" && (
          <Badge tone={view.badge}>
            <span className="dot-pulse size-1.5 rounded-full bg-current" />
            {view.label}
          </Badge>
        )}
        {collapsed && waiting.count > 0 && (
          <span className="text-meta text-muted-foreground tabular-nums">{waiting.count}</span>
        )}
      </button>
      {/* Syncing comes and goes on its own, so it rides the header; a row appearing above the courses would move them under the pointer. */}
      {status !== "connected" && status !== "syncing" && (
        <div className="flex h-btn-sm items-center gap-2 pl-5.25">
          <Badge tone={view.badge} icon={view.icon}>
            {view.label}
          </Badge>
          {view.needsToken && (
            <Button
              variant="ghost-info"
              size="meta"
              data-testid={status === "expired" ? "school-reconnect" : undefined}
              aria-label={`${view.label}. Reconnect ${school.name}`}
              onClick={() => setConnecting(true)}
              className="ml-auto"
            >
              Reconnect
            </Button>
          )}
        </div>
      )}
      {!collapsed &&
        courses.map((course) => (
          <CourseGroup
            key={course.ref}
            course={course}
            threads={threadsOf(course.ref)}
            order={order}
            activeThread={activeThread}
            pathname={pathname}
          />
        ))}
      {!collapsed && <SidebarOffers school={school.id} activeThread={activeThread} />}
      <TokenDialog school={school.id} open={connecting} onOpenChange={setConnecting} />
    </div>
  );
}

/** The rows ⌘1 to ⌘9 address, in sidebar order. Shared with the shell's keyboard handler. */
export const useJumpOrder = (activeThread: ThreadId | null): readonly ThreadId[] => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const fromChat = useRouterState({ select: (state) => state.location.state.fromChat });
  return useWorkspace(
    useShallow((state) => sidebarJumpOrder(state, state.aiOn(), activeThread, pathname, fromChat)),
  );
};

export function Sidebar({
  onSearch,
  activeThread,
}: {
  onSearch: () => void;
  activeThread: ThreadId | null;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Below 1280px the sidebar is an icon rail, and expanding lays the full sidebar over the page until the next navigation.
  const [expandedOn, setExpandedOn] = useState<string | null>(null);
  if (expandedOn !== null && expandedOn !== pathname) setExpandedOn(null);
  const expanded = expandedOn === pathname;
  const opener = useRef<HTMLButtonElement | null>(null);
  const aside = useRef<HTMLElement>(null);
  // A rail item hides once the sidebar is expanded, so focus moves to what it opened rather than dropping to the page, and Escape hands it back.
  const expandTo = (item: HTMLButtonElement, target: string) => {
    opener.current = item;
    flushSync(() => setExpandedOn(pathname));
    aside.current?.querySelector<HTMLElement>(target)?.focus();
  };
  const schools = useWorkspace((state) => state.schools);
  const awaitingApproval = useWorkspace((state) =>
    state.schools.some((school) => selectSchoolWaiting(state, school.id).approval > 0),
  );
  const unconnected = useWorkspace((state) =>
    state.schools.some((school) => STATUS_VIEW[schoolStatus(state, school.id)].needsToken),
  );
  const threads = useWorkspace(useShallow((state) => Object.values(state.threads)));
  const ai = useAiOn();
  const cache = useWorkspace((state) => state.cache);
  const unread = useWorkspace(selectUnreadCount);
  const order = useJumpOrder(activeThread);
  const fromChat = useRouterState({ select: (state) => state.location.state.fromChat });
  const chatKept = useWorkspace((state) => keptChat(state, activeThread, fromChat));
  const northStar = withoutChatThreads(threads, ai).find((thread) => thread.kind === "north-star");
  const chats = chatsNewestFirst(withoutChatThreads(threads, ai));
  const onGradingList = threads.some(
    (thread) => thread.id === activeThread && thread.kind === "queue",
  );
  const threadsOf = (course: LmsRef<"course">) => courseRows(threads, course, ai);
  const settled = settledNewestFirst(threads, ai);
  const anySettled = settled.length > 0;
  const activeSettled = settled.some((thread) => thread.id === activeThread);
  const settingsLabel = unconnected ? "Settings. A school is not connected" : "Settings";
  const coursesLabel = awaitingApproval ? "Courses. Work needs your approval" : "Courses";

  return (
    <>
      {expanded && (
        <div
          data-testid="sidebar-scrim"
          aria-hidden
          onClick={() => setExpandedOn(null)}
          className="fade-in fixed inset-0 z-20 bg-black/50 xl:hidden"
        />
      )}
      <aside
        ref={aside}
        data-testid="sidebar"
        data-rail={expanded ? undefined : ""}
        onKeyDown={(event) => {
          if (!expanded || event.key !== "Escape") return;
          event.stopPropagation();
          flushSync(() => setExpandedOn(null));
          opener.current?.focus();
        }}
        className={cn(
          "flex w-72 flex-none flex-col border-r border-border bg-sidebar max-xl:w-12",
          expanded && "max-xl:relative max-xl:z-30 max-xl:-mr-52 max-xl:w-64 max-xl:shadow-drawer",
        )}
      >
        <div className="flex h-10 flex-none items-center px-3 rail:h-auto rail:flex-col rail:gap-2 rail:px-0 rail:pt-2.5 rail:pb-2">
          <Brand />
        </div>
        <div className="flex-none px-2 pb-2">
          <button
            type="button"
            onClick={onSearch}
            title="Search threads and students (⌘K)"
            className={ROW}
          >
            <Search className="size-3.5 flex-none text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground rail:sr-only">
              Search threads and students
            </span>
            <Kbd className="rail:hidden">⌘K</Kbd>
          </button>
        </div>
        <div className="flex-none border-b border-border px-2 pb-2 rail:space-y-2">
          {northStar && (
            <ul>
              <ThreadRow
                thread={northStar}
                jump={order.indexOf(northStar.id) + 1 || null}
                active={northStar.id === activeThread}
                railSelected={chats.some((chat) => chat.id === activeThread)}
                icon={
                  <SCREEN_ICON.northStar className="size-3.5 flex-none text-muted-foreground" />
                }
              />
            </ul>
          )}
          <ul className="rail:space-y-2">
            <ScreenRow
              to="/due"
              title="What's due"
              active={pathname === "/due" || onGradingList}
              icon={<SCREEN_ICON.due className="size-3.5 flex-none text-muted-foreground" />}
            />
            <ScreenRow
              to="/inbox"
              title="Messages"
              tooltip={unread > 0 ? `Messages, ${unread} unread` : "Messages"}
              active={pathname === "/inbox"}
              icon={<SCREEN_ICON.inbox className="size-3.5 flex-none text-muted-foreground" />}
              trailing={
                unread > 0 && (
                  <>
                    <StatusPill tone="unread" label={`${unread} unread`} className="rail:sr-only" />
                    <span
                      aria-hidden
                      data-testid="sidebar-unread-count"
                      className={cn(RAIL_DOT, "hidden bg-info-foreground rail:block")}
                    />
                  </>
                )
              }
            />
            <ScreenRow
              to="/calendar"
              title="Calendar"
              active={pathname === "/calendar"}
              icon={<SCREEN_ICON.calendar className="size-3.5 flex-none text-muted-foreground" />}
            />
            <li className="hidden rail:block">
              <button
                type="button"
                data-testid="rail-courses"
                aria-label={coursesLabel}
                aria-expanded={false}
                title={coursesLabel}
                onClick={(event) => expandTo(event.currentTarget, '[data-testid="school-row"]')}
                className={cn(ROW, "relative")}
              >
                <SCREEN_ICON.course className="size-3.5 flex-none text-muted-foreground" />
                {awaitingApproval && (
                  <span
                    data-testid="rail-courses-dot"
                    className={cn(RAIL_DOT, "bg-warning-foreground")}
                  />
                )}
              </button>
            </li>
            {chats.length > 0 && (
              <li className="hidden rail:block">
                <button
                  type="button"
                  aria-label="Chats"
                  aria-expanded={false}
                  title="Chats"
                  onClick={(event) =>
                    expandTo(event.currentTarget, '[data-testid="sidebar-chats"] a')
                  }
                  className={ROW}
                >
                  <History className="size-3.5 flex-none text-muted-foreground" />
                </button>
              </li>
            )}
          </ul>
        </div>
        <div data-testid="sidebar-list" className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
          {schools.map((school) => (
            <SchoolGroup
              key={school.id}
              school={school}
              courses={cache[school.id]?.courses ?? []}
              threadsOf={threadsOf}
              order={order}
              activeThread={activeThread}
              pathname={pathname}
            />
          ))}
          {chats.length > 0 && (
            <section data-testid="sidebar-chats" className="mt-3 rail:hidden">
              <h2 className="flex h-btn-sm items-center pl-2 text-meta font-medium text-foreground">
                Chats
              </h2>
              <ThreadList
                threads={chats}
                expandKey={NORTH_STAR_THREAD}
                order={order}
                activeThread={activeThread}
                kept={chatKept}
              />
            </section>
          )}
        </div>
        {anySettled && (
          <div className="hidden flex-none border-t border-border px-2 py-1 rail:block">
            <button
              type="button"
              data-testid="rail-settled"
              aria-label="Settled"
              aria-expanded={false}
              title="Settled"
              data-rail-selected={activeSettled || undefined}
              onClick={(event) => {
                flushSync(openSettled);
                expandTo(event.currentTarget, '[data-testid="settled-area"] li a');
              }}
              className={ROW}
            >
              <CircleCheck className="size-3.5 flex-none text-muted-foreground" />
            </button>
          </div>
        )}
        <SettledArea activeThread={activeThread} />
        <div className="flex h-10 flex-none items-center border-t border-border px-2">
          <Link
            to="/settings"
            title={settingsLabel}
            aria-label={settingsLabel}
            className={cn(ROW, "relative", pathname === "/settings" && "row-selected")}
          >
            <SCREEN_ICON.settings className="size-3.5 flex-none text-muted-foreground" />
            <span className="rail:sr-only">Settings</span>
            {unconnected && (
              <span
                data-testid="sidebar-warning-dot"
                className="ml-auto size-1.5 flex-none rounded-full bg-error-foreground rail:absolute rail:top-1.5 rail:left-[calc(50%+3px)] rail:ml-0"
              />
            )}
          </Link>
        </div>
      </aside>
    </>
  );
}
