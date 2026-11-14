import type { AnswerLine, HandoffWork } from "~/shared/agent/agent";
import type { ChangeRecord, LmsError } from "~/shared/domain/change";
import type { CourseShell } from "~/shared/domain/content";
import type { CourseSetup } from "~/shared/domain/setup";
import type { FindingKey } from "~/shared/domain/scan";
import type { ChangeId, IsoTime, LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import type {
  Announcement,
  Assignment,
  Conversation,
  Course,
  School,
  Student,
  Submission,
} from "~/shared/domain/lms";

/** No credential field, by construction. The token lives only in the vault. */
export interface ConnectionRecord {
  school: SchoolId;
  status: "disconnected" | "connected" | "expired";
  connectedAt: IsoTime | null;
  accountName: string | null;
  scopes: readonly string[];
  lastSyncedAt: IsoTime | null;
  /** Set when the last sync failed, so a screen can say the data is stale as of lastSyncedAt. */
  syncError: LmsError["kind"] | null;
}

export interface SchoolCache {
  courses: readonly Course[];
  assignments: readonly Assignment[];
  students: readonly Student[];
  submissions: readonly Submission[];
  conversations: readonly Conversation[];
  announcements: readonly Announcement[];
}

/** One value an agent edit moved, so its reply can say what changed. */
export interface FieldEdit {
  label: string;
  from: string;
  to: string;
}

export type ThreadMessage = { change?: ChangeId; seeded?: true } & (
  | { type: "user"; text: string; at: IsoTime }
  | {
      type: "agent";
      text: string;
      at: IsoTime;
      edited?: readonly FieldEdit[];
      lines?: readonly AnswerLine[];
      replies?: readonly string[];
    }
  | { type: "work"; lines: readonly string[]; at: IsoTime }
  | { type: "refusal"; text: string; at: IsoTime }
  | { type: "declined"; text: string; at: IsoTime; lines?: readonly AnswerLine[] }
  | { type: "notice"; text: string; at: IsoTime }
  | {
      type: "handoff";
      to: ThreadId;
      course: LmsRef<"course">;
      /** Set when the handoff is one reply, so the card names that student, not the whole thread. */
      conversation?: LmsRef<"conversation">;
      /** Set when the handoff is every reply in a course: who it drafted for, so the card keeps naming them after a send. */
      people?: readonly string[];
      brief: string;
      at: IsoTime;
    }
  | { type: "handed-off"; from: ThreadId; request: string; left?: string; at: IsoTime }
);

export type ThreadKind = ThreadSubject["kind"];

/** Who a thread is about. A grading, announcement or setup thread always belongs to one course. */
export type ThreadSubject =
  | {
      kind: "grading";
      school: SchoolId;
      course: LmsRef<"course">;
      assignment: LmsRef<"assignment">;
    }
  | {
      kind: "announcement" | "setup";
      school: SchoolId;
      course: LmsRef<"course">;
      assignment?: never;
    }
  | {
      kind: "north-star" | "north-star-chat" | "queue" | "messages" | "general";
      school: SchoolId | null;
      course: LmsRef<"course"> | null;
      assignment?: never;
    };

export type Thread = ThreadSubject & {
  id: ThreadId;
  title: string;
  messages: readonly ThreadMessage[];
  focus: ChangeId | null;
  updatedAt: IsoTime;
  /** When the teacher last settled it. Read it through `isSettled`, because a later message resumes the thread. */
  settledAt?: IsoTime;
  /** What Claude's runs in this thread used and cost, summed. Absent until a run reports one. */
  spend?: { tokens: number; usd: number };
  /** For diagnosis, never shown: the last things the parser set aside from Claude's runs here, and why. */
  dropped?: readonly { text: string; at: IsoTime }[];
};

export type OnboardingStep = "welcome" | "setup" | "done";

/** Where AI drafts come from. A key lives in the vault, and the on-device model needs a Mac. */
export type AiSource = "none" | "key" | "on-device";

export type QueueFilter =
  | "all"
  | "needs-draft"
  | "ready-to-approve"
  | "approved"
  | "attention"
  | "missing"
  | `school:${string}`
  | `course:${string}`
  | `assignment:${string}`;

/** A row's key: the LMS item a grading, inbox or announcement row is about, or a setup finding. */
export type RowKey = LmsRef<string> | FindingKey;

/** What a thread looks like when you come back to it, reload included. */
export interface ThreadUi {
  panel: "source" | "writeback" | "batch" | null;
  queueOpen: boolean;
  queueFilter: QueueFilter;
  /** The row the thread is on, which exists before its draft does. */
  current: RowKey | null;
  /** Row keys. This one list decides what the bar counts and what a batch reviews. */
  selected: readonly RowKey[];
  /** Null until the user scrolls, which means the chat sits at its latest message. */
  scrollTop: number | null;
  /** What's typed in the composer and not yet sent. Absent in saves from before it was kept. */
  composer?: string;
}

export interface UiPrefs {
  sidebarOpen: boolean;
  collapsed: Readonly<Record<string, true>>;
  courseOpen?: Readonly<Record<string, boolean>>;
  expandedThreads: Readonly<Record<string, true>>;
  threadUi: Readonly<Record<ThreadId, ThreadUi>>;
  /** Conversations read here, by the last message seen. The provider has no read call, so its next sync would bring them back unread. */
  readThrough?: Readonly<Record<string, string>>;
  /** New courses dismissed on What's due, by course ref. The sidebar drops them too; ⌘K still offers them. */
  offersDismissed?: Readonly<Record<string, true>>;
}

export interface PendingHandoff {
  thread: ThreadId;
  course: LmsRef<"course">;
  work: HandoffWork;
}

/** Everything persisted under lms-app.v1. Parsed on load. */
/** A draft that came back with no grade, for the submission as it was turned in then, and the next step Claude offered instead. */
export interface Undrafted {
  submittedAt: IsoTime | null;
  offer: string | null;
}

export interface WorkspaceData {
  /** Empty until the person adds a school. Only `addSchool` grows it. */
  schools: readonly School[];
  connections: Readonly<Record<SchoolId, ConnectionRecord>>;
  onboarding: OnboardingStep;
  aiSource: AiSource;
  cache: Readonly<Record<SchoolId, SchoolCache>>;
  changes: Readonly<Record<ChangeId, ChangeRecord>>;
  threads: Readonly<Record<ThreadId, Thread>>;
  /** By course ref. A workspace saved before setup existed has none and still loads. */
  setups: Readonly<Record<string, CourseSetup>>;
  /** Read last in each sync. */
  newCourses: Readonly<Record<SchoolId, readonly CourseShell[]>>;
  prefs: UiPrefs;
  /** Work North Star handed to a thread that hasn't finished, so a reload can start it again. A workspace saved before this has none and still loads. */
  handoffs: Readonly<Record<string, PendingHandoff>>;
  /** By submission ref: Claude read the work and drafted no grade. It holds until the student submits again. A workspace saved before this has none and still loads. */
  undrafted: Readonly<Record<string, Undrafted>>;
  /** Real epoch ms of the last reset. The demo clock, which runs while every school is a demo school, is the seed time plus real time since this. */
  resetAt: number;
}
