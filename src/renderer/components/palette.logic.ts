import { courseName, type CourseShell } from "~/shared/domain/content";
import type { LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import {
  canResetDemo,
  type Assignment,
  type Course,
  type School,
  type Student,
  type Submission,
} from "~/shared/domain/lms";
import { INBOX_THREAD, ofAddedSchools } from "~/renderer/stores/selectors";
import type { ConnectionRecord, Thread } from "~/renderer/stores/types";

type PaletteTarget =
  | { kind: "thread"; id: ThreadId }
  | { kind: "course"; course: Course }
  | { kind: "setup"; course: LmsRef<"course"> }
  | { kind: "course-page"; course: Course; page: "gradebook" | "announcements" }
  | { kind: "assignment"; assignment: Assignment }
  /** An assignment with nothing to grade opens on its scores, not an empty grading list (#135). */
  | { kind: "gradebook-column"; assignment: Assignment }
  | { kind: "student"; student: Student; submission: Submission }
  /** A student with nothing to grade opens on their scores, the way the roster does (#141). */
  | { kind: "gradebook-row"; student: Student }
  | { kind: "screen"; to: "/due" | "/inbox" | "/calendar" | "/settings" }
  | { kind: "reset-demo" }
  | { kind: "sync"; school: SchoolId };

export interface PaletteEntry {
  key: string;
  group:
    | "Screens"
    | "Actions"
    | "Threads"
    | "Courses"
    | "Assignments"
    | "Course pages"
    | "Students";
  title: string;
  hint: string;
  /** Work waits on the teacher here, so it ranks first in its group and no cap hides it. */
  waiting: boolean;
  school: School["id"] | null;
  target: PaletteTarget;
}

const SCREENS: readonly PaletteEntry[] = [
  {
    key: "screen:/due",
    group: "Screens",
    title: "What's due",
    hint: "Screen",
    waiting: false,
    school: null,
    target: { kind: "screen", to: "/due" },
  },
  {
    key: "screen:/inbox",
    group: "Screens",
    title: "Messages",
    hint: "Inbox",
    waiting: false,
    school: null,
    target: { kind: "screen", to: "/inbox" },
  },
  {
    key: "screen:/calendar",
    group: "Screens",
    title: "Calendar",
    hint: "Screen",
    waiting: false,
    school: null,
    target: { kind: "screen", to: "/calendar" },
  },
  {
    key: "screen:/settings",
    group: "Screens",
    title: "Settings",
    hint: "Screen",
    waiting: false,
    school: null,
    target: { kind: "screen", to: "/settings" },
  },
];

const RESET_DEMO: PaletteEntry = {
  key: "action:reset-demo",
  group: "Actions",
  title: "Reset demo data",
  hint: "Asks first",
  waiting: false,
  school: null,
  target: { kind: "reset-demo" },
};

export const buildEntries = (input: {
  threads: readonly (Thread & { toApprove: boolean })[];
  schools: readonly School[];
  connections: Readonly<Record<SchoolId, ConnectionRecord>>;
  courses: readonly Course[];
  shells: readonly CourseShell[];
  assignments: readonly Assignment[];
  students: readonly Student[];
  /** The work every to-grade count counts, so a result that says "to grade" opens work that is. */
  toGrade: readonly Submission[];
}): readonly PaletteEntry[] => {
  const codeOf = (ref: Thread["course"]) =>
    input.courses.find((course) => course.ref === ref)?.code ?? "All courses";
  const withCount = (code: string, count: number) =>
    count > 0 ? `${code}, ${count} to grade` : code;
  return [
    ...SCREENS,
    ...(canResetDemo(input.schools) ? [RESET_DEMO] : []),
    ...input.schools
      .filter((school) => input.connections[school.id]?.status === "connected")
      .map((school): PaletteEntry => ({
        key: `sync:${school.id}`,
        group: "Actions",
        title: `Sync ${school.name}`,
        hint: "Reads the LMS",
        waiting: false,
        school: school.id,
        target: { kind: "sync", school: school.id },
      })),
    ...ofAddedSchools(input.threads, input.schools)
      .filter((thread) => thread.id !== INBOX_THREAD)
      .map((thread): PaletteEntry => ({
        key: `thread:${thread.id}`,
        group: "Threads",
        title: thread.title,
        hint:
          thread.kind === "north-star-chat"
            ? "North Star chat"
            : thread.toApprove
              ? `${codeOf(thread.course)}, to approve`
              : codeOf(thread.course),
        waiting: thread.toApprove,
        school: thread.school,
        target: { kind: "thread", id: thread.id },
      })),
    ...input.courses.map((course): PaletteEntry => ({
      key: `course:${course.ref}`,
      group: "Courses",
      title: courseName(course),
      hint: course.section ?? "",
      waiting: false,
      school: course.school,
      target: { kind: "course", course },
    })),
    ...input.shells.map((shell): PaletteEntry => ({
      key: `setup:${shell.ref}`,
      group: "Courses",
      title: courseName(shell),
      hint: shell.termName ? `${shell.termName} setup` : "Setup",
      waiting: false,
      school: shell.school,
      target: { kind: "setup", course: shell.ref },
    })),
    ...input.assignments.map((assignment): PaletteEntry => {
      const count = input.toGrade.filter((s) => s.assignment === assignment.ref).length;
      return {
        key: `assignment:${assignment.ref}`,
        group: "Assignments",
        title: assignment.title,
        hint:
          count > 0
            ? withCount(codeOf(assignment.course), count)
            : `${codeOf(assignment.course)}, gradebook`,
        waiting: count > 0,
        school: assignment.school,
        target:
          count > 0 ? { kind: "assignment", assignment } : { kind: "gradebook-column", assignment },
      };
    }),
    ...input.courses.flatMap((course) =>
      (["gradebook", "announcements"] as const).map((page): PaletteEntry => ({
        key: `${page}:${course.ref}`,
        group: "Course pages",
        title: `${course.code} ${page}`,
        hint: course.title,
        waiting: false,
        school: course.school,
        target: { kind: "course-page", course, page },
      })),
    ),
    ...input.students.map((student): PaletteEntry => {
      const submission =
        input.toGrade.find((s) => s.student === student.ref && s.course === student.course) ?? null;
      return {
        key: `student:${student.ref}`,
        group: "Students",
        title: student.name,
        hint: submission ? `${codeOf(student.course)}, to grade` : codeOf(student.course),
        waiting: submission !== null,
        school: student.school,
        target: submission
          ? { kind: "student", student, submission }
          : { kind: "gradebook-row", student },
      };
    }),
  ];
};

const CAP_PER_GROUP = 6;
const MID_WORD_MIN_LENGTH = 3;
const HINT_HIT_PENALTY = 1;
const HIDDEN_UNTIL_TYPED: ReadonlySet<PaletteEntry["group"]> = new Set([
  "Students",
  "Assignments",
  "Course pages",
]);

interface Token {
  text: string;
  inTitle: boolean;
}

const wordsOf = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const tokensOf = (text: string, inTitle: boolean): readonly Token[] => {
  const words = wordsOf(text);
  const pairs = words.slice(1).map((word, i) => `${words[i]}${word}`);
  return [...words, ...pairs].map((token) => ({ text: token, inTitle }));
};

const tierOf = (word: string, token: string): number => {
  if (token === word) return 3;
  if (token.startsWith(word)) return 2;
  return word.length >= MID_WORD_MIN_LENGTH && token.includes(word) ? 1 : 0;
};

const wordScore = (word: string, tokens: readonly Token[]): number =>
  Math.max(
    0,
    ...tokens.map((token) => {
      const tier = tierOf(word, token.text);
      return tier === 0 ? 0 : 2 * tier - (token.inTitle ? 0 : HINT_HIT_PENALTY);
    }),
  );

const scoreOf = (words: readonly string[], tokens: readonly Token[]): number => {
  let total = 0;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    const joined = `${word}${words[i + 1] ?? ""}`;
    if (i + 1 < words.length && tokens.some((token) => token.text === joined)) {
      total += wordScore(joined, tokens);
      i += 1;
      continue;
    }
    const score = wordScore(word, tokens);
    if (score === 0) return 0;
    total += score;
  }
  return total;
};

export const filterEntries = (
  entries: readonly PaletteEntry[],
  query: string,
): readonly PaletteEntry[] => {
  const words = wordsOf(query);
  const groups = new Map<PaletteEntry["group"], { entry: PaletteEntry; score: number }[]>();
  for (const entry of entries) {
    const score =
      words.length === 0
        ? Number(!HIDDEN_UNTIL_TYPED.has(entry.group))
        : scoreOf(words, [...tokensOf(entry.title, true), ...tokensOf(entry.hint, false)]);
    if (score === 0) continue;
    const group = groups.get(entry.group) ?? [];
    group.push({ entry, score });
    groups.set(entry.group, group);
  }
  const best = (hits: readonly { score: number }[]) => Math.max(...hits.map((hit) => hit.score));
  return [...groups.values()]
    .map((hits) => {
      hits.sort((a, b) => Number(b.entry.waiting) - Number(a.entry.waiting) || b.score - a.score);
      const waiting = hits.filter((hit) => hit.entry.waiting).length;
      return hits.slice(0, Math.max(CAP_PER_GROUP, waiting));
    })
    .sort((a, b) => best(b) - best(a))
    .flatMap((hits) => hits.map((hit) => hit.entry));
};
