import { riskOf, type ChangeRecord, type ChangeSummary } from "~/shared/domain/change";
import type { CourseShell, SourceCourse } from "~/shared/domain/content";
import type { ChangeId, IsoDate, LmsRef, Result } from "~/shared/domain/ids";
import { longDate, quoteWords } from "~/shared/domain/preview";
import type { FindingKey, FindingType } from "~/shared/domain/scan";
import {
  readinessGroupOf,
  isOpenRow,
  type CourseSetup,
  type ReadinessGroup,
  type ReviewRow,
} from "~/shared/domain/setup";
import {
  draftOf,
  draftTerm,
  isoDate,
  planDays,
  planProblems,
  termName,
  type DraftDate,
  type DraftTerm,
  type PlanDraft,
  type TermDates,
  type TermPlan,
  type Weekday,
} from "~/shared/domain/term";

// ---- Dates. ----

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
export const DAY_SHORT: Readonly<Record<Weekday, string>> = {
  0: "Su",
  1: "Mo",
  2: "Tu",
  3: "We",
  4: "Th",
  5: "Fr",
  6: "Sa",
};
const DAY_NAME: Readonly<Record<Weekday, string>> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

const sorted = (days: readonly Weekday[]): readonly Weekday[] => [...days].sort((a, b) => a - b);

export const toggleDay = (days: readonly Weekday[], day: Weekday): readonly Weekday[] =>
  days.includes(day) ? days.filter((held) => held !== day) : sorted([...days, day]);

/** With as many new days as old days already chosen, a click moves the nearest chosen day here, so Tue/Thu to Mon/Wed is two clicks and never passes through a wrong count. */
export const toggleNewDay = (
  days: readonly Weekday[],
  day: Weekday,
  oldDays: readonly Weekday[],
): readonly Weekday[] => {
  if (
    days.includes(day) ||
    days.length < oldDays.length ||
    days.length === 0 ||
    oldDays.length === 0
  )
    return toggleDay(days, day);
  const nearest = days.reduce((best, held) =>
    Math.abs(held - day) < Math.abs(best - day) ? held : best,
  );
  return sorted([...days.filter((held) => held !== nearest), day]);
};

export const dayMapWords = (oldDays: readonly Weekday[], newDays: readonly Weekday[]): string => {
  if (oldDays.length === 0 || newDays.length === 0)
    return "Each due date moves from an old meeting day to the matching new one, so pick the days the class meets.";
  const map = planDays(oldDays, newDays);
  const moved = sorted(oldDays).filter((day) => map[day] !== day);
  return moved.length === 0
    ? "Meeting days stay the same."
    : `${moved.map((day) => `${DAY_NAME[day]} becomes ${DAY_NAME[map[day]]}`).join(", ")}.`;
};

/** What was last typed wins, then a plan already confirmed. Otherwise the source or its hint fills the old term, and the course fills the new one. */
export const initialPlan = (
  setup: Pick<CourseSetup, "plan" | "draft" | "shell" | "source">,
  source: SourceCourse | null,
): PlanDraft => {
  if (setup.draft) return setup.draft;
  if (setup.plan) return draftOf(setup.plan);
  const hint = setup.source?.kind === "cartridge" ? setup.source.hint : null;
  const oldTerm: DraftTerm = source
    ? {
        name: source.termName,
        start: source.startAt ?? "",
        end: source.endAt ?? "",
        days: source.meetingDays,
      }
    : hint
      ? draftTerm(hint)
      : { name: "", start: "", end: "", days: [] };
  return {
    oldTerm,
    newTerm: {
      name: setup.shell.termName,
      start: setup.shell.startAt ?? "",
      end: setup.shell.endAt ?? "",
      days: oldTerm.days,
    },
    breaks: [],
  };
};

/** Null when the old term matches what the package says of its own term, or it says nothing. Every shifted date leans on the old term. */
export const packageTermWords = (
  source: CourseSetup["source"],
  oldTerm: DraftTerm,
): string | null => {
  const hint = source?.kind === "cartridge" ? source.hint : null;
  if (!hint) return null;
  const days = sorted(hint.days)
    .map((day) => DAY_SHORT[day])
    .join("/");
  const differs =
    (hint.start !== "" && hint.start !== oldTerm.start) ||
    (hint.end !== "" && hint.end !== oldTerm.end) ||
    (days !== "" &&
      days !==
        sorted(oldTerm.days)
          .map((day) => DAY_SHORT[day])
          .join("/"));
  if (!differs) return null;
  const span =
    hint.start && hint.end
      ? `${longDate(hint.start)} to ${longDate(hint.end)}`
      : hint.start
        ? `starting ${longDate(hint.start)}`
        : hint.end
          ? `ending ${longDate(hint.end)}`
          : "";
  const about = [span, days && `meeting ${days}`].filter(Boolean).join(", ");
  const from = hint.name ? [hint.name, about].filter(Boolean).join(", ") : `a term ${about}`;
  return `This package comes from ${from}. The old term here doesn't match, so every shifted date would be off.`;
};

