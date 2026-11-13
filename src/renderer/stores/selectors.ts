import type { Source } from "~/shared/agent/agent";
import {
  finalGrade,
  summarize,
  type ChangeRecord,
  type ChangeSummary,
} from "~/shared/domain/change";
import type { ConnectionRecord, QueueFilter, ThreadUi } from "./types";
import type { CourseShell } from "~/shared/domain/content";
import type { ChangeId, IsoTime, LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import {
  canCancelSetup,
  offerWords,
  readinessOf,
  reviewRows,
  stageOf,
  stageWords,
  templateChangeOf,
  type CourseSetup,
  type ReviewRow,
  type SetupLive,
  type SetupStage,
} from "~/shared/domain/setup";
import { workName } from "~/shared/domain/workName";
import type {
  Announcement,
  Assignment,
  Conversation,
  ConversationMessage,
  Course,
  School,
  Student,
  Submission,
} from "~/shared/domain/lms";

import type { SchoolCache, Thread, ThreadMessage, WorkspaceData } from "./types";

/**
 * Same state and args give the same object, so these are safe as zustand selectors and never loop useSyncExternalStore.
 * The cache holds one entry per args string for the state it last saw.
 */
const memoByState = <S extends object, A extends readonly unknown[], R>(
  compute: (state: S, ...args: A) => R,
) => {
  let last: S | null = null;
  let entries = new Map<string, R>();
  return (state: S, ...args: A): R => {
    if (state !== last) {
      last = state;
      entries = new Map();
    }
    const key = JSON.stringify(args);
    const hit = entries.get(key);
    if (hit !== undefined) return hit;
    const value = compute(state, ...args);
    entries.set(key, value);
    return value;
  };
};

/** The thread behind the unified inbox. It spans every course, so it never appears in a course's list. */
export const INBOX_THREAD = "t-inbox" as ThreadId;
export const NORTH_STAR_THREAD = "t-north-star" as ThreadId;
/** Every submission to grade, across schools. What's due links to it. */
export const GRADING_LIST_THREAD = "t-queue" as ThreadId;

const caches = (state: WorkspaceData): readonly SchoolCache[] => Object.values(state.cache);
const schoolOf = (state: WorkspaceData, id: SchoolId): School | undefined =>
  state.schools.find((school) => school.id === id);
const dueMs = (assignment: Assignment): number =>
  assignment.dueAt ? new Date(assignment.dueAt).getTime() : Number.POSITIVE_INFINITY;

const IN_PROGRESS = new Set<ChangeRecord["state"]["tag"]>([
  "draft",
  "approved",
  "sending",
  "held",
  "conflicted",
]);
const isOpenChange = (change: ChangeRecord): boolean => IN_PROGRESS.has(change.state.tag);

/** The change a screen should show for a target: the live one if any, otherwise the last one sent. */
const changesByTarget = (state: WorkspaceData): ReadonlyMap<string, ChangeRecord> => {
  const byTarget = new Map<string, ChangeRecord>();
  for (const change of Object.values(state.changes)) {
    // A row shows its grade. A message to the same student is separate work and leaves the row as it was.
    if (change.state.tag === "discarded" || change.content.kind === "message") continue;
    const held = byTarget.get(change.content.target);
    if (!held || !isOpenChange(held)) byTarget.set(change.content.target, change);
  }
  return byTarget;
};

/** A summary with what the change alone can't know: its school's token expired or came back, or the Mac is offline. */
export const summarizeFor = (
  change: ChangeRecord,
  connection: ConnectionRecord["status"] | undefined,
  online = true,
): ChangeSummary => {
  const summary = withConnection(summarize(change), connection);
  // Offline, Send is disabled up front rather than tried and held, and nothing queues (D28).
  return online ? summary : { ...summary, canSend: false };
};
const withConnection = (
  summary: ChangeSummary,
  connection: ConnectionRecord["status"] | undefined,
): ChangeSummary => {
  const expired = connection === "expired" || connection === "disconnected";
  if (summary.banner === "reconnect" && !expired)
    return { ...summary, label: "Ready to retry", recovery: "retry" };
  // Without a token every Retry and Resume would quietly do nothing, so reconnecting is the only thing on offer.
  if (expired && summary.canSend)
    return {
      ...summary,
      label: summary.banner === "reconnect" ? summary.label : "Waiting on reconnect",
      tone: "attention",
      recovery: "reconnect",
      banner: "reconnect",
      waitingOnReconnect: true,
    };
  return summary;
};
// Selectors take the persisted data; the live store also carries `online`, which isn't persisted.
const summarizeIn = (
  state: WorkspaceData & { online?: boolean },
  change: ChangeRecord,
): ChangeSummary => summarizeFor(change, state.connections[change.school]?.status, state.online);

export interface QueueRow {
  submission: Submission;
  assignment: Assignment;
  course: Course;
  school: School;
  change: ChangeRecord | null;
  summary: ChangeSummary | null;
  /** False once its grade has been sent. The row stays so the queue shows what got done. */
  open: boolean;
  /** Past due with nothing turned in. A grade still settles it, but it isn't work waiting to be read. */
  missing: boolean;
}

/** Missing students join only when asked, so every "to grade" count stays about work that came in. */
export const selectQueueRows = memoByState(
  (
    state: WorkspaceData,
    assignment: LmsRef<"assignment"> | null = null,
    withMissing = false,
  ): readonly QueueRow[] => {
    const byTarget = changesByTarget(state);
    const rows: QueueRow[] = [];
    for (const cache of caches(state)) {
      for (const submission of cache.submissions) {
        if (assignment && submission.assignment !== assignment) continue;
        const known = byTarget.get(submission.ref) ?? null;
        // A student who submitted again after the send is new work, not the grade we already sent.
        const change =
          known?.state.tag === "sent" &&
          submission.submittedAt !== null &&
          submission.submittedAt > known.state.at
            ? null
            : known;
        const missing = submission.workflow === "missing";
        if (submission.workflow !== "submitted" && !(withMissing && missing) && !change) continue;
        const parent = cache.assignments.find((a) => a.ref === submission.assignment);
        const course = cache.courses.find((c) => c.ref === submission.course);
        const school = schoolOf(state, submission.school);
        if (!parent || !course || !school) continue;
        rows.push({
          submission,
          assignment: parent,
          course,
          school,
          change,
          summary: change && summarizeIn(state, change),
          open: change?.state.tag !== "sent",
          missing,
        });
      }
    }
    return rows.sort(
      (a, b) =>
        dueMs(a.assignment) - dueMs(b.assignment) ||
        // Nothing turned in, not `missing`, which a posted grade turns off and would reorder the list mid-session.
        Number(a.submission.submittedAt === null) - Number(b.submission.submittedAt === null) ||
        b.submission.lateDays - a.submission.lateDays ||
        a.submission.studentName.localeCompare(b.submission.studentName),
    );
  },
);

export interface DueItem {
  assignment: Assignment;
  course: Course;
  school: School;
  toGrade: number;
  late: number;
  submitted: number;
  graded: number;
  missing: number;
  total: number;
  /** Whole calendar days from today. Negative is past due. Null when the assignment has no due date. */
  days: number | null;
}
export type DatedItem = DueItem & { days: number };

/** Work that came in without a grade is gradable now, before its deadline too. A submission made after its grade was sent comes back as new work. */
export const hasWorkToGrade = (item: Pick<DueItem, "toGrade">): boolean => item.toGrade > 0;
export interface DueGroup {
  key: "past" | "today" | "week" | "later" | "undated";
  label: string;
  items: readonly DueItem[];
}

const DAY = 86_400_000;
/** The last day the This week group holds, counted from today. */
export const WEEK_AHEAD = 7;
const startOfDay = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);
const GROUPS: readonly { key: DueGroup["key"]; label: string; holds: (days: number) => boolean }[] =
  [
    { key: "past", label: "Past due", holds: (days) => days < 0 },
    { key: "today", label: "Today", holds: (days) => days === 0 },
    { key: "week", label: "This week", holds: (days) => days > 0 && days <= WEEK_AHEAD },
    { key: "later", label: "Later", holds: (days) => days > WEEK_AHEAD },
  ];

