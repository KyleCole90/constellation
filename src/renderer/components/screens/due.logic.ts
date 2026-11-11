import type { NonEmpty } from "~/renderer/lib/nonEmpty";
import type { NextWork } from "~/shared/agent/agent";
import type { SchoolId } from "~/shared/domain/ids";
import type { Course, School } from "~/shared/domain/lms";
import { peopleWords, workName } from "~/shared/domain/workName";
import {
  hasWorkToGrade,
  NOT_STARTED,
  type DueExtras,
  type DueGroup,
  type DueItem,
  type InboxRow,
  type ThreadStatus,
  type WorkStage,
  WEEK_AHEAD,
} from "~/renderer/stores/selectors";

export type SchoolFilter = SchoolId | "all";

export const inSchool = (filter: SchoolFilter, school: SchoolId): boolean =>
  filter === "all" || filter === school;

export const filterDue = (groups: readonly DueGroup[], filter: SchoolFilter): readonly DueGroup[] =>
  groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => inSchool(filter, item.school.id)),
    }))
    .filter((group) => group.items.length > 0);

export const filterExtras = (extras: DueExtras, filter: SchoolFilter): DueExtras => ({
  drafts: extras.drafts.filter((draft) => inSchool(filter, draft.school.id)),
  unread: extras.unread.filter((row) => inSchool(filter, row.school.id)),
});

export const nothingDueWords = (filter: SchoolFilter, someDisconnected: boolean): string => {
  if (filter !== "all") return "Nothing is due at this school.";
  return someDisconnected
    ? "Nothing is due where you're connected."
    : "Nothing is due, and nothing is waiting on you.";
};

const counted = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

export interface DueProgress {
  label: string;
  /** Null hides the bar, because future work has nothing to measure yet. */
  fraction: number | null;
}

export const dueProgress = (item: DueItem): DueProgress => {
  if (item.submitted === 0) return { label: "Nothing submitted yet", fraction: null };
  return {
    label: `${item.graded} of ${item.total} graded`,
    fraction: item.total > 0 ? item.graded / item.total : 0,
  };
};

type Work =
  | { kind: "reconnect"; school: School }
  | { kind: "grade"; item: DueItem }
  | { kind: "announcement"; draft: DueExtras["drafts"][number] }
  | { kind: "replies"; rows: NonEmpty<InboxRow> };

export interface PlannedWork {
  key: string;
  work: Work;
  school: School;
  courseCode: string | null;
  verb: "Reconnect" | "Grade" | "Write" | "Post" | "Reply to" | "Fix" | "Review";
  title: string;
  detail: string;
  detailTone: ThreadStatus["tone"];
  why: string;
}

export const stepInstruction = ({ work, verb, title }: PlannedWork): string => {
  switch (work.kind) {
    case "reconnect":
      return `${verb} ${title}`;
    case "grade":
      return verb === "Grade"
        ? workName({ kind: "grading", assignment: title })
        : `${verb} grades for ${title}`;
    case "announcement":
      return `${verb} ${verb === "Write" ? "the announcement" : "draft"}: ${title}`;
    case "replies": {
      const people = work.rows.map((row) => row.conversation.from);
      return verb === "Reply to"
        ? workName({ kind: "replies", people })
        : `${verb} the ${people.length > 1 ? "replies" : "reply"} to ${peopleWords(people)}`;
    }
  }
};

export interface WorkPlan {
  steps: readonly PlannedWork[];
  /** Every deadline still open, in due order. Sittings are named after the first one in their course. */
  open: readonly DueItem[];
  /** The open deadlines this week with nothing to grade yet. Later ones, such as next term's, wait for their week. */
  notYet: readonly DueItem[];
  totals: { toGrade: number; unread: number; drafts: number };
}

export interface PlanInput {
  groups: readonly DueGroup[];
  extras: DueExtras;
  stages: ReadonlyMap<string, WorkStage>;
  expired: readonly School[];
  now: number;
}

export const dueSummary = ({ toGrade, unread, drafts }: WorkPlan["totals"]): string =>
  `${counted(toGrade, "submission")} to grade, ${counted(unread, "unread message")}, ${counted(drafts, "unsent announcement")}.`;

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const DAY = 86_400_000;

const EVENING_HOUR = 17;
const DAYS_A_WEEKDAY_IS_UNAMBIGUOUS = 7;

