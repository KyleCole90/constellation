import type { ChangeRecord, ChangeSummary } from "~/shared/domain/change";
import type { ChangeId, IsoTime, LmsRef } from "~/shared/domain/ids";
import {
  bySchoolName,
  resubmitted,
  undraftableReason,
  type Course,
  type School,
} from "~/shared/domain/lms";
import { firstName } from "~/shared/domain/workName";
import { formatDay } from "~/renderer/lib/utils";
import {
  awaitsYou,
  NOT_STARTED,
  type InboxRow,
  type QueueRow,
  type ThreadStatus,
} from "~/renderer/stores/selectors";
import type { QueueFilter, RowKey, Thread } from "~/renderer/stores/types";

/** One row of work in the pinned queue. Submissions and conversations both fit, so batches stay generic. */
export type WorkRow = WorkRowOf<"submission"> | WorkRowOf<"conversation">;

export interface WorkRowOf<K extends "submission" | "conversation"> {
  key: LmsRef<K>;
  kind: K;
  title: string;
  detail: string;
  assignment: LmsRef<"assignment"> | null;
  school: School;
  course: Course;
  dueAt: IsoTime | null;
  lateDays: number;
  resubmitted: boolean;
  change: ChangeRecord | null;
  summary: ChangeSummary | null;
  open: boolean;
  /** When the teacher asked the student to resubmit, so the work waits on them. */
  asked: IsoTime | null;
  missing: boolean;
  /** False when `undraftableReason` refuses the work, so opening it opens the hand form. */
  draftable: boolean;
}

export const fromQueueRows = (rows: readonly QueueRow[]): readonly WorkRow[] =>
  rows.map((row): WorkRow => ({
    key: row.submission.ref,
    kind: "submission",
    title: row.submission.studentName,
    detail: row.assignment.shortTitle,
    assignment: row.assignment.ref,
    school: row.school,
    course: row.course,
    dueAt: row.assignment.dueAt,
    lateDays: row.submission.lateDays,
    resubmitted: resubmitted(row.submission),
    change: row.change,
    summary: row.summary,
    open: row.open,
    asked: row.asked,
    missing: row.missing,
    draftable: undraftableReason(row.submission.body) === null,
  }));

export const fromConversationRows = (rows: readonly InboxRow[]): readonly WorkRow[] =>
  rows.map((row): WorkRow => ({
    key: row.conversation.ref,
    kind: "conversation",
    title: row.conversation.from,
    detail: row.conversation.subject,
    assignment: null,
    school: row.school,
    course: row.course,
    dueAt: null,
    lateDays: 0,
    resubmitted: false,
    change: row.change,
    summary: row.summary,
    open: awaitsYou(row),
    asked: null,
    missing: false,
    draftable: true,
  }));

/** A course's queue of messages: what waits on a reply or is already being worked on. */
export const fromInboxRows = (rows: readonly InboxRow[]): readonly WorkRow[] =>
  fromConversationRows(rows.filter((row) => awaitsYou(row) || row.change));