const dueItems = (
  state: WorkspaceData,
  today: number,
): { dated: readonly DatedItem[]; undated: readonly DueItem[] } => {
  const dated: DatedItem[] = [];
  const undated: { item: DueItem; firstIn: string }[] = [];
  for (const cache of caches(state)) {
    for (const assignment of cache.assignments) {
      const course = cache.courses.find((c) => c.ref === assignment.course);
      const school = schoolOf(state, assignment.school);
      if (!course || !school) continue;
      const submissions = cache.submissions.filter((s) => s.assignment === assignment.ref);
      const waiting = submissions.filter((s) => s.workflow === "submitted");
      const counts = {
        assignment,
        course,
        school,
        toGrade: waiting.length,
        late: waiting.filter((s) => s.lateDays > 0).length,
        submitted: submissions.filter((s) => s.workflow === "submitted" || s.workflow === "graded")
          .length,
        graded: submissions.filter((s) => s.workflow === "graded").length,
        missing: submissions.filter((s) => s.workflow === "missing").length,
        total: submissions.length,
      };
      if (assignment.dueAt) {
        dated.push({ ...counts, days: Math.round((startOfDay(dueMs(assignment)) - today) / DAY) });
      } else {
        const firstIn = waiting.flatMap((s) => s.submittedAt ?? []).sort()[0] ?? "";
        undated.push({ item: { ...counts, days: null }, firstIn });
      }
    }
  }
  dated.sort((a, b) => dueMs(a.assignment) - dueMs(b.assignment));
  // No deadline to order by, so the work that has waited longest comes first.
  undated.sort((a, b) => a.firstIn.localeCompare(b.firstIn));
  return { dated, undated: undated.map(({ item }) => item) };
};