export const whenWords = (days: number, dueAt: string | null): string => {
  if (!dueAt) return "soon";
  const at = new Date(dueAt);
  if (days === 0)
    return at.getHours() >= EVENING_HOUR
      ? "tonight"
      : `today at ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  if (days === 1) return "tomorrow";
  if (days > 0 && days < DAYS_A_WEEKDAY_IS_UNAMBIGUOUS) return WEEKDAY.format(at);
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const STAGE_RANK: Readonly<Record<WorkStage, number>> = { stuck: 1, review: 2 };
const NO_STAGE = 3;
const KIND_RANK: Readonly<Record<Work["kind"], number>> = {
  reconnect: 0,
  grade: 1,
  announcement: 2,
  replies: 3,
};

const draftStage = (tone: DueExtras["drafts"][number]["status"]["tone"]): WorkStage | null =>
  tone === "attention" ? "stuck" : tone === "ready" || tone === "approval" ? "review" : null;

const stageRank = (stage: WorkStage | null): number => (stage ? STAGE_RANK[stage] : NO_STAGE);

const stageVerb = (stage: WorkStage | null, plain: PlannedWork["verb"]): PlannedWork["verb"] =>
  stage === "stuck" ? "Fix" : stage === "review" ? "Review" : plain;

const stageWhy = (stage: WorkStage): string =>
  stage === "stuck"
    ? "A send needs your attention before anything else reaches students."
    : "Drafts are ready for you to review before they reach students.";

export const planWork = ({ groups, extras, stages, expired, now }: PlanInput): WorkPlan => {
  const items = groups.flatMap((group) => group.items);
  const isOpen = (item: DueItem): boolean =>
    item.assignment.dueAt !== null && new Date(item.assignment.dueAt).getTime() > now;
  const open = items.filter(isOpen);
  const nextIn = new Map<string, DueItem>();
  for (const item of open) if (!nextIn.has(item.course.ref)) nextIn.set(item.course.ref, item);
  const deadlineOf = (course: string): number => {
    const dueAt = nextIn.get(course)?.assignment.dueAt;
    return dueAt ? new Date(dueAt).getTime() : Number.POSITIVE_INFINITY;
  };
  const beforeWords = (course: string, lead: string): string | null => {
    const next = nextIn.get(course);
    return next
      ? `${lead} ${next.assignment.shortTitle}, due ${whenWords(next.days, next.assignment.dueAt)}.`
      : null;
  };

  /** Stage, then deadline, then kind, then age: earlier sorts first at each place. */
  type Rank = readonly [number, number, number, number];
  const byRank = (a: Rank, b: Rank): number =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
  const ranked: { rank: Rank; step: PlannedWork }[] = [];
  for (const school of expired) {
    ranked.push({
      rank: [0, 0, KIND_RANK.reconnect, 0],
      step: {
        key: `reconnect:${school.id}`,
        work: { kind: "reconnect", school },
        school,
        courseCode: null,
        verb: "Reconnect",
        title: school.name,
        detail: "Sign-in expired",
        detailTone: "attention",
        why: "Nothing reaches students at this school until you do.",
      },
    });
  }
  for (const item of items) {
    const course = item.course.ref;
    const stage = stages.get(item.assignment.ref) ?? null;
    if (!stage && !hasWorkToGrade(item)) continue;
    const late = -item.days;
    ranked.push({
      rank: [
        stageRank(stage),
        deadlineOf(course),
        KIND_RANK.grade,
        new Date(item.assignment.dueAt ?? 0).getTime(),
      ],
      step: {
        key: `grade:${item.assignment.ref}`,
        work: { kind: "grade", item },
        school: item.school,
        courseCode: item.course.code,
        verb: stageVerb(stage, "Grade"),
        title: item.assignment.shortTitle,
        detail:
          item.late > 0
            ? `${counted(item.toGrade, "submission")}, ${item.late} late`
            : counted(item.toGrade, "submission"),
        detailTone: "todo",
        why: stage
          ? stageWhy(stage)
          : isOpen(item)
            ? `Turned in early. Due ${whenWords(item.days, item.assignment.dueAt)}.`
            : (beforeWords(course, "Students need this back before") ??
              `${counted(late, "day")} past due.`),
      },
    });
  }
  for (const draft of extras.drafts) {
    const course = draft.course.ref;
    const stage = draftStage(draft.status.tone);
    ranked.push({
      rank: [stageRank(stage), deadlineOf(course), KIND_RANK.announcement, 0],
      step: {
        key: `announcement:${draft.thread.id}`,
        work: { kind: "announcement", draft },
        school: draft.school,
        courseCode: draft.course.code,
        verb: stageVerb(stage, draft.drafted ? "Post" : "Write"),
        title: draft.name,
        detail: draft.status.label,
        detailTone: draft.status.tone,
        why: stage
          ? stageWhy(stage)
          : (beforeWords(course, "Students should read this before") ?? "Still unsent."),
      },
    });
  }
  const repliesByStage = new Map<
    string,
    { course: string; stage: WorkStage | null; rows: [InboxRow, ...InboxRow[]] }
  >();
  for (const row of extras.unread) {
    const stage = stages.get(row.conversation.ref) ?? null;
    const key = `${row.course.ref}:${stage ?? "open"}`;
    const group = repliesByStage.get(key);
    if (group) group.rows.push(row);
    else repliesByStage.set(key, { course: row.course.ref, stage, rows: [row] });
  }
  for (const [key, { course, stage, rows }] of repliesByStage) {
    const [first] = rows;
    const oldest = Math.min(
      ...rows.map((row) => (row.last ? new Date(row.last.at).getTime() : now)),
    );
    const waited = Math.max(0, Math.floor((now - oldest) / DAY));
    const statuses = new Map(
      rows.map((row) => [
        row.summary?.label ?? NOT_STARTED.label,
        row.summary?.tone ?? NOT_STARTED.tone,
      ]),
    );
    ranked.push({
      rank: [stageRank(stage), deadlineOf(course), KIND_RANK.replies, oldest],
      step: {
        key: `replies:${key}`,
        work: { kind: "replies", rows },
        school: first.school,
        courseCode: first.course.code,
        verb: stageVerb(stage, "Reply to"),
        title: rows.map((row) => row.conversation.from).join(", "),
        detail: [...statuses.keys()].join(", "),
        // One label means one status, so the first row's tone is everyone's.
        detailTone: statuses.size === 1 ? (first.summary?.tone ?? NOT_STARTED.tone) : "todo",
        why: stage
          ? stageWhy(stage)
          : (beforeWords(course, "They're asking ahead of") ??
            (waited > 0 ? `Waiting ${counted(waited, "day")}.` : "Waiting since today.")),
      },
    });
  }
  ranked.sort(
    (a, b) =>
      byRank(a.rank, b.rank) || (a.step.courseCode ?? "").localeCompare(b.step.courseCode ?? ""),
  );
  return {
    steps: ranked.map((entry) => entry.step),
    open,
    notYet: open.filter((item) => !hasWorkToGrade(item) && item.days <= WEEK_AHEAD),
    totals: {
      toGrade: items.reduce((sum, item) => sum + item.toGrade, 0),
      unread: extras.unread.length,
      drafts: extras.drafts.length,
    },
  };
};

export interface Sitting {
  key: string;
  school: School;
  course: Course | null;
  before: DueItem | null;
  steps: readonly PlannedWork[];
}

const courseOf = (work: Work): Course | null => {
  switch (work.kind) {
    case "reconnect":
      return null;
    case "grade":
      return work.item.course;
    case "announcement":
      return work.draft.course;
    case "replies":
      return work.rows[0].course;
  }
};

export const sittingsOf = ({
  steps,
  open,
}: Pick<WorkPlan, "steps" | "open">): readonly Sitting[] => {
  const sittings = new Map<string, Sitting & { steps: PlannedWork[] }>();
  for (const step of steps) {
    const course = courseOf(step.work);
    const key = course?.ref ?? step.key;
    const sitting = sittings.get(key);
    if (sitting) sitting.steps.push(step);
    else
      sittings.set(key, {
        key,
        school: step.school,
        course,
        before: open.find((item) => item.course.ref === course?.ref) ?? null,
        steps: [step],
      });
  }
  return [...sittings.values()];
};

export const plannedHandoffs = (plan: Pick<WorkPlan, "steps" | "open">): readonly NextWork[] => {
  const handoffs = sittingsOf(plan)
    .flatMap((sitting) => sitting.steps.slice(0, 1))
    .flatMap(({ work }): readonly NextWork[] => {
      switch (work.kind) {
        case "reconnect":
          return [];
        case "grade":
          return [
            {
              course: work.item.course.ref,
              work: { kind: "grading", assignment: work.item.assignment.ref },
            },
          ];
        case "announcement":
          return [{ course: work.draft.course.ref, work: { kind: "announcement" } }];
        case "replies":
          return [{ course: work.rows[0].course.ref, work: { kind: "replies" } }];
      }
    });
  return [...new Map(handoffs.map((handoff) => [JSON.stringify(handoff), handoff])).values()];
};

export const sittingName = ({ course, school }: Sitting): string => course?.code ?? school.name;

export const sittingWhen = ({ course, before }: Sitting): string => {
  if (!course) return "before anything else";
  return before
    ? `before ${before.assignment.shortTitle}, due ${whenWords(before.days, before.assignment.dueAt)}`
    : "no deadline coming up";
};

const SITTING_WORDS: Readonly<Record<PlannedWork["verb"], (count: number) => string>> = {
  Reconnect: () => "sign-in expired",
  Fix: (count) => `${count} to fix`,
  Review: (count) => `${count} to review`,
  Grade: (count) => `${count} to grade`,
  Write: (count) => `${count} to write`,
  Post: (count) => `${count} to post`,
  "Reply to": (count) => counted(count, "reply", "replies"),
};

const stepSize = ({ work }: PlannedWork): number =>
  work.kind === "grade" ? work.item.toGrade : work.kind === "replies" ? work.rows.length : 1;

export const sittingLoad = ({ steps }: Sitting): string => {
  const load = new Map<PlannedWork["verb"], number>();
  for (const step of steps) load.set(step.verb, (load.get(step.verb) ?? 0) + stepSize(step));
  return [...load].map(([verb, count]) => SITTING_WORDS[verb](count)).join(", ");
};

const DEADLINE_DRIVEN: ReadonlySet<PlannedWork["verb"]> = new Set([
  "Grade",
  "Write",
  "Post",
  "Reply to",
]);

export const stepReason = (step: PlannedWork, sitting: Sitting): string | null =>
  sitting.before && DEADLINE_DRIVEN.has(step.verb) ? null : step.why;