/** What a row adds to its thread's title: where it sits, ending with its due date. */
export const rowLine = (row: WorkRow, thread: Pick<Thread, "course" | "assignment">): string =>
  [
    thread.course ? null : row.course.code,
    thread.assignment ? null : row.detail,
    !thread.assignment && row.dueAt ? `Due ${formatDay(row.dueAt)}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

export const spansSchools = (rows: readonly WorkRow[]): boolean =>
  new Set(rows.map((row) => row.school.id)).size > 1;

export const rowStatus = (row: WorkRow, drafting: boolean): ThreadStatus => {
  if (drafting) return { tone: "working", label: "Drafting" };
  if (row.asked) return { tone: "todo", label: `Asked to resubmit · ${formatDay(row.asked)}` };
  return row.summary ?? NOT_STARTED;
};

const SIMPLE_FILTERS: readonly {
  filter: QueueFilter;
  label: string;
  holds: (row: WorkRow) => boolean;
}[] = [
  {
    filter: "needs-draft",
    label: NOT_STARTED.label,
    holds: (row) => row.change === null && row.asked === null,
  },
  { filter: "missing", label: "Missing", holds: (row) => row.missing && row.open },
  {
    filter: "ready-to-approve",
    label: "Draft. Not sent",
    holds: (row) => row.summary?.canApprove === true,
  },
  { filter: "approved", label: "Ready to send", holds: (row) => row.summary?.tone === "ready" },
  {
    filter: "attention",
    label: "Needs attention",
    holds: (row) => row.summary?.tone === "attention",
  },
];

const holdsFilter = (row: WorkRow, filter: QueueFilter): boolean => {
  if (filter === "all") return true;
  if (filter.startsWith("school:")) return row.school.id === filter.slice("school:".length);
  if (filter.startsWith("course:")) return row.course.ref === filter.slice("course:".length);
  if (filter.startsWith("assignment:"))
    return row.assignment === filter.slice("assignment:".length);
  return SIMPLE_FILTERS.find((entry) => entry.filter === filter)?.holds(row) ?? true;
};

export const filterRows = (rows: readonly WorkRow[], filter: QueueFilter): readonly WorkRow[] =>
  rows.filter((row) => holdsFilter(row, filter));

const sharedLabel = (rows: readonly WorkRow[], fallback: string): string => {
  const labels = new Set(rows.map((row) => row.summary?.label ?? fallback));
  return labels.size === 1 ? [...labels].join() : fallback;
};

const chipWords = (label: string): string =>
  label.replace(/\. (.)/, (_, next: string) => `, ${next.toLowerCase()}`);

export interface QueueChip {
  filter: QueueFilter;
  label: string;
  count: number;
}

/** A course gets a chip only while it is the filter, as when a course's To grade opens the list, so the narrowing shows and All undoes it. */
export const queueChips = (
  rows: readonly WorkRow[],
  active: QueueFilter = "all",
): readonly QueueChip[] => {
  const open = rows.filter((row) => row.open);
  const course = active.startsWith("course:")
    ? rows.find((row) => holdsFilter(row, active))?.course
    : undefined;
  const perCourse: readonly QueueChip[] = course
    ? [
        {
          filter: active,
          label: course.code,
          count: open.filter((row) => row.course.ref === course.ref).length,
        },
      ]
    : [];
  const schools = spansSchools(rows)
    ? [...new Map(rows.map((row) => [row.school.id, row.school])).values()].sort(bySchoolName)
    : [];
  const perSchool = schools.map((school): QueueChip => ({
    filter: `school:${school.id}`,
    label: school.abbr,
    count: open.filter((row) => row.school.id === school.id).length,
  }));
  const perState = SIMPLE_FILTERS.map(({ filter, label, holds }): QueueChip => {
    const held = rows.filter(holds);
    return {
      filter,
      label: chipWords(filter === "ready-to-approve" ? sharedLabel(held, label) : label),
      count: held.length,
    };
  });
  const narrowing = [...perCourse, ...perSchool, ...perState].filter(
    (chip) => chip.count > 0 && chip.count < open.length,
  );
  return narrowing.length > 0
    ? [{ filter: "all", label: "All", count: open.length }, ...narrowing]
    : [];
};

/** Assignments get a picker rather than chips, because a term-wide list holds a dozen of them. */
export const assignmentChoices = (rows: readonly WorkRow[]): readonly QueueChip[] => {
  const open = rows.filter((row) => row.open);
  const firsts = [
    ...new Map(
      rows.flatMap((row) => (row.assignment ? [[row.assignment, row] as const] : [])),
    ).entries(),
  ];
  const choices = firsts.map(([ref, first]): QueueChip => ({
    filter: `assignment:${ref}`,
    label: `${first.course.code} ${first.detail}`,
    count: open.filter((row) => row.assignment === ref).length,
  }));
  return choices.filter((choice) => choice.count > 0 && choice.count < open.length);
};

export const liveFilter = (rows: readonly WorkRow[], filter: QueueFilter): QueueFilter =>
  [...queueChips(rows, filter), ...assignmentChoices(rows)].some((chip) => chip.filter === filter)
    ? filter
    : "all";

/** Grades and requests to resubmit both take work off the list, but a teacher reads "sent" as grades, so a grading list counts each by name. Missing work is missing, never to grade (#151). */
export const queueProgress = (
  rows: readonly WorkRow[],
  currentKey: string | null = null,
): { label: string; place: string | null; done: string; fraction: number } => {
  const done = rows.filter((row) => !row.open).length;
  const asked = rows.filter((row) => !row.open && row.asked !== null).length;
  const missing = rows.filter((row) => row.open && row.missing).length;
  const toGrade = rows.length - done - missing;
  const index = rows.findIndex((row) => row.key === currentKey);
  const grading = rows.some((row) => row.kind === "submission");
  return {
    label: grading
      ? [
          `${done - asked} graded`,
          asked > 0 && `${asked} asked to resubmit`,
          missing > 0 && `${missing} missing`,
          (toGrade > 0 || missing === 0) && `${toGrade} to grade`,
        ]
          .filter(Boolean)
          .join(" · ")
      : `${done} of ${rows.length} sent`,
    place: index < 0 ? null : `${index + 1} of ${rows.length}`,
    done: grading ? `${done - asked} graded` : `${done} sent`,
    fraction: rows.length ? done / rows.length : 0,
  };
};

const STRIP_NAME_CHARS = 30;

export const nameFillsStrip = (title: string): boolean => title.length > STRIP_NAME_CHARS;

export interface Edges {
  top: number;
  bottom: number;
}

const EDGE_SLACK_PX = 1;

export const rowsOutOfView = (
  view: Edges,
  rows: readonly Edges[],
): { above: number; below: number } => ({
  above: rows.filter((row) => row.top < view.top - EDGE_SLACK_PX).length,
  below: rows.filter((row) => row.bottom > view.bottom + EDGE_SLACK_PX).length,
});

export const moreWords = ({ above, below }: { above: number; below: number }): string | null =>
  below > 0 ? `${below} more below` : above > 0 ? `${above} more above` : null;

export const neighbor = (
  rows: readonly WorkRow[],
  key: string | null,
  delta: 1 | -1,
): WorkRow | null => {
  const index = rows.findIndex((row) => row.key === key);
  if (index < 0) return rows[0] ?? null;
  return rows[index + delta] ?? null;
};

/** Moving on to a row nobody has drafted drafts it, which costs a model call, so the button says so. Opening a row any other way drafts nothing, and neither does one Claude can't read. */
export const draftsNext = (next: WorkRow, aiDrafts: boolean): boolean =>
  aiDrafts && next.change === null && next.draftable;

/** Names the work too when `next` is the same person as `done`, so it can't read as pointing back at what was just sent. */
export const nextLabel = (next: WorkRow, aiDrafts: boolean, done?: WorkRow): string =>
  `${draftsNext(next, aiDrafts) ? "Draft next" : "Next"}: ${done?.title === next.title ? `${firstName(next.title)}'s ${next.detail}` : next.title}`;

/** The next row with work left after this one, wrapping, so Next never lands on something already sent. */
export const nextOpen = (rows: readonly WorkRow[], key: string | null): WorkRow | null => {
  const index = rows.findIndex((row) => row.key === key);
  const ordered = [...rows.slice(index + 1), ...rows.slice(0, Math.max(index, 0))];
  return ordered.find((row) => row.open) ?? null;
};

/** The rows the teacher ticked are the run Start, Next and the header walk, in list order. A sent one stays in it so the count holds its place. With none ticked, or all of them done, the run is every shown row. */
export const runOf = (
  shown: readonly WorkRow[],
  selected: readonly string[],
): readonly WorkRow[] => {
  const ticked = shown.filter((row) => selected.includes(row.key));
  return ticked.some((row) => row.open) ? ticked : shown;
};

/** What a batch reviews. It comes from the selection, so the bar and the panel can't disagree. */
export const batchChanges = (
  rows: readonly WorkRow[],
  selected: readonly string[],
): readonly ChangeId[] =>
  rows.flatMap((row) => (selected.includes(row.key) && row.change ? [row.change.id] : []));

/**
 * Drafts each row in turn. A run at the teacher's Claude plan limit ends the batch: the drafts so far stay, the rest
 * stay undrafted, and nothing asks again later.
 */
export const draftInTurn = async (
  rows: readonly WorkRow[],
  draft: (row: WorkRow) => Promise<unknown>,
  limitHits: () => number,
  onDrafted: (row: WorkRow) => void,
): Promise<void> => {
  const before = limitHits();
  for (const row of rows) {
    await draft(row);
    onDrafted(row);
    if (limitHits() !== before) return;
  }
};

export const moveCursor = (cursor: number, delta: 1 | -1, length: number): number =>
  length === 0 ? -1 : Math.min(Math.max(cursor + delta, 0), length - 1);

export interface Selection {
  toDraft: readonly WorkRow[];
  toReview: readonly WorkRow[];
  drafting: readonly WorkRow[];
}

/** With AI off, a blank row has nothing to batch: only a draft can be reviewed. */
export const selectable = (row: WorkRow, ai: boolean): boolean =>
  row.open && (ai || row.change !== null);

/** Sent rows belong to none, because nothing is left to do for them. A row still drafting is neither drafted nor to draft, so a batch can wait for it. */
export const splitSelection = (
  rows: readonly WorkRow[],
  selected: readonly string[],
  drafting: ReadonlySet<string> = new Set(),
): Selection => {
  const chosen = rows.filter((row) => selected.includes(row.key) && row.open);
  const settled = chosen.filter((row) => !drafting.has(row.key));
  return {
    toDraft: settled.filter((row) => row.change === null),
    toReview: settled.filter((row) => row.change !== null),
    drafting: chosen.filter((row) => drafting.has(row.key)),
  };
};

/** What a work thread shows, named in its URL so each is a history entry: the list, the batch under review, or one row. */
export type WorkView = { view: "list" | "batch" } | { row: RowKey };
/** A row stays text until the thread decides whether it is there. */
export type ThreadSearch = { view: "list" | "batch" } | { row: string } | Record<string, never>;

export const parseThreadSearch = (search: Record<string, unknown>): ThreadSearch => {
  if (typeof search.row === "string" && search.row) return { row: search.row };
  return search.view === "list" || search.view === "batch" ? { view: search.view } : {};
};

/** What a thread's URL names, or null when it names nothing the thread can show. */
export const readWorkUrl = (
  search: ThreadSearch,
  rowAt: (raw: string) => RowKey | null,
): WorkView | null => {
  if ("row" in search) {
    const row = rowAt(search.row);
    return row === null ? null : { row };
  }
  return "view" in search ? { view: search.view } : null;
};

export const workViewKey = (search: ThreadSearch): string =>
  "row" in search ? `row:${search.row}` : "view" in search ? search.view : "";

/**
 * What a work thread does when its URL or what it shows moves.
 * A URL that names nothing, as from a link or a row that isn't here, or a batch with nothing left to review, is given what is showing in place.
 * A URL that moved (Back, Forward, a reload) sets what shows; what shows moving on its own is a new entry.
 * A URL that already names what shows is left alone, even a row the workspace no longer has, or rewriting it would never settle.
 */
export const followWorkUrl = (
  url: ThreadSearch,
  rowAt: (raw: string) => RowKey | null,
  view: WorkView,
  urlMoved: boolean,
  reviewable: boolean,
): { write: WorkView; replace: boolean } | { show: WorkView } | null => {
  if (workViewKey(url) === workViewKey(view)) return null;
  const named = readWorkUrl(url, rowAt);
  if (named === null || ("view" in named && named.view === "batch" && !reviewable)) {
    return { write: view, replace: true };
  }
  return urlMoved ? { show: named } : { write: view, replace: false };
};