/** Work with no due date comes after every dated group: a deadline is a promise to students, and undated work made none. */
const whatsDue = memoByState((state: WorkspaceData, today: number): readonly DueGroup[] => {
  const { dated, undated } = dueItems(state, today);
  const live = dated.filter((item) => item.days >= 0 || hasWorkToGrade(item));
  return [
    ...GROUPS.map(({ key, label, holds }) => ({
      key,
      label,
      items: live.filter((item) => holds(item.days)),
    })),
    { key: "undated" as const, label: "No due date", items: undated.filter(hasWorkToGrade) },
  ].filter((group) => group.items.length > 0);
});
/** Pass `state.now()`. */
export const selectWhatsDue = (state: WorkspaceData, now: number): readonly DueGroup[] =>
  whatsDue(state, startOfDay(now));

export interface CalendarData {
  /** Start of today, epoch ms. Every item's `days` counts from here. */
  today: number;
  items: readonly DatedItem[];
  undated: number;
  lanes: readonly { school: School; courses: readonly Course[] }[];
}

const calendar = memoByState((state: WorkspaceData, today: number): CalendarData => {
  const { dated, undated } = dueItems(state, today);
  return {
    today,
    items: dated,
    undated: undated.length,
    lanes: state.schools.flatMap((school) => {
      const cache = state.cache[school.id];
      return cache ? [{ school, courses: cache.courses }] : [];
    }),
  };
});
/** Pass `state.now()`. */
export const selectCalendar = (state: WorkspaceData, now: number): CalendarData =>
  calendar(state, startOfDay(now));

export interface InboxRow {
  conversation: Conversation;
  course: Course;
  school: School;
  last: ConversationMessage | null;
  change: ChangeRecord | null;
  summary: ChangeSummary | null;
}

/** Every school in one list, newest message first. A provider without messaging contributes nothing. */
export const selectInboxRows = memoByState((state: WorkspaceData): readonly InboxRow[] => {
  const byTarget = changesByTarget(state);
  const rows: InboxRow[] = [];
  for (const cache of caches(state)) {
    for (const conversation of cache.conversations) {
      const course = cache.courses.find((c) => c.ref === conversation.course);
      const school = schoolOf(state, conversation.school);
      if (!course || !school) continue;
      const known = byTarget.get(conversation.ref) ?? null;
      const last = conversation.messages.at(-1) ?? null;
      // A student who wrote again after the send is new work, not the reply we already sent.
      const change =
        known?.state.tag === "sent" && last && !last.mine && last.at > known.state.at
          ? null
          : known;
      rows.push({
        conversation,
        course,
        school,
        last,
        change,
        summary: change && summarizeIn(state, change),
      });
    }
  }
  const lastAt = (row: InboxRow): IsoTime | "" => row.last?.at ?? "";
  return rows.sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
});

export interface GradebookCell {
  assignment: LmsRef<"assignment">;
  submission: Submission | null;
  grade: number | null;
  pending: ChangeSummary | null;
  /** The grade a pending change would write. It sits beside `grade` and never replaces it. */
  proposed: number | null;
  /** The change behind this cell, whether still pending or the record of what was sent. */
  change: ChangeRecord | null;
  sent: boolean;
}
export interface GradebookRow {
  student: Student;
  cells: readonly GradebookCell[];
  /** Graded work only. */
  earned: number;
  possible: number;
  percent: number | null;
  missing: number;
}
export interface Gradebook {
  course: Course;
  assignments: readonly Assignment[];
  rows: readonly GradebookRow[];
  /** Mean grade per assignment among students with one. */
  averages: Readonly<Record<string, number | null>>;
}

const cacheOfCourse = (state: WorkspaceData, course: LmsRef<"course">): SchoolCache | undefined =>
  caches(state).find((cache) => cache.courses.some((c) => c.ref === course));

