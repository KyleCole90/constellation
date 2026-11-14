import { courseName, type CourseShell } from "~/shared/domain/content";
import type { LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import type { Course, School, Student, Submission } from "~/shared/domain/lms";
import { INBOX_THREAD } from "~/renderer/stores/selectors";
import type { ConnectionRecord, Thread } from "~/renderer/stores/types";

type PaletteTarget =
  | { kind: "thread"; id: ThreadId }
  | { kind: "course"; course: Course }
  | { kind: "setup"; course: LmsRef<"course"> }
  | { kind: "course-page"; course: Course; page: "gradebook" | "announcements" }
  | { kind: "student"; student: Student; submission: Submission | null }
  | { kind: "screen"; to: "/due" | "/inbox" | "/calendar" | "/settings" }
  | { kind: "reset-demo" }
  | { kind: "sync"; school: SchoolId };

export interface PaletteEntry {
  key: string;
  group: "Screens" | "Actions" | "Threads" | "Courses" | "Course pages" | "Students";
  title: string;
  hint: string;
  school: School["id"] | null;
  target: PaletteTarget;
}

const SCREENS: readonly PaletteEntry[] = [
  {
    key: "screen:/due",
    group: "Screens",
    title: "What's due",
    hint: "Screen",
    school: null,
    target: { kind: "screen", to: "/due" },
  },
  {
    key: "screen:/inbox",
    group: "Screens",
    title: "Messages",
    hint: "Inbox",
    school: null,
    target: { kind: "screen", to: "/inbox" },
  },
  {
    key: "screen:/calendar",
    group: "Screens",
    title: "Calendar",
    hint: "Screen",
    school: null,
    target: { kind: "screen", to: "/calendar" },
  },
  {
    key: "screen:/settings",
    group: "Screens",
    title: "Settings",
    hint: "Screen",
    school: null,
    target: { kind: "screen", to: "/settings" },
  },
];

const RESET_DEMO: PaletteEntry = {
  key: "action:reset-demo",
  group: "Actions",
  title: "Reset demo data",
  hint: "Asks first",
  school: null,
  target: { kind: "reset-demo" },
};

export const buildEntries = (input: {
  threads: readonly (Thread & { toApprove: boolean })[];
  schools: readonly School[];
  connections: Readonly<Record<SchoolId, ConnectionRecord>>;
  courses: readonly Course[];
  shells: readonly CourseShell[];
  students: readonly Student[];
  submissions: readonly Submission[];
}): readonly PaletteEntry[] => {
  const codeOf = (ref: Thread["course"]) =>
    input.courses.find((course) => course.ref === ref)?.code ?? "All courses";
  return [
    ...SCREENS,
    RESET_DEMO,
    ...input.schools
      .filter((school) => input.connections[school.id]?.status === "connected")
      .map((school): PaletteEntry => ({
        key: `sync:${school.id}`,
        group: "Actions",
        title: `Sync ${school.name}`,
        hint: "Reads the LMS",
        school: school.id,
        target: { kind: "sync", school: school.id },
      })),
    ...input.threads
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
        school: thread.school,
        target: { kind: "thread", id: thread.id },
      })),
    ...input.courses.map((course): PaletteEntry => ({
      key: `course:${course.ref}`,
      group: "Courses",
      title: courseName(course),
      hint: course.section ?? "",
      school: course.school,
      target: { kind: "course", course },
    })),
    ...input.shells.map((shell): PaletteEntry => ({
      key: `setup:${shell.ref}`,
      group: "Courses",
      title: courseName(shell),
      hint: shell.termName ? `${shell.termName} setup` : "Setup",
      school: shell.school,
      target: { kind: "setup", course: shell.ref },
    })),
    ...input.courses.flatMap((course) =>
      (["gradebook", "announcements"] as const).map((page): PaletteEntry => ({
        key: `${page}:${course.ref}`,
        group: "Course pages",
        title: `${course.code} ${page}`,
        hint: course.title,
        school: course.school,
        target: { kind: "course-page", course, page },
      })),
    ),
    ...input.students.map((student): PaletteEntry => {
      const submission =
        input.submissions.find((s) => s.student === student.ref && s.workflow === "submitted") ??
        null;
      return {
        key: `student:${student.ref}`,
        group: "Students",
        title: student.name,
        hint: submission ? `${codeOf(student.course)}, to grade` : codeOf(student.course),
        school: student.school,
        target: { kind: "student", student, submission },
      };
    }),
  ];
};

const CAP_PER_GROUP = 6;
const MID_WORD_MIN_LENGTH = 3;
const HINT_HIT_PENALTY = 1;
const HIDDEN_UNTIL_TYPED: ReadonlySet<PaletteEntry["group"]> = new Set([
  "Students",
  "Course pages",
]);

interface Token {
  text: string;
  inTitle: boolean;
}

const tokensOf = (text: string, inTitle: boolean): readonly Token[] => {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
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
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
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
  return [...groups.values()]
    .map((hits) => hits.sort((a, b) => b.score - a.score).slice(0, CAP_PER_GROUP))
    .sort((a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0))
    .flatMap((hits) => hits.map((hit) => hit.entry));
};
