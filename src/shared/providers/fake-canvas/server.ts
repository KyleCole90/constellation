import { hash53 } from "~/shared/domain/approval";
import {
  copySignature,
  finalGrade,
  scoredRubricPoints,
  type ChangeContent,
  type CourseCopyContent,
  type FieldKey,
  type LmsError,
  type RemoteEntry,
  type RemoteState,
  type SetContent,
  type TextFixContent,
} from "~/shared/domain/change";
import {
  isComing,
  type CourseShell,
  type Migration,
  type SamplePackage,
  type SchoolPolicy,
  type SourceCourse,
} from "~/shared/domain/content";
import {
  isoTime,
  type IsoDate,
  type IsoTime,
  type LmsRef,
  type Result,
  type SchoolId,
} from "~/shared/domain/ids";
import type {
  Announcement,
  Assignment,
  Conversation,
  Course,
  Student,
  Submission,
  SubmissionBody,
} from "~/shared/domain/lms";
import { longDate } from "~/shared/domain/preview";
import { applySplice } from "~/shared/domain/splice";
import { dateOfTime, meetingDaysOf, type Weekday } from "~/shared/domain/term";
import { revealSecret, type Credential, type FieldOutcomes } from "~/shared/providers/provider";

import {
  DEFAULT_NOISE,
  DEMO_CONFLICT,
  DEMO_FAULTS,
  DEMO_PARTIAL,
  DEMO_THROTTLE,
  FaultQueue,
  type ArmedFaults,
  type DemoFault,
  type FaultLab,
  type NoiseConfig,
  type WriteRecord,
} from "./faults";
import {
  advanceMigration,
  copyBody,
  newMigrationRecord,
  toMigration,
  type MigrationRecord,
} from "./migrations";
import { refParts, refs } from "../canvas-refs";
import { assignmentCanvasId, SEED, type SeedAssignment, type SeedCourse } from "./seed";
import {
  COURSE_COPY_ISSUES,
  HOSTS,
  PACKAGES,
  POLICIES,
  SHELLS,
  SOURCES,
  type RawBody,
  type RawItem,
  type RawModule,
  type RawTool,
} from "./seed-term";

export const LMS_STORAGE_KEY = "lms-app.fake-canvas.v1";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Route {
  school: SchoolId;
  kind: "read" | "write";
  label: string;
  /** The connect check is the one call allowed to present a token the server has not seen. */
  verify?: boolean;
}

export interface RequestLogEntry {
  at: number;
  school: SchoolId;
  kind: Route["kind"];
  label: string;
  result: "ok" | LmsError["kind"];
}

interface TokenBook {
  accepted: readonly string[];
  revoked: readonly string[];
}

/** A course for the new term. Kept apart from `courses` until published, because `courses()` lists only what students can reach. */
export interface ShellRow {
  school: SchoolId;
  canvasId: number;
  code: string;
  title: string;
  section: string | null;
  modality: string | null;
  termName: string;
  startAt: IsoDate;
  endAt: IsoDate;
  days: Weekday[];
  workflow_state: "unpublished" | "available";
  template: boolean;
  students: string[];
}
export interface SourceRow {
  school: SchoolId;
  canvasId: number;
  code: string;
  title: string;
  termName: string;
  startAt: IsoDate;
  endAt: IsoDate;
  days: Weekday[];
  template: boolean;
}
interface TermState {
  shells: ShellRow[];
  sources: SourceRow[];
  /** Keyed by course ref, or `pkg:<name>` for a sample package. */
  content: Record<string, RawBody>;
  migrations: MigrationRecord[];
  seq: number;
}

/** What the provider turns into CourseContent. Links are raw because classifying them is the provider's job. */
export interface RawCourseContent {
  shell: CourseShell;
  host: string;
  courseId: number;
  version: string;
  items: readonly RawItem[];
  modules: readonly RawModule[];
  tools: readonly RawTool[];
  policy: SchoolPolicy;
}

interface LmsState {
  version: 1;
  seq: number;
  writes: number;
  tokens: Record<string, TokenBook>;
  courses: Course[];
  assignments: Assignment[];
  students: Student[];
  submissions: Submission[];
  attachments: Record<string, RemoteEntry[]>;
  conversations: Conversation[];
  announcements: Announcement[];
  script: { enabled: boolean; fired: DemoFault[] };
  writeLog: WriteRecord[];
  term: TermState;
  /** Absent until someone changes it in Settings. */
  noise?: NoiseConfig;
}

export interface ServerOptions {
  storage: StorageLike | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  noise?: NoiseConfig;
  demoScript?: boolean;
  quota?: { capacity: number; refillPerSec: number };
  /** How long a copy job runs from start to completion. */
  migrationMs?: number;
}

const DEFAULT_MIGRATION_MS = 4000;
const DAMAGED_FAIL_RATE = 0.4;
const PACKAGE_KEY = "pkg:";
const NO_POLICY: SchoolPolicy = { contactDomain: "", statements: [] };

const DAY = 86_400_000;
const HOUR = 3_600_000;

const clip = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
};

/** Many fixes land on one page, so a write log row names what each one did. */
const whatChanged = (content: TextFixContent | SetContent): string => {
  if (content.kind === "text-fix")
    return content.splice.before === ""
      ? `added "${clip(content.splice.after)}"`
      : `replaced "${clip(content.splice.before)}"`;
  switch (content.intent.set) {
    case "due-at":
      return `due ${longDate(dateOfTime(content.intent.at))}`;
    case "item-published":
    case "course-published":
      return "published";
    case "item-deleted":
      return "deleted";
    case "course-template":
      return "marked as a template";
  }
};

const bodyOf = (assignment: SeedAssignment, index: number): SubmissionBody => {
  const piece = assignment.pieces?.[index % assignment.pieces.length];
  if (!piece) return { kind: "none" };
  if (assignment.kind === "video")
    return {
      kind: "media",
      title: piece.title,
      durationLabel: piece.duration ?? "",
      transcript: piece.doc,
    };
  return { kind: "text", title: piece.title, wordCount: piece.words, paragraphs: piece.doc };
};