/** Students by assignments, due-date order. A pending change shows beside the grade the LMS holds, never instead of it. */
export const selectGradebook = memoByState(
  (state: WorkspaceData, course: LmsRef<"course">): Gradebook | null => {
    const cache = cacheOfCourse(state, course);
    const parent = cache?.courses.find((c) => c.ref === course);
    if (!cache || !parent) return null;
    const byTarget = changesByTarget(state);
    const assignments = cache.assignments
      .filter((a) => a.course === course)
      .sort((a, b) => dueMs(a) - dueMs(b));
    const rows = cache.students
      .filter((student) => student.course === course)
      .map((student) => {
        const cells = assignments.map((assignment): GradebookCell => {
          const submission =
            cache.submissions.find(
              (s) => s.assignment === assignment.ref && s.student === student.ref,
            ) ?? null;
          const known = submission ? (byTarget.get(submission.ref) ?? null) : null;
          const change =
            known?.state.tag === "sent" &&
            submission?.submittedAt &&
            submission.submittedAt > known.state.at
              ? null
              : known;
          const open = change !== null && isOpenChange(change);
          return {
            assignment: assignment.ref,
            submission,
            grade: submission?.grade ?? null,
            pending: open ? summarizeIn(state, change) : null,
            proposed: open && change.content.kind === "grade" ? finalGrade(change.content) : null,
            change,
            sent: change?.state.tag === "sent",
          };
        });
        const graded = assignments.filter((_, index) => cells[index]?.grade !== null);
        const possible = graded.reduce((sum, a) => sum + a.pointsPossible, 0);
        const earned = cells.reduce((sum, cell) => sum + (cell.grade ?? 0), 0);
        return {
          student,
          cells,
          earned,
          possible,
          percent: possible > 0 ? Math.round((earned / possible) * 100) : null,
          missing: cells.filter((cell) => cell.submission?.workflow === "missing").length,
        };
      });
    const averages = Object.fromEntries(
      assignments.map((assignment, index) => {
        const grades = rows.flatMap((row) => row.cells[index]?.grade ?? []);
        return [
          assignment.ref,
          grades.length > 0
            ? Math.round((grades.reduce((sum, grade) => sum + grade, 0) / grades.length) * 10) / 10
            : null,
        ];
      }),
    );
    return { course: parent, assignments, rows, averages };
  },
);

type Standing = "On track" | "Watch" | "At risk" | "No grades yet";

export interface RosterRow {
  student: Student;
  percent: number | null;
  missing: number;
  standing: Standing;
}

const standingOf = (percent: number | null): Standing =>
  percent === null
    ? "No grades yet"
    : percent >= 80
      ? "On track"
      : percent >= 60
        ? "Watch"
        : "At risk";

export type NeedsYou =
  | { kind: "assignment"; item: DueItem }
  | { kind: "conversation"; row: InboxRow }
  | { kind: "change"; change: ChangeRecord; summary: ChangeSummary };

export interface CourseOverview {
  course: Course;
  school: School;
  toGrade: number;
  needsApproval: number;
  unread: number;
  missing: number;
  classAverage: number | null;
  upcoming: readonly Assignment[];
  lastAnnouncement: Announcement | null;
  dueThisWeek: number;
  /** Everything from What's due that is still live for this course, in due order. */
  assignments: readonly DueItem[];
  needsYou: readonly NeedsYou[];
  recentAnnouncements: readonly Announcement[];
  recentMessages: readonly InboxRow[];
  roster: readonly RosterRow[];
  threads: readonly Thread[];
}

const courseOverview = memoByState(
  (state: WorkspaceData, course: LmsRef<"course">, today: number): CourseOverview | null => {
    const cache = cacheOfCourse(state, course);
    const parent = cache?.courses.find((c) => c.ref === course);
    const school = parent && schoolOf(state, parent.school);
    if (!cache || !parent || !school) return null;
    const submissions = cache.submissions.filter((s) => s.course === course);
    const book = selectGradebook(state, course);
    const percents = book?.rows.flatMap((row) => (row.percent === null ? [] : [row.percent])) ?? [];
    const assignments = whatsDue(state, today)
      .flatMap((group) => group.items)
      .filter((item) => item.course.ref === course);
    const messages = selectInboxRows(state).filter((row) => row.course.ref === course);
    const unanswered = messages.filter((row) => row.conversation.unread);
    const replying = new Set(unanswered.map((row) => row.conversation.ref as string));
    const open = Object.values(state.changes).filter(
      (change) =>
        change.course === course && isOpenChange(change) && !replying.has(change.content.target),
    );
    const announcements = cache.announcements
      .filter((a) => a.course === course)
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));
    return {
      course: parent,
      school,
      toGrade: submissions.filter((s) => s.workflow === "submitted").length,
      needsApproval: Object.values(state.changes).filter(
        (c) => c.course === course && summarizeIn(state, c).canApprove,
      ).length,
      unread: cache.conversations.filter((c) => c.course === course && c.unread).length,
      missing: submissions.filter((s) => s.workflow === "missing").length,
      classAverage:
        percents.length > 0
          ? Math.round(percents.reduce((sum, value) => sum + value, 0) / percents.length)
          : null,
      upcoming: cache.assignments
        .filter(
          (a) => a.course === course && dueMs(a) >= today && dueMs(a) !== Number.POSITIVE_INFINITY,
        )
        .sort((a, b) => dueMs(a) - dueMs(b)),
      lastAnnouncement: announcements[0] ?? null,
      dueThisWeek: assignments.filter(
        (item) => item.days !== null && item.days >= 0 && item.days <= 7,
      ).length,
      assignments,
      needsYou: [
        ...open.map((change): NeedsYou => ({
          kind: "change",
          change,
          summary: summarizeIn(state, change),
        })),
        ...assignments
          .filter((item) => item.toGrade > 0)
          .map((item): NeedsYou => ({ kind: "assignment", item })),
        ...unanswered.map((row): NeedsYou => ({ kind: "conversation", row })),
      ],
      recentAnnouncements: announcements.slice(0, 3),
      recentMessages: messages.slice(0, 4),
      roster: (book?.rows ?? []).map((row) => ({
        student: row.student,
        percent: row.percent,
        missing: row.missing,
        standing: standingOf(row.percent),
      })),
      threads: Object.values(state.threads).filter((thread) => thread.course === course),
    };
  },
);