const filled = <T extends { start: DraftDate; end: DraftDate }>(
  held: T,
): (Omit<T, "start" | "end"> & { start: IsoDate; end: IsoDate }) | null => {
  const start = isoDate(held.start);
  const end = isoDate(held.end);
  return start && end ? { ...held, start, end } : null;
};
const filledTerm = (held: DraftTerm): TermDates | null => {
  const term = filled(held);
  return term && { ...term, name: termName(term.name) };
};

/** The plan, once every field is filled in and the dates make sense; otherwise what to fix. */
export const checkPlan = (draft: PlanDraft): Result<TermPlan, readonly string[]> => {
  const oldTerm = filledTerm(draft.oldTerm);
  const newTerm = filledTerm(draft.newTerm);
  const breaks = draft.breaks.map((held) => (held.name.trim() ? filled(held) : null));
  const blanks = [
    ...(oldTerm ? [] : ["Fill in the old term's dates."]),
    ...(newTerm ? [] : ["Fill in the new term's dates."]),
    ...breaks.flatMap((held, index) =>
      held ? [] : [`Finish break ${index + 1}: it needs a name, a start, and an end.`],
    ),
  ];
  const complete = breaks.filter((held) => held !== null);
  if (!oldTerm || !newTerm || complete.length < breaks.length) return { ok: false, error: blanks };
  const plan: TermPlan = { oldTerm, newTerm, breaks: complete };
  const problems = planProblems(plan);
  return problems.length > 0 ? { ok: false, error: problems } : { ok: true, value: plan };
};

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Null when the destination is empty. */
export const occupiedWords = ({
  code,
  studentCount,
  itemCount,
}: Pick<CourseShell, "code" | "studentCount" | "itemCount">): string | null =>
  studentCount === 0 && itemCount === 0
    ? null
    : `${code} already has ${count(studentCount, "student")} and ${count(itemCount, "item")}. The copy adds to what is there, and it can't be undone from here.`;

/** Courses with the setup's code first, then templates, then the rest, and never the course being set up. */
export const sourceChoices = (
  sources: readonly SourceCourse[],
  course: LmsRef<"course">,
  code: string,
): readonly SourceCourse[] => {
  const rank = (source: SourceCourse) => (source.code === code ? 0 : 2) + (source.template ? 0 : 1);
  return sources.filter((source) => source.ref !== course).sort((a, b) => rank(a) - rank(b));
};

// ---- Review. ----

const FINDING_LABEL: Readonly<Record<FindingType, string>> = {
  "plain-date": "Dates written in text",
  "date-in-break": "Dates in a break",
  "date-outside-term": "Dates outside the term",
  "old-term-name": "Old term names",
  "old-course-link": "Links to the old course",
  "broken-link": "Broken links",
  "missing-file": "Missing files",
  "lti-link": "External tools",
  "copied-announcement": "Copied announcements",
  "foreign-contact": "Contacts from another school",
  "missing-statement": "Missing statements",
  "unpublished-item": "Unpublished items",
  "empty-module": "Empty modules",
  "migration-issue": "Issues from the copy",
};

export interface RowGroup {
  /** A finding type, or `fixed` for a fix the last scan no longer finds. */
  type: FindingType | "fixed";
  label: string;
  rows: readonly ReviewRow[];
}

export const groupRows = (rows: readonly ReviewRow[]): readonly RowGroup[] => {
  const groups = new Map<RowGroup["type"], ReviewRow[]>();
  for (const row of rows) {
    const type = row.finding?.type ?? "fixed";
    groups.set(type, [...(groups.get(type) ?? []), row]);
  }
  return [...groups].map(([type, members]) => ({
    type,
    label: type === "fixed" ? "Fixed" : FINDING_LABEL[type],
    rows: members,
  }));
};

export const rowName = ({ finding, change, key }: ReviewRow): string =>
  finding?.where ?? change?.subject ?? key;