const WORKFLOW: Readonly<Record<string, Submission["workflow"]>> = {
  G: "graded",
  N: "submitted",
  L: "submitted",
  R: "submitted",
  M: "missing",
  "-": "unsubmitted",
};

const buildCourse = (state: LmsState, course: SeedCourse, courseIndex: number): void => {
  const school = course.schoolId as SchoolId;
  const courseRef = refs.course(school, course.canvasId);
  const [section, modality] =
    course.section === "hybrid" ? [null, "hybrid"] : course.section.split(", ");
  state.courses.push({
    ref: courseRef,
    school,
    code: course.code,
    title: course.title,
    section: section || null,
    modality: modality ?? null,
    studentCount: course.students.length,
  });
  const userId = (i: number) => 70000 + (course.canvasId % 1000) + i;
  course.students.forEach((name, i) =>
    state.students.push({ ref: refs.student(school, userId(i)), school, course: courseRef, name }),
  );

  course.assignments.forEach((assignment, assignmentIndex) => {
    const assignmentId = assignmentCanvasId(assignment, courseIndex, assignmentIndex);
    const assignmentRef = refs.assignment(school, course.canvasId, assignmentId);
    const criterion = (id: string) => refs.criterion(school, assignmentId, id);
    state.assignments.push({
      ref: assignmentRef,
      school,
      course: courseRef,
      title: assignment.title,
      shortTitle: assignment.short,
      dueAt: isoTime(assignment.due),
      pointsPossible: assignment.pts,
      rubric:
        assignment.rubric?.map((r) => ({ ref: criterion(r.id), name: r.name, maxPoints: r.max })) ??
        null,
      latePointsPerDay: assignment.lateRate ?? null,
    });
    let pieceIndex = 0;
    [...assignment.statuses].forEach((status, i) => {
      const prior = status === "R" ? (assignment.prior?.[i] ?? null) : null;
      const lateDays = status === "L" ? (assignment.lateDays?.[i] ?? 1) : 0;
      const hasWork = status !== "M" && status !== "-";
      const due = new Date(assignment.due).getTime();
      const offset = lateDays
        ? lateDays * DAY - 14 * HOUR
        : prior
          ? 12 * HOUR
          : -(((i * 7) % 20) + 2) * HOUR;
      const gradedScore =
        assignment.fixedGrades?.[i] ?? Math.round(assignment.pts * (0.72 + ((i * 37) % 26) / 100));
      const scores = prior?.scores;
      state.submissions.push({
        ref: refs.submission(school, course.canvasId, assignmentId, userId(i)),
        school,
        course: courseRef,
        assignment: assignmentRef,
        student: refs.student(school, userId(i)),
        studentName: course.students[i] ?? "",
        workflow: WORKFLOW[status] ?? "unsubmitted",
        attempt: !hasWork ? 0 : prior ? 2 : 1,
        lateDays,
        // Early work on an assignment not yet due can't carry a date past today, or it reads as a resubmission after any grade sent now.
        submittedAt: hasWork
          ? isoTime(Math.min(due + offset, new Date(SEED.now).getTime() + offset))
          : null,
        grade: status === "G" ? gradedScore : (prior?.grade ?? null),
        rubricScores: scores
          ? Object.fromEntries(
              Object.entries(scores).map(([id, points]) => [criterion(id), points]),
            )
          : null,
        comments: prior
          ? [
              {
                id: `seed-comment-${userId(i)}`,
                mine: true,
                text: prior.comment,
                at: isoTime(due - DAY),
              },
            ]
          : [],
        body: hasWork
          ? bodyOf(assignment, "NLR".includes(status) ? pieceIndex++ : i)
          : { kind: "none" },
      });
    });
  });

  for (const message of course.messages) {
    state.conversations.push({
      ref: refs.conversation(school, message.canvasId),
      school,
      course: courseRef,
      subject: message.subject,
      from: message.from,
      unread: !message.answer,
      messages: [
        ...message.history.map((entry, i) => ({
          id: `${message.id}-h${i}`,
          mine: entry.mine,
          author: entry.mine ? SEED.instructor : message.from,
          text: entry.text,
          at: isoTime(entry.at),
        })),
        {
          id: `${message.id}-m`,
          mine: false,
          author: message.from,
          text: message.body,
          at: isoTime(message.at),
        },
        ...(message.answer
          ? [
              {
                id: `${message.id}-a`,
                mine: true,
                author: SEED.instructor,
                text: message.answer.text,
                at: isoTime(message.answer.at),
              },
            ]
          : []),
      ],
    });
  }
  for (const announcement of course.announcements) {
    state.announcements.push({
      ref: refs.announcement(school, announcement.id),
      school,
      course: courseRef,
      title: announcement.title,
      body: announcement.body,
      postedAt: isoTime(announcement.at),
    });
  }
};