/** Pass `state.now()`. */
export const selectCourseOverview = (
  state: WorkspaceData,
  course: LmsRef<"course">,
  now: number,
): CourseOverview | null => courseOverview(state, course, startOfDay(now));

export interface ThreadStatus {
  label: string;
  tone: ChangeSummary["tone"] | "unread";
}

export const NOT_STARTED = { label: "Not started", tone: "todo" } as const satisfies ThreadStatus;

const changesOfThread = (state: WorkspaceData, thread: Thread): readonly ChangeRecord[] =>
  Object.values(state.changes).filter((change) => {
    if (
      change.state.tag === "discarded" ||
      (thread.course !== null && change.course !== thread.course)
    )
      return false;
    if (thread.kind === "messages") return change.content.kind === "reply";
    if (thread.kind === "announcement") return change.content.kind === "announcement";
    if (thread.kind === "setup") return true;
    if (thread.kind !== "grading") return false;
    if (change.content.kind !== "grade" && change.content.kind !== "message") return false;
    const { target } = change.content;
    return caches(state).some((cache) =>
      cache.submissions.some((s) => s.ref === target && s.assignment === thread.assignment),
    );
  });

export const awaitsYou = (row: Pick<InboxRow, "summary" | "last">): boolean =>
  row.summary?.sentAt == null && row.last?.mine !== true;

export const selectThreadName = memoByState((state: WorkspaceData, id: ThreadId): string => {
  const thread = state.threads[id];
  if (!thread) return "";
  switch (thread.kind) {
    case "grading": {
      const assignment = selectAssignment(state, thread.assignment ?? null);
      return assignment
        ? workName({ kind: "grading", assignment: assignment.shortTitle })
        : thread.title;
    }
    case "announcement": {
      const changes = changesOfThread(state, thread);
      return (
        (changes.find((change) => change.id === thread.focus) ?? changes.find(isOpenChange))
          ?.subject ?? thread.title
      );
    }
    case "messages": {
      const { current } = selectThreadUi(state, id);
      const waiting = selectInboxRows(state).filter(
        (row) =>
          row.course.ref === thread.course &&
          (row.conversation.unread || row.change) &&
          awaitsYou(row),
      );
      const people = [
        ...waiting.filter((row) => row.conversation.ref === current),
        ...waiting.filter((row) => row.conversation.ref !== current),
      ].map((row) => row.conversation.from);
      return people.length > 0 ? workName({ kind: "replies", people }) : thread.title;
    }
    case "north-star":
    case "north-star-chat":
    case "queue":
    case "setup":
    case "general":
      return thread.title;
  }
});

/** A handoff card names what the chat handed off, which a later send doesn't change. */
export const selectHandoffName = (
  state: WorkspaceData,
  handoff: Extract<ThreadMessage, { type: "handoff" }>,
): string => {
  const student = handoff.conversation && selectConversation(state, handoff.conversation)?.from;
  if (student) return workName({ kind: "replies", people: [student] });
  if (handoff.people?.length) return workName({ kind: "replies", people: handoff.people });
  return selectThreadName(state, handoff.to);
};

