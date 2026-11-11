import type { CourseShell } from "~/domain/content";
import type { LmsRef, SchoolId, ThreadId } from "~/domain/ids";
import {
  NORTH_STAR_THREAD,
  isSettled,
  withoutChatThreads,
  type ThreadStatus,
  type Waiting,
} from "~/stores/selectors";
import type { Thread, WorkspaceData } from "~/stores/types";

export const ROW =
  "flex h-btn-sm w-full min-w-0 items-center gap-2 rounded-md pr-3 pl-2 text-left text-body text-secondary-label hover:bg-accent hover:text-foreground focus-inset rail:justify-center rail:px-0";

const VISIBLE_THREADS = 3;

export const onCoursePages = (course: LmsRef<"course">, pathname: string): boolean => {
  const base = `/courses/${encodeURIComponent(course)}`;
  return pathname === base || pathname.startsWith(`${base}/`);
};

export const isInCourse = (
  course: LmsRef<"course">,
  threads: readonly Thread[],
  active: ThreadId | null,
  pathname: string,
): boolean =>
  onCoursePages(course, pathname) ||
  threads.some((thread) => thread.id === active && thread.course === course);

export const courseChoiceAfterToggle = (
  choice: boolean | undefined,
  inCourse: boolean,
): boolean | undefined => {
  const next = !(choice ?? inCourse);
  return next === inCourse ? undefined : next;
};

/** A row of a sidebar list: a thread, or the one "Show N more" that ends the list and counts its N hidden threads. */
export type ListEntry = Thread | { more: readonly Thread[] };

/** The first few threads of a list, and always the kept one, in list order, so a selected thread never hides, then one "Show N more" for the rest. */
export const visibleThreads = (
  all: readonly Thread[],
  kept: ThreadId | null,
  showAll: boolean,
): readonly ListEntry[] => {
  if (showAll || all.length <= VISIBLE_THREADS) return all;
  const keptAt = all.findIndex((thread) => thread.id === kept);
  const top = keptAt >= VISIBLE_THREADS ? VISIBLE_THREADS - 1 : VISIBLE_THREADS;
  const shown = (thread: Thread, at: number) => at < top || at === keptAt;
  return [...all.filter(shown), { more: all.filter((thread, at) => !shown(thread, at)) }];
};

const threadsIn = (entries: readonly ListEntry[]): readonly Thread[] =>
  entries.filter((entry): entry is Thread => !("more" in entry));

/** The chat the Chats list keeps past its cutoff: the active one, or a chat that handed off to the active thread. That is the chat whose card opened it, else the latest. */
export const keptChat = (
  state: Pick<WorkspaceData, "threads">,
  active: ThreadId | null,
  fromChat?: ThreadId,
): ThreadId | null => {
  const handedOffBy =
    (active &&
      state.threads[active]?.messages.flatMap((message) =>
        message.type === "handed-off" ? [message.from] : [],
      )) ||
    [];
  if (fromChat && handedOffBy.includes(fromChat)) return fromChat;
  return handedOffBy.at(-1) ?? active;
};

export const chatsNewestFirst = (threads: readonly Thread[]): readonly Thread[] => {
  const startedAt = (thread: Thread) => thread.messages[0]?.at ?? thread.updatedAt;
  return threads
    .filter((thread) => thread.kind === "north-star-chat" && !isSettled(thread))
    .sort((a, b) => startedAt(b).localeCompare(startedAt(a)));
};

const WAITING_MOST_URGENT_FIRST: readonly {
  kind: keyof Waiting;
  tone: ThreadStatus["tone"];
  words: (n: number) => string;
}[] = [
  {
    kind: "attention",
    tone: "attention",
    words: (n) => `${n} ${n === 1 ? "needs" : "need"} attention`,
  },
  { kind: "ready", tone: "ready", words: (n) => `${n} ready to send` },
  {
    kind: "approval",
    tone: "approval",
    words: (n) => `${n} ${n === 1 ? "needs" : "need"} approval`,
  },
  { kind: "unread", tone: "unread", words: (n) => `${n} unread` },
  { kind: "grade", tone: "todo", words: (n) => `${n} to grade` },
];

export const describeWaiting = (waiting: Waiting): ThreadStatus & { count: number } => {
  const parts = WAITING_MOST_URGENT_FIRST.filter(({ kind }) => waiting[kind] > 0);
  const count = parts.reduce((total, { kind }) => total + waiting[kind], 0);
  const words = parts.map(({ kind, words }) => words(waiting[kind]));
  return {
    count,
    tone: parts[0]?.tone ?? "todo",
    label:
      parts.length > 1 ? `${count} need you: ${words.join(", ")}` : (words[0] ?? "Nothing waiting"),
  };
};

export const setupGroupLabel = (shells: readonly Pick<CourseShell, "termName">[]): string => {
  const terms = new Set(shells.map((shell) => shell.termName));
  const term = terms.size === 1 ? `${shells[0]?.termName} ` : "";
  return `${shells.length} ${term}${shells.length === 1 ? "course" : "courses"} to set up`;
};

export const setupGroupKey = (school: SchoolId): string => `setup:${school}`;

/** ⌘1 to ⌘9 walk this list, and the sidebar numbers its rows from it, so the two can't disagree. */
export const jumpOrder = (
  groups: readonly { collapsed: boolean; threads: readonly Thread[] }[],
): readonly ThreadId[] =>
  groups
    .filter((group) => !group.collapsed)
    .flatMap((group) => group.threads.map((thread) => thread.id))
    .slice(0, 9);

export const courseRows = (
  threads: readonly Thread[],
  course: LmsRef<"course">,
  ai: boolean,
): readonly Thread[] =>
  withoutChatThreads(
    threads.filter((thread) => thread.course === course && !isSettled(thread)),
    ai,
  );

export const settledNewestFirst = (threads: readonly Thread[], ai: boolean): readonly Thread[] =>
  withoutChatThreads(threads.filter(isSettled), ai).toSorted((a, b) =>
    (b.settledAt ?? "").localeCompare(a.settledAt ?? ""),
  );

export const sidebarJumpOrder = (
  state: WorkspaceData,
  ai: boolean,
  activeThread: ThreadId | null,
  pathname: string,
  fromChat?: ThreadId,
): readonly ThreadId[] => {
  const threads = withoutChatThreads(Object.values(state.threads), ai);
  const courses = state.schools.flatMap((school) =>
    state.prefs.collapsed[school.id] ? [] : (state.cache[school.id]?.courses ?? []),
  );
  return jumpOrder([
    { collapsed: false, threads: threads.filter((thread) => thread.kind === "north-star") },
    ...courses.map((course) => {
      const own = courseRows(threads, course.ref, ai);
      return {
        collapsed: !(
          state.prefs.courseOpen?.[course.ref] ??
          isInCourse(course.ref, own, activeThread, pathname)
        ),
        threads: threadsIn(
          visibleThreads(own, activeThread, Boolean(state.prefs.expandedThreads[course.ref])),
        ),
      };
    }),
    {
      collapsed: false,
      threads: threadsIn(
        visibleThreads(
          chatsNewestFirst(threads),
          keptChat(state, activeThread, fromChat),
          Boolean(state.prefs.expandedThreads[NORTH_STAR_THREAD]),
        ),
      ),
    },
  ]);
};

export const stepThread = (
  order: readonly ThreadId[],
  current: ThreadId | null,
  delta: 1 | -1,
): ThreadId | null => {
  if (order.length === 0) return null;
  const index = current ? order.indexOf(current) : -1;
  if (index < 0) return order[0] ?? null;
  return order[(index + delta + order.length) % order.length] ?? null;
};