const freshTerm = (): TermState => {
  const content: Record<string, RawBody> = {};
  const shells = SHELLS.map((shell): ShellRow => {
    const school = shell.school as SchoolId;
    content[refs.course(school, shell.canvasId)] = structuredClone(shell.body);
    return {
      school,
      canvasId: shell.canvasId,
      code: shell.code,
      title: shell.title,
      section: shell.section,
      modality: shell.modality,
      termName: shell.term.name,
      startAt: shell.term.start,
      endAt: shell.term.end,
      days: [...shell.term.days],
      workflow_state: "unpublished",
      template: false,
      students: [...shell.students],
    };
  });
  const sources = SOURCES.map((source): SourceRow => {
    const school = source.school as SchoolId;
    content[refs.course(school, source.canvasId)] = structuredClone(source.body);
    return {
      school,
      canvasId: source.canvasId,
      code: source.code,
      title: source.title,
      termName: source.term.name,
      startAt: source.term.start,
      endAt: source.term.end,
      days: [...source.term.days],
      template: source.template,
    };
  });
  for (const pkg of PACKAGES)
    if (pkg.body) content[`${PACKAGE_KEY}${pkg.name}`] = structuredClone(pkg.body);
  return { shells, sources, content, migrations: [], seq: 0 };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const LMS_LISTS = [
  "courses",
  "assignments",
  "students",
  "submissions",
  "conversations",
  "announcements",
] as const satisfies readonly (keyof LmsState)[];

/**
 * Checks what the server dereferences on load: the version, the counters, every collection and the demo script.
 * A store written before new-term setup or the write log existed has neither; it gets fresh ones and keeps the rest.
 */
const parseStoredLms = (stored: unknown): LmsState | null => {
  if (!isObject(stored) || stored["version"] !== 1) return null;
  const { script, writeLog, term, noise } = stored;
  const valid =
    typeof stored["seq"] === "number" &&
    typeof stored["writes"] === "number" &&
    isObject(stored["tokens"]) &&
    isObject(stored["attachments"]) &&
    LMS_LISTS.every((list) => Array.isArray(stored[list])) &&
    isObject(script) &&
    typeof script["enabled"] === "boolean" &&
    Array.isArray(script["fired"]) &&
    (writeLog === undefined || Array.isArray(writeLog)) &&
    (term === undefined || isObject(term)) &&
    (noise === undefined || isObject(noise));
  if (!valid) return null;
  const state = { ...stored, writeLog: writeLog ?? [], term: term ?? freshTerm() };
  // Checked above as far as the server reads it on load; the elements are the server's own writes.
  return state as unknown as LmsState;
};

const freshState = (demoScript: boolean): LmsState => {
  const state: LmsState = {
    version: 1,
    seq: 0,
    writes: 0,
    tokens: {},
    courses: [],
    assignments: [],
    students: [],
    submissions: [],
    attachments: {},
    conversations: [],
    announcements: [],
    script: { enabled: demoScript, fired: [] },
    writeLog: [],
    term: freshTerm(),
  };
  SEED.courses.forEach((course, index) => buildCourse(state, course, index));
  return state;
};

const courseOfShell = (shell: ShellRow): Course => ({
  ref: refs.course(shell.school, shell.canvasId),
  school: shell.school,
  code: shell.code,
  title: `${shell.title}, ${shell.termName}`,
  section: shell.section,
  modality: shell.modality,
  studentCount: shell.students.length,
});
const INVENTED_STUDENTS = [
  "Avery Lund",
  "Bashir Nasser",
  "Camila Reyes",
  "Devon Park",
  "Esme Whitaker",
  "Felix Oduya",
  "Greta Holm",
  "Hiro Matsuda",
  "Isla Fenwick",
  "Jamal Osei",
  "Kira Volkov",
  "Lena Brandt",
];

const postText = (title: string, body: string) => `${title}\n\n${body}`;

export class FakeCanvasServer implements FaultLab {
  readonly log: RequestLogEntry[] = [];
  readonly #options: ServerOptions;
  readonly #faults: FaultQueue;
  readonly #buckets = new Map<SchoolId, { level: number; at: number }>();
  #state: LmsState;
  #raw: string | null = null;
  readonly #listeners = new Set<() => void>();
  #version = 0;
  /** One-shot and in memory, like the other armed faults. */
  #nextMigrationFailure: { stage: "pre_processing" | "running"; message: string } | null = null;
  #termDatesHidden = false;
  readonly #held: Partial<Record<Route["kind"], { gate: Promise<void>; release: () => void }>> = {};

  constructor(options: ServerOptions) {
    this.#options = options;
    this.#state = freshState(options.demoScript ?? false);
    this.#pull();
    this.#faults = new FaultQueue(options.noise ?? this.#state.noise ?? DEFAULT_NOISE);
  }

  async call<T>(
    route: Route,
    credential: Credential | null,
    work: () => T,
  ): Promise<Result<T, LmsError>> {
    const { noise } = this.#faults;
    const latency =
      noise.latencyMs[0] + this.#options.random() * (noise.latencyMs[1] - noise.latencyMs[0]);
    if (latency > 0) await this.#options.sleep(latency);
    if (!route.verify) await this.#held[route.kind]?.gate;
    this.#pull();
    this.#advanceJobs();
    const result = this.#gate(route, credential, work);
    this.log.push({
      at: this.#options.now(),
      school: route.school,
      kind: route.kind,
      label: route.label,
      result: result.ok ? "ok" : result.error.kind,
    });
    this.#changed();
    return result;
  }

  #gate<T>(route: Route, credential: Credential | null, work: () => T): Result<T, LmsError> {
    const denied = this.#checkToken(route, credential) ?? this.#checkRate(route);
    if (denied) return { ok: false, error: denied };
    const { noise } = this.#faults;
    if (this.#options.random() < noise.rate5xx)
      return { ok: false, error: { kind: "unavailable", status: 503 } };
    if (route.kind === "read") return { ok: true, value: work() };

    const loss =
      this.#faults.takeLoss() ??
      (this.#options.random() < noise.rateLost ? ({ kind: "lost", applied: true } as const) : null);
    if (loss?.kind === "late") {
      void this.#options.sleep(loss.delayMs).then(() => {
        this.#pull();
        work();
        this.#push();
        this.#changed();
      });
      return { ok: false, error: { kind: "lost_response" } };
    }
    if (loss && !loss.applied) return { ok: false, error: { kind: "lost_response" } };
    const value = work();
    this.#push();
    return loss ? { ok: false, error: { kind: "lost_response" } } : { ok: true, value };
  }

  #checkToken(route: Route, credential: Credential | null): LmsError | null {
    const secret =
      credential === null
        ? null
        : credential.kind === "bearer"
          ? credential.token
          : credential.access;
    if (secret === null) return { kind: "auth_expired" };
    const hash = revealSecret(secret, hash53);
    const book = this.#state.tokens[route.school] ?? { accepted: [], revoked: [] };
    if (book.revoked.includes(hash)) return { kind: "auth_expired" };
    if (book.accepted.includes(hash)) return null;
    if (!route.verify) return { kind: "auth_expired" };
    // A demo has no token issuer, so the first verify of any well-formed token issues it.
    this.#state.tokens[route.school] = { ...book, accepted: [...book.accepted, hash] };
    this.#push();
    return null;
  }

  #checkRate(route: Route): LmsError | null {
    if (route.kind === "write") {
      this.#state.writes += 1;
      if (this.#state.writes === DEMO_THROTTLE.onWrite && this.#armDemo("throttle")) {
        this.#push();
        return { kind: "rate_limited", retryAfterMs: DEMO_THROTTLE.retryAfterMs };
      }
    }
    const scripted = this.#faults.takeThrottle(route.kind);
    if (scripted !== null) return { kind: "rate_limited", retryAfterMs: scripted };
    const { capacity, refillPerSec } = this.#options.quota ?? { capacity: 700, refillPerSec: 10 };
    const now = this.#options.now();
    const bucket = this.#buckets.get(route.school) ?? { level: capacity, at: now };
    const level = Math.min(capacity, bucket.level + ((now - bucket.at) / 1000) * refillPerSec);
    const cost = route.kind === "write" ? 10 : 1;
    if (level < cost) {
      this.#buckets.set(route.school, { level, at: now });
      return {
        kind: "rate_limited",
        retryAfterMs: Math.ceil(((cost - level) / refillPerSec) * 1000),
      };
    }
    this.#buckets.set(route.school, { level: level - cost, at: now });
    if (this.#options.random() < this.#faults.noise.rate429)
      return { kind: "rate_limited", retryAfterMs: 2000 };
    return null;
  }

  #armDemo(fault: DemoFault): boolean {
    const { script } = this.#state;
    if (!script.enabled || script.fired.includes(fault)) return false;
    script.fired.push(fault);
    return true;
  }

  #pull(): void {
    const { storage } = this.#options;
    if (!storage) return;
    const raw = storage.getItem(LMS_STORAGE_KEY);
    if (raw === this.#raw && raw !== null) return;
    this.#raw = raw;
    this.#state = this.#parse(raw) ?? freshState(this.#options.demoScript ?? false);
  }

  #parse(raw: string | null): LmsState | null {
    if (raw === null) return null;
    try {
      return parseStoredLms(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  #push(): void {
    const { storage } = this.#options;
    if (!storage) return;
    this.#raw = JSON.stringify(this.#state);
    storage.setItem(LMS_STORAGE_KEY, this.#raw);
  }

  #changed(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  reset(): void {
    this.#options.storage?.removeItem(LMS_STORAGE_KEY);
    this.#raw = null;
    this.#state = freshState(this.#options.demoScript ?? false);
    this.#buckets.clear();
    this.#faults.clear();
    this.#faults.noise = this.#options.noise ?? DEFAULT_NOISE;
    this.#termDatesHidden = false;
    this.#changed();
  }

  // ---- Copy jobs. Clock-driven on every call, so a reload or a long absence changes nothing about where a job stands. ----

  #advanceJobs(): void {
    const now = this.#options.now();
    const duration = this.#options.migrationMs ?? DEFAULT_MIGRATION_MS;
    let changed = false;
    this.#state.term.migrations = this.#state.term.migrations.map((record) => {
      const next = advanceMigration(record, now, duration);
      if (next === record) return record;
      changed = true;
      return next.workflow_state === "completed" && !next.applied ? this.#land(next) : next;
    });
    if (changed) this.#push();
  }

  /** Lands a completed job's content once. Items arrive copied, tools unconfigured, and assignments become real rows. */
  #land(record: MigrationRecord): MigrationRecord {
    const { term } = this.#state;
    const targetRef = refs.course(record.school, record.course_id);
    const sourceKey =
      record.settings.file !== undefined
        ? `${PACKAGE_KEY}${record.settings.file}`
        : refs.course(record.school, record.settings.source_course_id ?? 0);
    const source = term.content[sourceKey];
    const pkg = PACKAGES.find((entry) => entry.name === record.settings.file);
    if (!source) return { ...record, applied: true };
    const copied = copyBody(source, {
      sourceCourseId: pkg?.courseId ?? record.settings.source_course_id ?? 0,
      sourceHost: pkg?.host ?? HOSTS[record.school] ?? "",
      targetCourseId: record.course_id,
      targetHost: HOSTS[record.school] ?? "",
      shift: {
        oldStart: record.date_shift_options.old_start_date as IsoDate,
        oldEnd: record.date_shift_options.old_end_date as IsoDate,
        newStart: record.date_shift_options.new_start_date as IsoDate,
        newEnd: record.date_shift_options.new_end_date as IsoDate,
        substitutions: Object.fromEntries(
          Object.entries(record.date_shift_options.day_substitutions).map(([day, to]) => [
            day,
            to as Weekday,
          ]),
        ),
      },
      nextId: () => 7_000_000 + ++term.seq,
    });
    const target = term.content[targetRef] ?? { items: [], modules: [], tools: [] };
    const toolIds = new Set(target.tools.map((tool) => tool.id));
    term.content[targetRef] = {
      items: [...target.items, ...copied.items],
      modules: [...target.modules, ...copied.modules],
      tools: [...target.tools, ...copied.tools.filter((tool) => !toolIds.has(tool.id))],
    };
    for (const item of copied.items) {
      if (item.type !== "assignment") continue;
      this.#state.assignments.push({
        ref: refs.assignment(record.school, record.course_id, item.id),
        school: record.school,
        course: targetRef,
        title: item.title,
        shortTitle: item.title,
        dueAt: item.dueAt,
        pointsPossible: item.points ?? 0,
        rubric: null,
        latePointsPerDay: null,
      });
    }
    return { ...record, applied: true };
  }

  #shell(courseId: number): ShellRow | undefined {
    return this.#state.term.shells.find((shell) => shell.canvasId === courseId);
  }

  /** Any course a person can save as a template: a new-term course, or one already taught. */
  #courseRow(courseId: number): ShellRow | SourceRow | undefined {
    return (
      this.#shell(courseId) ??
      this.#state.term.sources.find((source) => source.canvasId === courseId)
    );
  }

  #shellOf(ref: LmsRef<"course">): CourseShell | null {
    const [school, , id] = refParts(ref);
    const courseId = Number(id);
    const body = this.#state.term.content[ref];
    const shell = this.#shell(courseId);
    const source = shell
      ? undefined
      : this.#state.term.sources.find((entry) => entry.canvasId === courseId);
    const row = shell ?? source;
    if (!row || !body || school === undefined) return null;
    const studentCount = shell
      ? shell.students.length
      : (this.#state.courses.find((course) => course.ref === ref)?.studentCount ?? 0);
    return {
      ref,
      school: row.school,
      code: row.code,
      title: row.title,
      section: shell?.section ?? null,
      modality: shell?.modality ?? null,
      studentCount,
      termName: row.termName,
      ...this.#dates(row),
      itemCount: body.items.length,
      copyTarget: refs.migrations(row.school, courseId),
      stateTarget: refs.courseState(row.school, courseId),
    };
  }

  #item(
    ref: LmsRef<"item">,
  ): { body: RawBody; item: RawItem; school: SchoolId; courseId: number } | null {
    const [school, , courseId, , id] = refParts(ref);
    if (school === undefined || courseId === undefined) return null;
    const body = this.#state.term.content[refs.course(school, Number(courseId))];
    const item = body?.items.find((entry) => entry.id === Number(id));
    return body && item
      ? { body, item, school: school as SchoolId, courseId: Number(courseId) }
      : null;
  }

  // ---- Reads. Clones, so nothing a caller holds can reach server state. ----

  /** Only what students could reach: the grading courses plus any new-term course that has been published. */
  courses = (school: SchoolId): readonly Course[] =>
    structuredClone([
      ...this.#state.courses.filter((c) => c.school === school),
      ...this.#state.term.shells
        .filter((shell) => shell.school === school && shell.workflow_state === "available")
        .map(courseOfShell),
    ]);
  newCourses = (school: SchoolId): readonly CourseShell[] => {
    const today = dateOfTime(isoTime(this.#options.now()));
    return this.#state.term.shells
      .filter(
        (shell) =>
          shell.school === school &&
          shell.workflow_state === "unpublished" &&
          isComing({ concluded: false, startAt: this.#dates(shell).startAt }, today),
      )
      .flatMap((shell) => this.#shellOf(refs.course(school, shell.canvasId)) ?? []);
  };
  /** A new-term course joins the list once it is saved as a template. */
  copySources = (school: SchoolId): readonly SourceCourse[] =>
    [...this.#state.term.sources, ...this.#state.term.shells.filter((shell) => shell.template)]
      .filter((source) => source.school === school)
      .map((source): SourceCourse => {
        const ref = refs.course(school, source.canvasId);
        const dated = (this.#state.term.content[ref]?.items ?? []).flatMap((item) =>
          item.dueAt === null
            ? []
            : [
                {
                  ref: refs.item(school, source.canvasId, item.type, item.id),
                  title: item.title,
                  dueAt: item.dueAt,
                },
              ],
        );
        return {
          ref,
          code: source.code,
          title: source.title,
          termName: source.termName,
          ...this.#dates(source),
          // As real Canvas: it keeps no meeting pattern, so the days come from the due dates.
          meetingDays: meetingDaysOf(dated.map((item) => dateOfTime(item.dueAt))),
          template: source.template,
          dated,
        };
      })
      .sort((a, b) => Number(b.template) - Number(a.template));
  courseContent = (course: LmsRef<"course">): RawCourseContent | null => {
    const shell = this.#shellOf(course);
    const body = this.#state.term.content[course];
    if (!shell || !body) return null;
    const row = this.#shell(shell.ref === course ? Number(refParts(course)[2]) : 0);
    const version = hash53(
      JSON.stringify([
        body.items.map((item) => [item.id, item.version, item.published, item.dueAt]),
        body.modules,
        body.tools,
        row?.workflow_state ?? "available",
        row?.template ?? false,
      ]),
    );
    return structuredClone({
      shell,
      host: HOSTS[shell.school] ?? "",
      courseId: Number(refParts(course)[2]),
      version,
      items: body.items,
      modules: body.modules,
      tools: body.tools,
      policy: POLICIES[shell.school] ?? NO_POLICY,
    });
  };
  migrations = (course: LmsRef<"course">): readonly Migration[] => {
    const courseId = Number(refParts(course)[2]);
    return this.#state.term.migrations
      .filter((record) => record.course_id === courseId)
      .map(toMigration);
  };
  samplePackages = (): readonly SamplePackage[] =>
    PACKAGES.map(({ name, kb, note, hint, body }) => ({
      name,
      kb,
      note,
      hint: hint && {
        ...hint,
        dated: (body?.items ?? []).flatMap(({ title, dueAt }) =>
          dueAt === null ? [] : [{ title, due: dateOfTime(dueAt) }],
        ),
      },
    }));
  assignments = (course: LmsRef<"course">): readonly Assignment[] =>
    structuredClone(this.#state.assignments.filter((a) => a.course === course));
  students = (course: LmsRef<"course">): readonly Student[] =>
    structuredClone(this.#state.students.filter((s) => s.course === course));
  /** Like Canvas, work with nothing turned in reads as missing once its due date passes. */
  submissions = (course: LmsRef<"course">): readonly Submission[] => {
    const now = this.#options.now();
    const pastDue = new Set(
      this.#state.assignments
        .filter((a) => a.course === course && a.dueAt !== null && Date.parse(a.dueAt) < now)
        .map((a) => a.ref),
    );
    return structuredClone(this.#state.submissions.filter((s) => s.course === course)).map((s) =>
      s.workflow === "unsubmitted" && pastDue.has(s.assignment) ? { ...s, workflow: "missing" } : s,
    );
  };
  conversations = (school: SchoolId): readonly Conversation[] =>
    structuredClone(this.#state.conversations.filter((c) => c.school === school));
  announcements = (course: LmsRef<"course">): readonly Announcement[] =>
    structuredClone(this.#state.announcements.filter((a) => a.course === course));

  /** Null means the target is gone. */
  observe(content: ChangeContent): RemoteState | null {
    switch (content.kind) {
      case "grade": {
        const submission = this.#submission(content.target);
        if (!submission) return null;
        const remote: RemoteState = {
          kind: "grade",
          targetVersion: `attempt:${submission.attempt}`,
          grade: submission.grade,
          rubric: submission.rubricScores,
          excused: submission.workflow === "excused",
          comments: submission.comments.map(({ id, mine, text }) => ({ id, mine, text })),
          attachments: this.#state.attachments[submission.ref] ?? [],
        };
        const snapshot = structuredClone(remote);
        this.#fireDemoConflict(submission);
        return snapshot;
      }
      case "reply": {
        const conversation = this.#state.conversations.find((c) => c.ref === content.target);
        if (!conversation) return null;
        return {
          kind: "reply",
          targetVersion: `messages:${conversation.messages.length}`,
          messages: conversation.messages.map(({ id, mine, text }) => ({ id, mine, text })),
        };
      }
      case "message": {
        const student = this.#studentOf(content.target);
        if (!student) return null;
        return {
          kind: "message",
          targetVersion: "student",
          messages: this.#conversationsWith(student)
            .filter((c) => c.subject === content.subject)
            .flatMap(({ messages: [opening] }) =>
              opening ? [{ id: opening.id, mine: opening.mine, text: opening.text }] : [],
            ),
        };
      }
      case "announcement": {
        const posts = this.#state.announcements.filter((a) => a.course === content.target);
        return {
          kind: "announcement",
          targetVersion: "course",
          posts: posts.map((a) => ({ id: a.ref, mine: true, text: postText(a.title, a.body) })),
        };
      }
      case "course-copy": {
        const courseId = Number(refParts(content.target)[2]);
        const shell = this.#shell(courseId);
        if (!shell) return null;
        const items =
          this.#state.term.content[refs.course(shell.school, courseId)]?.items.length ?? 0;
        const migrations = this.#state.term.migrations
          .filter((record) => record.course_id === courseId)
          .map((record) => ({
            id: refs.migration(record.school, courseId, record.id),
            mine: true,
            text: record.signature,
          }));
        return {
          kind: "course-copy",
          targetVersion: `students:${shell.students.length}|items:${items}`,
          students: shell.students.length,
          items,
          migrations,
        };
      }
      case "text-fix": {
        const found = this.#item(content.target);
        return found
          ? { kind: "text-fix", targetVersion: `v${found.item.version}`, body: found.item.body }
          : null;
      }
      case "item-set":
        return this.#observeSet(content);
    }
  }

  /** A deleted item still observes, as `deleted`, so a delete whose response was lost reads as done rather than gone. */
  #observeSet(content: SetContent): RemoteState | null {
    const parts = refParts(content.target);
    if (parts[1] === "course-state") {
      const row = this.#courseRow(Number(parts[2]));
      if (!row) return null;
      const value =
        content.intent.set === "course-template"
          ? row.template
            ? "template"
            : "not-template"
          : !("workflow_state" in row) || row.workflow_state === "available"
            ? "published"
            : "unpublished";
      return { kind: "item-set", targetVersion: "present", value };
    }
    const found = this.#item(content.target as LmsRef<"item">);
    if (!found) return { kind: "item-set", targetVersion: "deleted", value: "deleted" };
    const { item } = found;
    const value =
      content.intent.set === "due-at"
        ? item.dueAt
        : content.intent.set === "item-published"
          ? item.published
            ? "published"
            : "unpublished"
          : "present";
    return { kind: "item-set", targetVersion: "present", value };
  }

  /** Fires just after the read that becomes the draft's basis, so the regrade happens "while you were grading". */
  #fireDemoConflict(submission: Submission): void {
    const target = this.findSubmission(DEMO_CONFLICT.student, DEMO_CONFLICT.assignment);
    if (submission.ref !== target || !this.#armDemo("conflict")) return;
    this.changeGradeOutOfBand(target, DEMO_CONFLICT.newGrade, DEMO_CONFLICT.by);
  }

  // ---- Writes. Called from inside `call`, so an applied field is applied even if the response is then lost. ----

  /** Stops at the first failing field: a failed field did not land, and neither did anything queued behind it. */
  applyFields(content: ChangeContent, fields: readonly FieldKey[]): FieldOutcomes {
    const at = isoTime(this.#options.now());
    const outcomes: Partial<Record<FieldKey, FieldOutcomes[FieldKey]>> = {};
    let failure: LmsError | null = null;
    for (const field of fields) {
      failure ??= this.#fieldFault(content, field);
      if (failure) {
        outcomes[field] = { status: "failed", error: failure };
        continue;
      }
      this.#applyField(content, field, at);
      outcomes[field] = { status: "landed", at, via: "response" };
    }
    const landed = fields.filter((field) => outcomes[field]?.status === "landed");
    const where = this.#whereIs(content);
    if (where && landed.length > 0) this.#state.writeLog.push({ at, ...where, fields: landed });
    return outcomes as FieldOutcomes;
  }

  #whereIs(content: ChangeContent): Pick<WriteRecord, "school" | "target"> | null {
    switch (content.kind) {
      case "grade": {
        const submission = this.#submission(content.target);
        const assignment = this.#state.assignments.find((a) => a.ref === submission?.assignment);
        return submission
          ? {
              school: submission.school,
              target: `${submission.studentName}, ${assignment?.shortTitle ?? "assignment"}`,
            }
          : null;
      }
      case "reply": {
        const conversation = this.#state.conversations.find((c) => c.ref === content.target);
        return conversation
          ? { school: conversation.school, target: `Reply to ${conversation.from}` }
          : null;
      }
      case "message": {
        const student = this.#studentOf(content.target);
        return student ? { school: student.school, target: `Message to ${student.name}` } : null;
      }
      case "announcement": {
        const course = this.#state.courses.find((c) => c.ref === content.target);
        return course ? { school: course.school, target: `Announcement in ${course.code}` } : null;
      }
      case "course-copy": {
        const shell = this.#shell(Number(refParts(content.target)[2]));
        const from = content.source.kind === "course" ? content.source.label : content.source.name;
        return shell
          ? { school: shell.school, target: `Copy into ${shell.code} from ${from}` }
          : null;
      }
      case "text-fix":
      case "item-set": {
        const [school, kind, courseId] = refParts(content.target);
        const code = this.#courseRow(Number(courseId))?.code ?? courseId ?? "";
        const where =
          kind === "course-state" ? `Course settings of ${code}` : `${content.where} in ${code}`;
        return school === undefined
          ? null
          : { school: school as SchoolId, target: `${where}, ${whatChanged(content)}` };
      }
    }
  }

  #fieldFault(content: ChangeContent, field: FieldKey): LmsError | null {
    const scripted = this.#faults.takeField(field);
    if (scripted) return scripted;
    const source = content.kind === "course-copy" ? content.source : null;
    if (source?.kind === "cartridge" && !PACKAGES.some((pkg) => pkg.name === source.name))
      return { kind: "rejected", reason: `No package named ${source.name} was uploaded.` };
    if (content.kind !== "grade" || field !== DEMO_PARTIAL.field) return null;
    const target = this.findSubmission(DEMO_PARTIAL.student, DEMO_PARTIAL.assignment);
    return content.target === target && this.#armDemo("partial") ? DEMO_PARTIAL.error : null;
  }

  #applyField(content: ChangeContent, field: FieldKey, at: IsoTime): void {
    const id = `w${++this.#state.seq}`;
    switch (content.kind) {
      case "grade": {
        const submission = this.#submission(content.target);
        if (!submission) return;
        if (field === "grade") {
          submission.grade = finalGrade(content);
          submission.workflow = "graded";
        }
        if (field === "rubric") submission.rubricScores = scoredRubricPoints(content.rubric ?? []);
        if (field === "excuse") {
          submission.grade = null;
          submission.rubricScores = null;
          submission.workflow = "excused";
        }
        if (field === "comment" && content.comment !== null)
          submission.comments = [
            ...submission.comments,
            { id, mine: true, text: content.comment, at },
          ];
        if (field === "attachment" && content.attachment) {
          this.#state.attachments[submission.ref] = [
            ...(this.#state.attachments[submission.ref] ?? []),
            { id, mine: true, text: content.attachment.name },
          ];
        }
        return;
      }
      case "reply": {
        const conversation = this.#state.conversations.find((c) => c.ref === content.target);
        if (!conversation) return;
        conversation.messages = [
          ...conversation.messages,
          { id, mine: true, author: SEED.instructor, text: content.body, at },
        ];
        conversation.unread = false;
        return;
      }
      case "message": {
        const student = this.#studentOf(content.target);
        if (!student) return;
        const canvasId =
          Math.max(0, ...this.#state.conversations.map((c) => Number(refParts(c.ref)[2]))) + 1;
        this.#state.conversations.push({
          ref: refs.conversation(student.school, canvasId),
          school: student.school,
          course: student.course,
          subject: content.subject,
          from: student.name,
          unread: false,
          messages: [{ id, mine: true, author: SEED.instructor, text: content.body, at }],
        });
        return;
      }
      case "announcement": {
        const course = this.#state.courses.find((c) => c.ref === content.target);
        if (!course) return;
        this.#state.announcements.push({
          ref: refs.announcement(course.school, id),
          school: course.school,
          course: course.ref,
          title: content.title,
          body: content.body,
          postedAt: at,
        });
        return;
      }
      case "course-copy":
        this.#startMigration(content, at);
        return;
      case "text-fix": {
        const found = this.#item(content.target);
        if (!found) return;
        found.item.body = applySplice(found.item.body, content.splice);
        const { before, after } = content.splice;
        const stillThere = found.item.body.includes(before);
        found.item.links = found.item.links.flatMap((link) =>
          link.url !== before
            ? [link]
            : stillThere
              ? [link, { ...link, url: after }]
              : [{ ...link, url: after }],
        );
        found.item.version += 1;
        return;
      }
      case "item-set":
        this.#applySet(content);
        return;
    }
  }

  /** The record is Canvas-shaped. A damaged package or an armed failure gives it a point to fail at. */
  #startMigration(content: CourseCopyContent, at: IsoTime): void {
    const { term } = this.#state;
    const courseId = Number(refParts(content.target)[2]);
    const shell = this.#shell(courseId);
    if (!shell) return;
    const { source } = content;
    const pkg =
      source.kind === "cartridge"
        ? PACKAGES.find((entry) => entry.name === source.name)
        : undefined;
    const armed = this.#nextMigrationFailure;
    this.#nextMigrationFailure = null;
    const failAt = armed
      ? { completion: armed.stage === "pre_processing" ? 5 : 40, message: armed.message }
      : pkg?.damaged && this.#options.random() < DAMAGED_FAIL_RATE
        ? {
            completion: 40,
            message:
              "The package could not be read past wiki_content/. It may be incomplete or made by a different LMS.",
          }
        : pkg?.damaged
          ? { completion: 100, message: "The package held no importable content." }
          : null;
    term.migrations.push(
      newMigrationRecord({
        id: 200_000 + ++term.seq,
        school: shell.school,
        course_id: courseId,
        type: source.kind === "course" ? "course_copy_importer" : "common_cartridge_importer",
        settings:
          source.kind === "course"
            ? { source_course_id: Number(refParts(source.ref)[2]) }
            : { file: source.name },
        shift: content.shift,
        signature: copySignature(content),
        issues: pkg ? pkg.issues : COURSE_COPY_ISSUES,
        now: at,
        failAt:
          failAt && failAt.completion === 100
            ? { completion: 99, message: failAt.message }
            : failAt,
      }),
    );
  }

  #applySet(content: SetContent): void {
    const parts = refParts(content.target);
    const intent = content.intent;
    if (parts[1] === "course-state") {
      const row = this.#courseRow(Number(parts[2]));
      if (!row) return;
      if (intent.set === "course-published" && "workflow_state" in row)
        row.workflow_state = "available";
      if (intent.set === "course-template") row.template = true;
      return;
    }
    const found = this.#item(content.target as LmsRef<"item">);
    if (!found) return;
    const { body, item, school, courseId } = found;
    const assignment = this.#state.assignments.find(
      (row) => row.ref === refs.assignment(school, courseId, item.id),
    );
    switch (intent.set) {
      case "due-at":
        item.dueAt = intent.at;
        if (assignment) assignment.dueAt = intent.at;
        break;
      case "item-published":
        item.published = true;
        break;
      case "item-deleted":
        body.items = body.items.filter((entry) => entry.id !== item.id);
        this.#state.assignments = this.#state.assignments.filter((row) => row !== assignment);
        return;
      case "course-published":
      case "course-template":
        return;
    }
    item.version += 1;
  }

  #submission(ref: LmsRef<"submission">): Submission | undefined {
    return this.#state.submissions.find((s) => s.ref === ref);
  }

  #studentOf(ref: LmsRef<"submission">): Student | undefined {
    const submission = this.#submission(ref);
    return this.#state.students.find(
      (s) => s.ref === submission?.student && s.course === submission.course,
    );
  }

  /** A conversation names its student only by name, the way the seed writes it. */
  #conversationsWith(student: Student): readonly Conversation[] {
    return this.#state.conversations.filter(
      (c) => c.course === student.course && c.from === student.name,
    );
  }

  noise = (): NoiseConfig => this.#faults.noise;
  setNoise = (patch: Partial<NoiseConfig>): void => {
    this.#pull();
    this.#faults.noise = { ...this.#faults.noise, ...patch };
    this.#state.noise = this.#faults.noise;
    this.#push();
    this.#changed();
  };
  defaultNoise = (): NoiseConfig => this.#options.noise ?? DEFAULT_NOISE;
  resetNoise = (): void => this.setNoise(this.defaultNoise());
  expireToken = (school: SchoolId): void => {
    this.#pull();
    const book = this.#state.tokens[school] ?? { accepted: [], revoked: [] };
    this.#state.tokens[school] = { accepted: [], revoked: [...book.revoked, ...book.accepted] };
    this.#push();
    this.#changed();
  };
  changeGradeOutOfBand = (submission: LmsRef<"submission">, newGrade: number, by: string): void => {
    this.#pull();
    const target = this.#submission(submission);
    if (!target) return;
    target.grade = newGrade;
    target.workflow = "graded";
    target.comments = [
      ...target.comments,
      {
        id: `w${++this.#state.seq}`,
        mine: false,
        text: `${by} changed the grade to ${newGrade}.`,
        at: isoTime(this.#options.now()),
      },
    ];
    this.#push();
  };
  studentResubmits = (submission: LmsRef<"submission">): void => {
    this.#pull();
    const target = this.#submission(submission);
    if (!target) return;
    target.attempt += 1;
    target.workflow = "submitted";
    target.submittedAt = isoTime(this.#options.now());
    this.#push();
  };
  failNextWrite = (field: FieldKey, error: LmsError): void => {
    this.#faults.failField(field, error);
    this.#changed();
  };
  loseNextResponse = (applied = true): void => {
    this.#faults.lose({ kind: "lost", applied });
    this.#changed();
  };
  lateLanding = (delayMs: number): void => {
    this.#faults.lose({ kind: "late", delayMs });
    this.#changed();
  };
  throttleNext = (retryAfterMs: number, on: "any" | "write" = "any"): void => {
    this.#faults.throttle(retryAfterMs, on);
    this.#changed();
  };
  #hold = (kind: Route["kind"], held: boolean): void => {
    if (held) {
      if (this.#held[kind]) return;
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      this.#held[kind] = { gate, release };
    } else {
      this.#held[kind]?.release();
      delete this.#held[kind];
    }
  };
  holdReads = (held: boolean): void => this.#hold("read", held);
  holdWrites = (held: boolean): void => this.#hold("write", held);
  failNextMigration = (stage: "pre_processing" | "running", message: string): void => {
    this.#nextMigrationFailure = { stage, message };
    this.#changed();
  };
  hideTermDates = (hidden: boolean): void => {
    this.#termDatesHidden = hidden;
    this.#changed();
  };
  /** A course's term dates as the teacher reads them: none while `hideTermDates` holds. */
  #dates({ startAt, endAt }: { startAt: IsoDate; endAt: IsoDate }) {
    return this.#termDatesHidden ? { startAt: null, endAt: null } : { startAt, endAt };
  }
  /** A new unpublished course for next term, as when the registrar adds a section while the app is open. */
  createShell = (school: SchoolId, code: string, title: string): void => {
    this.#pull();
    const { shells, sources, content } = this.#state.term;
    const like = shells.find((shell) => shell.school === school);
    if (!like) return;
    const canvasId =
      Math.max(...shells.map((s) => s.canvasId), ...sources.map((s) => s.canvasId)) + 1;
    shells.push({
      ...structuredClone(like),
      canvasId,
      code,
      title,
      workflow_state: "unpublished",
      template: false,
      students: [],
    });
    content[refs.course(school, canvasId)] = { items: [], modules: [], tools: [] };
    this.#push();
    this.#changed();
  };
  enrollStudents = (course: LmsRef<"course">, count: number): void => {
    this.#pull();
    const shell = this.#shell(Number(refParts(course)[2]));
    if (!shell) return;
    for (let i = 0; i < count; i++)
      shell.students.push(
        INVENTED_STUDENTS[(shell.students.length + i) % INVENTED_STUDENTS.length] ?? "Student",
      );
    this.#push();
    this.#changed();
  };
  clearDueDates = (course: LmsRef<"course">): void => {
    this.#pull();
    for (const assignment of this.#state.assignments)
      if (assignment.course === course) assignment.dueAt = null;
    this.#push();
    this.#changed();
  };
  demoScript = () => ({
    enabled: this.#state.script.enabled,
    fired: DEMO_FAULTS.filter((fault) => this.#state.script.fired.includes(fault)),
  });
  setDemoScript = (enabled: boolean): void => {
    this.#pull();
    this.#state.script.enabled = enabled;
    this.#push();
    this.#changed();
  };
  /** Verify's way to name a submission. Not on FaultLab, because over IPC it can only answer later. */
  findSubmission = (student: string, assignmentShort: string): LmsRef<"submission"> | null => {
    const assignment = this.#state.assignments.find((a) => a.shortTitle === assignmentShort);
    return (
      this.#state.submissions.find(
        (s) => s.assignment === assignment?.ref && s.studentName === student,
      )?.ref ?? null
    );
  };
  stored = async (): Promise<string | null> =>
    this.#options.storage?.getItem(LMS_STORAGE_KEY) ?? null;
  armed = (): ArmedFaults => this.#faults.armed();
  writes = (): readonly WriteRecord[] => {
    this.#pull();
    return this.#state.writeLog;
  };
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  version = (): number => this.#version;
}

export const SCHOOLS_SEED = SEED.schools;
export const INSTRUCTOR = SEED.instructor;