/** Null means the sidebar shows no pill. */
export const selectThreadStatus = memoByState(
  (
    state: WorkspaceData & { working?: Readonly<Record<ThreadId, boolean>> },
    id: ThreadId,
  ): ThreadStatus | null => {
    const thread = state.threads[id];
    if (!thread) return null;
    if (state.working?.[id]) return { label: "Working", tone: "working" };
    if (isChatThread(thread)) return null;
    if (thread.kind === "queue") {
      const open = selectQueueRows(state).filter((row) => row.open).length;
      return open > 0
        ? { label: `${open} to grade`, tone: "todo" }
        : { label: "Done", tone: "done" };
    }
    const changes = changesOfThread(state, thread);
    const open = changes.filter(isOpenChange);
    if (open.some((c) => summarizeIn(state, c).label === "Waiting on reconnect"))
      return { label: "Waiting on reconnect", tone: "attention" };
    if (open.some((c) => c.state.tag === "sending")) return { label: "Sending", tone: "working" };
    if (open.some((c) => c.state.tag === "held" || c.state.tag === "conflicted"))
      return { label: "Needs attention", tone: "attention" };
    if (open.some((c) => c.state.tag === "approved"))
      return { label: "Ready to send", tone: "ready" };
    const awaitingApproval = open
      .map((c) => summarizeIn(state, c))
      .find((summary) => summary.canApprove);
    if (awaitingApproval) return { label: awaitingApproval.label, tone: "approval" };
    if (open.some((c) => c.state.tag === "draft")) return { label: "In progress", tone: "todo" };
    if (thread.kind === "grading") {
      const left = selectQueueRows(state, thread.assignment ?? null).filter(
        (row) => row.open,
      ).length;
      return left > 0
        ? { label: `${left} to grade`, tone: "todo" }
        : { label: "Done", tone: "done" };
    }
    if (thread.kind === "messages") {
      const unread = caches(state)
        .flatMap((cache) => cache.conversations)
        .filter((c) => c.course === thread.course && c.unread).length;
      return unread > 0
        ? { label: `${unread} unread`, tone: "unread" }
        : { label: "Done", tone: "done" };
    }
    if (thread.kind === "setup")
      return thread.course &&
        state.setups[thread.course] &&
        stageOf(state.setups[thread.course] as CourseSetup, state.changes, undefined).tag !==
          "published"
        ? { label: "In setup", tone: "todo" }
        : { label: "Done", tone: "done" };
    return changes.some((c) => c.state.tag === "sent")
      ? { label: "Posted", tone: "done" }
      : NOT_STARTED;
  },
);

export const isChatThread = (thread: Pick<Thread, "kind">): boolean =>
  thread.kind === "general" || thread.kind === "north-star" || thread.kind === "north-star-chat";
export const withoutChatThreads = <T extends Pick<Thread, "kind">>(
  threads: readonly T[],
  ai: boolean,
): readonly T[] => (ai ? threads : threads.filter((thread) => !isChatThread(thread)));

/** Course threads and chats settle. North Star and the grading list stay put. */
export const canSettle = (thread: Pick<Thread, "course" | "kind">): boolean =>
  thread.course !== null || thread.kind === "north-star-chat";

/** Any message after `settledAt` resumes the thread with no write. */
export const isSettled = (
  thread: Pick<Thread, "course" | "kind" | "messages" | "settledAt">,
): boolean =>
  canSettle(thread) &&
  thread.settledAt !== undefined &&
  (thread.messages.at(-1)?.at ?? "") <= thread.settledAt;

export interface DueExtras {
  drafts: readonly {
    thread: Thread;
    name: string;
    course: Course;
    school: School;
    status: ThreadStatus;
    drafted: boolean;
  }[];
  unread: readonly InboxRow[];
}

export const selectDueExtras = memoByState((state: WorkspaceData): DueExtras => {
  const drafts = Object.values(state.threads).flatMap((thread) => {
    if (thread.kind !== "announcement" || !thread.course) return [];
    const course = selectCourse(state, thread.course);
    const school = course && schoolOf(state, course.school);
    const status = selectThreadStatus(state, thread.id);
    return course && school && status && status.tone !== "done"
      ? [
          {
            thread,
            name: selectThreadName(state, thread.id),
            course,
            school,
            status,
            drafted: changesOfThread(state, thread).some(isOpenChange),
          },
        ]
      : [];
  });
  return { drafts, unread: selectInboxRows(state).filter((row) => row.conversation.unread) };
});

export type WorkStage = "stuck" | "review";

const stageOfChange = (
  change: ChangeRecord | null,
  summary: ChangeSummary | null,
): WorkStage | null => {
  if (!change || !isOpenChange(change)) return null;
  if (change.state.tag === "held" || change.state.tag === "conflicted") return "stuck";
  return change.state.tag === "approved" || summary?.canApprove ? "review" : null;
};

export const selectWorkStages = memoByState(
  (state: WorkspaceData): ReadonlyMap<string, WorkStage> => {
    const stages = new Map<string, WorkStage>();
    for (const row of selectQueueRows(state)) {
      const stage = stageOfChange(row.change, row.summary);
      if (stage && stages.get(row.assignment.ref) !== "stuck")
        stages.set(row.assignment.ref, stage);
    }
    for (const row of selectInboxRows(state)) {
      const stage = stageOfChange(row.change, row.summary);
      if (stage) stages.set(row.conversation.ref, stage);
    }
    return stages;
  },
);

export interface CourseAnnouncements {
  posted: readonly Announcement[];
  drafts: readonly { change: ChangeRecord; summary: ChangeSummary }[];
}