/** One entry per item, so a page with six things left reads as one link that opens the first of them. */
export const namedRows = (
  rows: readonly ReviewRow[],
): readonly { name: string; count: number; first: ReviewRow }[] => {
  const named = new Map<string, { name: string; count: number; first: ReviewRow }>();
  for (const row of rows) {
    const name = rowName(row);
    const held = named.get(name);
    named.set(name, held ? { ...held, count: held.count + 1 } : { name, count: 1, first: row });
  }
  return [...named.values()];
};

/** What the row quotes, in words a person reads. Null when the name already says it. */
export const rowQuote = (row: ReviewRow): string | null => {
  const quote = row.finding?.quote ?? null;
  return quote === null || quote === rowName(row) ? null : quoteWords(quote);
};

/** The row speaks for itself when settled, and for its change while one is in flight. */
export const rowWord = (
  row: Pick<ReviewRow, "status">,
  summary: ChangeSummary | null,
): { label: string; tone: ChangeSummary["tone"] } => {
  switch (row.status) {
    case "manual":
      return { label: "Do this by hand", tone: "todo" };
    case "checking":
      return { label: "Checking", tone: "working" };
    case "still-here":
      return { label: "Still here", tone: "attention" };
    case "fixed":
      return { label: "Fixed", tone: "done" };
    case "dismissed":
      return { label: "Dismissed", tone: "done" };
    case "handled":
      return { label: "Handled", tone: "done" };
    case "fix": {
      if (!summary) return { label: "Preparing", tone: "working" };
      if (summary.recovery === "rescan") return { label: "Passage moved", tone: "attention" };
      const reset = summary.approvalReset;
      if (
        summary.canApprove &&
        (reset === "edited" || reset === "agent-edited" || reset === "rebased")
      )
        return { label: "Needs approval again", tone: "approval" };
      return { label: summary.label, tone: summary.tone };
    }
  }
};

/** Rows a checkbox can act on: a fix still waiting on approval or on sending. */
export const selectableKeys = (rows: readonly ReviewRow[]): readonly FindingKey[] =>
  rows.filter(({ summary }) => summary?.canApprove || summary?.canSend).map((row) => row.key);

/**
 * Approval follows the checkboxes, and a batch never carries a risky change. Sending follows them too, unless none of the approved
 * rows is checked, so a fix approved on its own row still has a way out.
 */
export const batchOf = (
  rows: readonly ReviewRow[],
  selected: readonly string[],
): { approve: readonly ChangeRecord[]; send: readonly ChangeId[] } => {
  const approve = rows.flatMap(({ key, change, summary }) =>
    change && summary?.canApprove && selected.includes(key) && riskOf(change) === null
      ? [change]
      : [],
  );
  const approved = rows.flatMap(({ key, change, summary }) =>
    change && summary?.canSend ? [{ key, id: change.id }] : [],
  );
  const checked = approved.filter(({ key }) => selected.includes(key));
  return { approve, send: (checked.length > 0 ? checked : approved).map(({ id }) => id) };
};

const READINESS_LABELS: readonly { group: ReadinessGroup; label: string }[] = [
  { group: "dates", label: "Dates outside the term" },
  { group: "findings", label: "Unresolved findings" },
  { group: "empty-modules", label: "Empty modules" },
  { group: "unpublished", label: "Unpublished items" },
];

export const readinessTable = (
  rows: readonly ReviewRow[],
): readonly { group: ReadinessGroup; label: string; left: readonly ReviewRow[] }[] => {
  const open = rows.filter(isOpenRow);
  return READINESS_LABELS.map(({ group, label }) => ({
    group,
    label,
    left: open.filter((row) => readinessGroupOf(row) === group),
  }));
};

const OUTCOMES = [
  ["fixed", (n: number) => `${n} ${n === 1 ? "fix" : "fixes"} sent`],
  ["handled", (n: number) => `${n} handled in the LMS`],
  ["dismissed", (n: number) => `${n} dismissed`],
] as const satisfies readonly (readonly [ReviewRow["status"], (n: number) => string])[];

/** What became of the findings, once publishing has closed them all. Null when the scan found none. */
export const publishedWords = (rows: readonly ReviewRow[]): string | null => {
  const parts = OUTCOMES.flatMap(([status, words]) => {
    const n = rows.filter((row) => row.status === status).length;
    return n ? [words(n)] : [];
  });
  return parts.length
    ? `${new Intl.ListFormat("en", { type: "conjunction" }).format(parts)}.`
    : null;
};