export const selectCourseAnnouncements = memoByState(
  (state: WorkspaceData, course: LmsRef<"course">): CourseAnnouncements => ({
    posted: (cacheOfCourse(state, course)?.announcements ?? [])
      .filter((a) => a.course === course)
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt)),
    drafts: Object.values(state.changes)
      .filter(
        (change) =>
          change.course === course &&
          change.content.kind === "announcement" &&
          isOpenChange(change),
      )
      .map((change) => ({ change, summary: summarizeIn(state, change) })),
  }),
);

export const DEFAULT_THREAD_UI: ThreadUi = {
  panel: null,
  queueOpen: true,
  queueFilter: "all" satisfies QueueFilter,
  current: null,
  selected: [],
  scrollTop: null,
};
export const selectThreadUi = (state: WorkspaceData, id: ThreadId): ThreadUi =>
  state.prefs.threadUi[id] ?? DEFAULT_THREAD_UI;

/** Every change this thread is working on, oldest first. The queue spans them all. */
export const selectThreadChanges = memoByState(
  (
    state: WorkspaceData & { blanks?: Readonly<Record<ChangeId, ChangeRecord>> },
    id: ThreadId,
  ): readonly ChangeRecord[] => {
    const thread = state.threads[id];
    if (!thread) return [];
    const own =
      thread.kind === "queue"
        ? Object.values(state.changes).filter(
            (c) => c.state.tag !== "discarded" && c.content.kind === "grade",
          )
        : changesOfThread(state, thread);
    const focused = thread.focus
      ? (state.changes[thread.focus] ?? state.blanks?.[thread.focus])
      : undefined;
    const all =
      focused && focused.state.tag !== "discarded" && !own.includes(focused)
        ? [...own, focused]
        : own;
    return [...all].sort((a, b) =>
      (a.activity[0]?.at ?? "").localeCompare(b.activity[0]?.at ?? ""),
    );
  },
);

export const selectSubmission = (
  state: WorkspaceData,
  ref: LmsRef<"submission"> | null,
): Submission | null => {
  if (!ref) return null;
  for (const cache of caches(state)) {
    const found = cache.submissions.find((s) => s.ref === ref);
    if (found) return found;
  }
  return null;
};
export const selectAssignment = (
  state: WorkspaceData,
  ref: LmsRef<"assignment"> | null,
): Assignment | null => {
  if (!ref) return null;
  for (const cache of caches(state)) {
    const found = cache.assignments.find((a) => a.ref === ref);
    if (found) return found;
  }
  return null;
};
export const selectCourse = (state: WorkspaceData, ref: LmsRef<"course"> | null): Course | null => {
  if (!ref) return null;
  for (const cache of caches(state)) {
    const found = cache.courses.find((c) => c.ref === ref);
    if (found) return found;
  }
  return (
    Object.values(state.newCourses)
      .flat()
      .find((shell) => shell.ref === ref) ??
    state.setups[ref]?.shell ??
    null
  );
};

export interface Waiting {
  attention: number;
  ready: number;
  approval: number;
  grade: number;
  unread: number;
}

const NOTHING_WAITING: Waiting = { attention: 0, ready: 0, approval: 0, grade: 0, unread: 0 };

export const selectCourseWaiting = memoByState(
  (state: WorkspaceData, course: LmsRef<"course">): Waiting => {
    const waiting = { ...NOTHING_WAITING };
    const claimed = new Set<string>();
    for (const change of Object.values(state.changes)) {
      if (change.course !== course || !isOpenChange(change)) continue;
      const summary = summarizeIn(state, change);
      if (summary.waitingOnReconnect) continue;
      const kind =
        change.state.tag === "held" || change.state.tag === "conflicted"
          ? "attention"
          : change.state.tag === "approved"
            ? "ready"
            : summary.canApprove
              ? "approval"
              : null;
      if (!kind) continue;
      waiting[kind] += 1;
      claimed.add(change.content.target);
    }
    waiting.grade = selectQueueRows(state).filter(
      (row) => row.course.ref === course && row.open && !claimed.has(row.submission.ref),
    ).length;
    waiting.unread = caches(state)
      .flatMap((cache) => cache.conversations)
      .filter(
        (conversation) =>
          conversation.course === course && conversation.unread && !claimed.has(conversation.ref),
      ).length;
    return waiting;
  },
);

export const selectSchoolWaiting = memoByState((state: WorkspaceData, school: SchoolId): Waiting =>
  (state.cache[school]?.courses ?? []).reduce((total, course) => {
    const waiting = selectCourseWaiting(state, course.ref);
    return {
      attention: total.attention + waiting.attention,
      ready: total.ready + waiting.ready,
      approval: total.approval + waiting.approval,
      grade: total.grade + waiting.grade,
      unread: total.unread + waiting.unread,
    };
  }, NOTHING_WAITING),
);

export interface SchoolCoverage {
  /** Schools with synced work, the ones a school filter can offer. */
  withData: readonly School[];
  /** Schools the teacher disconnected. Their work is gone from every screen. */
  disconnected: readonly School[];
}

export const selectSchoolCoverage = memoByState((state: WorkspaceData): SchoolCoverage => ({
  withData: state.schools.filter((school) => state.cache[school.id]),
  disconnected: state.schools.filter(
    (school) => state.connections[school.id]?.status === "disconnected",
  ),
}));

/** Why no school's work can show: none was added, or every one is disconnected. */
export type SchoolGap = "none" | "disconnected";

export const selectSchoolGap = (state: WorkspaceData): SchoolGap | null => {
  if (state.schools.length === 0) return "none";
  return state.schools.every((school) => state.connections[school.id]?.status === "disconnected")
    ? "disconnected"
    : null;
};

export interface SetupOffer {
  shell: CourseShell;
  school: School;
  /** Set once the offer was taken. */
  thread: ThreadId | null;
  /** Before the offer is taken, who and what is already there. After, how far the setup got. */
  words: string;
  /** A taken offer can be dropped until its copy may have reached the LMS. */
  cancellable: boolean;
}

export const selectSetupOffers = memoByState(
  (
    state: WorkspaceData & { setupLive?: Readonly<Record<string, SetupLive>> },
  ): readonly SetupOffer[] =>
    state.schools.flatMap((school) =>
      state.connections[school.id]?.status === "disconnected"
        ? []
        : (state.newCourses[school.id] ?? []).map((shell) => {
            const setup = state.setups[shell.ref];
            return {
              shell,
              school,
              thread: setup?.thread ?? null,
              cancellable: setup ? canCancelSetup(setup, state.changes) : false,
              words: setup
                ? stageWords(stageOf(setup, state.changes, state.setupLive?.[shell.ref]))
                : offerWords(shell),
            };
          }),
    ),
);

export interface SetupView {
  /** Null for a thread that only saves an existing course as a template. */
  setup: CourseSetup | null;
  stage: SetupStage | null;
  live: SetupLive | null;
  rows: readonly ReviewRow[];
  readiness: ReturnType<typeof readinessOf>;
  template: ChangeRecord | null;
}

export const selectSetupView = memoByState(
  (
    state: WorkspaceData & { setupLive?: Readonly<Record<string, SetupLive>> },
    course: LmsRef<"course">,
  ): SetupView => {
    const setup = state.setups[course] ?? null;
    const live = state.setupLive?.[course] ?? null;
    const rows = setup ? reviewRows(setup, state.changes) : [];
    return {
      setup,
      stage: setup && stageOf(setup, state.changes, live ?? undefined),
      live,
      rows,
      readiness: readinessOf(rows),
      template: templateChangeOf(state.changes, course),
    };
  },
);

/** Every change whose card this thread has on screen: the one it's focused on, and on a setup thread the card its stage shows whatever is focused. */
export const selectChangesShown = (state: WorkspaceData, thread: Thread): readonly ChangeId[] => {
  const view =
    thread.kind === "setup" && thread.course ? selectSetupView(state, thread.course) : null;
  const stage = view?.stage;
  const card =
    stage?.tag === "approve-copy"
      ? stage.copy
      : stage?.tag === "publish-check"
        ? stage.publish
        : (view?.template?.id ?? null);
  return [thread.focus, card].filter((id) => id !== null);
};

export interface SourceView {
  /** Which course's pages it opens. An announcement has no page of its own. */
  course: LmsRef<"course"> | null;
}

export const selectSource = memoByState(
  (state: WorkspaceData, source: Source): SourceView | null => {
    switch (source.kind) {
      case "due":
        return { course: null };
      case "course": {
        const course = selectCourse(state, source.ref);
        return course && { course: course.ref };
      }
      case "assignment": {
        const assignment = selectAssignment(state, source.ref);
        return assignment && { course: assignment.course };
      }
      case "announcement": {
        const post = caches(state)
          .flatMap((cache) => cache.announcements)
          .find((a) => a.ref === source.ref);
        return post ? { course: post.course } : null;
      }
      case "conversation": {
        const conversation = selectConversation(state, source.ref);
        return conversation && { course: conversation.course };
      }
      case "submission": {
        const submission = selectSubmission(state, source.ref);
        return submission && { course: submission.course };
      }
      case "change": {
        const change = state.changes[source.ref];
        return change ? { course: change.course } : null;
      }
    }
  },
);

export const selectConversation = (
  state: WorkspaceData,
  ref: LmsRef<"conversation">,
): Conversation | null => {
  for (const cache of caches(state)) {
    const found = cache.conversations.find((c) => c.ref === ref);
    if (found) return found;
  }
  return null;
};
export const selectUnreadCount = (state: WorkspaceData): number =>
  caches(state).reduce((sum, cache) => sum + cache.conversations.filter((c) => c.unread).length, 0);
