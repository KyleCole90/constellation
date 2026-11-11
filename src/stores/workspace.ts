import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import {
  DRAFT_ANNOUNCEMENT_REQUEST,
  draftAnnouncementAbout,
  DRAFT_GRADE_REQUEST,
  DRAFT_MESSAGE_REQUEST,
  DRAFT_REPLY_REQUEST,
  describeViolation,
  runAgent,
  type Agent,
  type AgentEffect,
  type AgentInput,
  type AgentScope,
  type AgentSink,
  type NextWork,
  type HandoffWork,
} from "~/agent/agent";
import { createRuleAgent } from "~/agent/rules";
import { plannedHandoffs, planWork } from "~/components/screens/due.logic";
import {
  blankAnnouncement,
  blankGrade,
  blankMessage,
  blankReply,
  isBlank,
  type Proposal,
} from "~/domain/blank";
import {
  FIELD_LABEL,
  errorWords,
  fieldText,
  fieldsOf,
  fitContent,
  newChangeRecord,
  sameSlot,
  slotOf,
  transition,
  type ActivityActor,
  type ChangeContent,
  type ChangeRecord,
  type ConflictChoice,
  type FieldKey,
  type LmsError,
  type PassageAnchor,
  type Rejection,
  type UserEvent,
} from "~/domain/change";
import { previewOf, type PreviewField } from "~/domain/preview";
import {
  isoTime,
  type ChangeId,
  type IsoTime,
  type LmsRef,
  type Result,
  type SchoolHost,
  type SchoolId,
  type ThreadId,
} from "~/domain/ids";
import { awaitsReply, bySchoolName, passagesOf, type Course, type School } from "~/domain/lms";
import type { SetupLive } from "~/domain/setup";
import { workName } from "~/domain/workName";
import { FakeCanvasServer, type StorageLike } from "~/providers/fake-canvas/server";
import type { FaultLab, NoiseConfig } from "~/providers/fake-canvas/faults";
import { FAKE_SCHOOLS, createFakeCanvasDescriptor } from "~/providers/fake-canvas/provider";
import { SEED } from "~/providers/fake-canvas/seed";
import {
  revealSecret,
  type AccountInfo,
  type Capabilities,
  type Credential,
  type LmsProvider,
  type ProviderDescriptor,
  type Secret,
  type Vault,
} from "~/providers/provider";
import { createBrowserVault } from "~/providers/vault";
import {
  DEFAULT_RETRY_POLICY,
  createWriteback,
  type ChangeLedger,
  type RetryPolicy,
  type RunResult,
  type Writeback,
} from "~/writeback/writeback";

import { seedThreads } from "./seedThreads";
import {
  DEFAULT_THREAD_UI,
  canSettle,
  NORTH_STAR_THREAD,
  selectAssignment,
  selectConversation,
  selectCourse,
  selectDueExtras,
  selectThreadUi,
  selectWhatsDue,
  selectWorkStages,
} from "./selectors";
import { createSetupActions, type SetupActions, type SetupOptions } from "./setup";
import type {
  AiSource,
  ConnectionRecord,
  FieldEdit,
  OnboardingStep,
  PendingHandoff,
  SchoolCache,
  Thread,
  ThreadKind,
  ThreadSubject,
  ThreadMessage,
  ThreadUi,
  UiPrefs,
  WorkspaceData,
} from "./types";

export const WORKSPACE_STORAGE_KEY = "lms-app.v1";
const STORE_VERSION = 3;
const UNREADABLE_BACKUP_KEY = `${WORKSPACE_STORAGE_KEY}.unreadable`;

export type ConnectStage = "saving" | "checking" | "reading";

interface WorkspaceActions extends SetupActions {
  /** Now on the demo clock. Epoch ms. */
  now(): number;
  aiOn(): boolean;
  /** Run once at app start: re-checks the vault, recovers any send a reload interrupted, and restarts any handed-off work it cut short. */
  boot(): Promise<void>;
  /** `onStage` reports each real step as it starts. A failed replacement keeps the token that was working. */
  connect(
    school: SchoolId,
    secret: Secret,
    onStage?: (stage: ConnectStage) => void,
  ): Promise<Result<AccountInfo, string>>;
  /**
   * Finds the school at this address and connects it through the same path as `connect`. A failure leaves no trace:
   * no school, no connection record, nothing in the vault. A host already added reconnects that school.
   */
  addSchool(
    host: SchoolHost,
    secret: Secret,
    onStage?: (stage: ConnectStage) => void,
  ): Promise<Result<School, string>>;
  /** Forgets the token and drops the school with its connection and cache. Refuses, with false, once the school has a saved change. */
  removeSchool(school: SchoolId): Promise<boolean>;
  disconnect(school: SchoolId): Promise<void>;
  addAiKey(secret: Secret): Promise<void>;
  chooseOnDeviceModel(): Promise<void>;
  /** Forgets any saved key. */
  turnOffAi(): Promise<void>;
  scopeWordsFor(school: SchoolId): readonly string[];
  syncSchool(school: SchoolId): Promise<boolean>;
  /** Drafts what isn't drafted yet and focuses it. With `focus: false` it drafts in the background and leaves the thread where it is. */
  openSubmission(
    thread: ThreadId,
    submission: LmsRef<"submission">,
    options?: OpenOptions,
  ): Promise<ChangeId | null>;
  openConversation(
    thread: ThreadId,
    conversation: LmsRef<"conversation">,
    options?: OpenOptions,
  ): Promise<ChangeId | null>;
  /** Drafts a new conversation with the submission's student, about its assignment. Its grade is separate work. */
  openMessage(thread: ThreadId, submission: LmsRef<"submission">): Promise<ChangeId | null>;
  openAnnouncement(
    thread: ThreadId,
    course: LmsRef<"course">,
    topic?: string,
  ): Promise<ChangeId | null>;
  focusChange(thread: ThreadId, change: ChangeId | null): void;
  createThread(init: ThreadSubject & { title: string }): ThreadId;
  /** The one thread that holds this work in this course. The seed gives only some of them, so the first ask starts the rest. */
  threadForWork(course: Course, work: HandoffWork): ThreadId;
  /** Starts a North Star chat with this request. `done` settles when its run does. Null with AI off, so no empty chat exists. */
  startChat(text: string): { thread: ThreadId; done: Promise<void> } | null;
  sendToAgent(thread: ThreadId, text: string): Promise<void>;
  /** Course threads and chats only (`canSettle`); others are ignored. A settled thread leaves its sidebar list until it is resumed or gets a new message. */
  settleThreads(ids: readonly ThreadId[]): void;
  resumeThreads(ids: readonly ThreadId[]): void;
  /** Local only. Survives a sync until the student writes again. */
  setConversationRead(conversation: LmsRef<"conversation">, read: boolean): void;
  /** The only way a screen moves a change. Approving needs a witness only ApproveButton can mint. */
  dispatchUser(id: ChangeId, event: UserEvent): Result<ChangeRecord, Rejection>;
  /** Undoes a discard by putting the change back as `before` held it. False once it has moved on, or another change holds its target. */
  restoreChange(before: ChangeRecord): boolean;
  /** First send, retry, and resume are all this. */
  sendChanges(
    ids: readonly ChangeId[],
    onItem?: (result: RunResult) => void,
  ): Promise<readonly RunResult[]>;
  /** Reads the LMS now, so the rebased draft starts from what is there. Needs a fresh approval after. */
  resolveConflict(
    id: ChangeId,
    choices: Readonly<Partial<Record<FieldKey, ConflictChoice>>>,
  ): Promise<Result<ChangeRecord, Rejection | LmsError["kind"]>>;
  /** Read-only look at the LMS for a held change. Says whether anything is still unconfirmed. */
  checkAgain(id: ChangeId): Promise<"confirmed" | "still-unconfirmed" | "unreachable">;
  previewFor(id: ChangeId): readonly PreviewField[] | null;
  capabilitiesFor(school: SchoolId): Capabilities | null;
  enrollmentFor(school: SchoolId): ProviderDescriptor["enrollment"] | null;
  /** What the add-a-school form renders, before any school exists. */
  newSchoolEnrollment(): ProviderDescriptor["enrollment"] | null;
  /** Addresses the demo fill offers. Empty against a real LMS. */
  demoHosts(): readonly SchoolHost[];
  laneStatus(school: SchoolId): ReturnType<Writeback["laneStatus"]>;
  setOnboarding(step: OnboardingStep): void;
  setPrefs(patch: Partial<UiPrefs>): void;
  setThreadUi(thread: ThreadId, patch: Partial<ThreadUi>): void;
  vendorLabelFor(school: SchoolId): string | null;
  agentLabel(): string;
  dismissNotice(): void;
  resetDemoData(): Promise<void>;
}

export type WorkspaceState = WorkspaceData &
  WorkspaceActions & {
    blanks: Readonly<Record<ChangeId, ChangeRecord>>;
    /** Threads with an agent run in progress. Not persisted. */
    working: Readonly<Record<ThreadId, boolean>>;
    /** Schools with a sync in progress. Not persisted. */
    syncing: Readonly<Record<SchoolId, boolean>>;
    /** By course ref. Not persisted: the next read of the job restores it. */
    setupLive: Readonly<Record<string, SetupLive>>;
    /** What a school offers to copy from. Not persisted. */
    setupOptions: Readonly<Record<SchoolId, SetupOptions>>;
    /** Not persisted: it reports something that just happened, so a reload has nothing to say. */
    notice: string | null;
  };

export interface Backend {
  /** The school at this address, or null when there is none. A real backend builds it from the host. */
  schoolAt(host: SchoolHost): School | null;
  demoHosts: readonly SchoolHost[];
  /** The vendor a newly added school uses. The app is single-vendor today. */
  newSchoolProvider: School["provider"];
  descriptors: Readonly<Partial<Record<School["provider"], ProviderDescriptor>>>;
  /** Demo clock start, epoch ms. */
  epoch: number;
  seedThreads(): Readonly<Record<ThreadId, Thread>>;
  reset(): void;
}

export interface WorkspaceDeps {
  storage: StorageLike;
  vault: Vault;
  /** Gets the demo clock, because a fake LMS has to agree with the app about what time it is. */
  backend(now: () => number): Backend;
  realNow(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  agent?: Agent;
  aiAlways?: boolean;
  policy?: RetryPolicy;
  locks?: Pick<LockManager, "request"> | null;
  /** Calls back when another tab wrote the workspace key. */
  subscribeStorage?(onChange: () => void): void;
}

export type WorkspaceStore = StoreApi<WorkspaceState> & { syncFromStorage(): void };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Version 2 seeded two fixed schools and stepped through them one by one. Every school, connection, change, and thread
 * carries over. A step inside the old flow resumes on the one setup page, and a finished run stays finished.
 */
const migrateV2 = (state: Record<string, unknown>): Record<string, unknown> => {
  const { aiKeyStatus, ...rest } = state;
  return {
    ...rest,
    aiSource: aiKeyStatus === "saved" ? "key" : "none",
    onboarding:
      state["onboarding"] === "done"
        ? "done"
        : state["onboarding"] === "welcome"
          ? "welcome"
          : "setup",
  };
};

const AI_SOURCES: readonly unknown[] = ["none", "key", "on-device"] satisfies readonly AiSource[];
const STEPS: readonly unknown[] = ["welcome", "setup", "done"] satisfies readonly OnboardingStep[];
// Records, so the compiler fails here when a variant is added and a save holding it still loads.
const CHANGE_KINDS: Readonly<Record<ChangeContent["kind"], true>> = {
  grade: true,
  reply: true,
  message: true,
  announcement: true,
  "course-copy": true,
  "text-fix": true,
  "item-set": true,
};
const STATE_TAGS: Readonly<Record<ChangeRecord["state"]["tag"], true>> = {
  draft: true,
  approved: true,
  sending: true,
  held: true,
  conflicted: true,
  sent: true,
  discarded: true,
};
const THREAD_KINDS: Readonly<Record<ThreadKind, true>> = {
  "north-star": true,
  "north-star-chat": true,
  queue: true,
  grading: true,
  messages: true,
  announcement: true,
  setup: true,
  general: true,
};
const CACHE_LISTS = [
  "courses",
  "assignments",
  "students",
  "submissions",
  "conversations",
  "announcements",
] as const satisfies readonly (keyof SchoolCache)[];

const isKnown = (known: Readonly<Record<string, true>>, value: unknown): boolean =>
  typeof value === "string" && Object.hasOwn(known, value);
const everyValue = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  isRecord(value) && Object.values(value).every(check);
/** A key a workspace saved before it existed can lack, but can't hold the wrong shape. */
const absentOrEveryValue = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  value === undefined || everyValue(value, check);

const isSchool = (school: unknown): boolean =>
  isRecord(school) &&
  typeof school["id"] === "string" &&
  typeof school["host"] === "string" &&
  typeof school["provider"] === "string";
const isCache = (cache: unknown): boolean =>
  isRecord(cache) && CACHE_LISTS.every((list) => Array.isArray(cache[list]));
const isChange = (change: unknown): boolean =>
  isRecord(change) &&
  isRecord(change["state"]) &&
  isKnown(STATE_TAGS, change["state"]["tag"]) &&
  isRecord(change["content"]) &&
  isKnown(CHANGE_KINDS, change["content"]["kind"]) &&
  isRecord(change["basis"]) &&
  Array.isArray(change["landed"]);
/** A grading, announcement or setup thread names its school and course, and a grading thread its assignment. */
const isThread = (thread: unknown): boolean => {
  if (!isRecord(thread) || !Array.isArray(thread["messages"])) return false;
  const named = (key: string) => typeof thread[key] === "string";
  switch (thread["kind"]) {
    case "grading":
      return named("school") && named("course") && named("assignment");
    case "announcement":
    case "setup":
      return named("school") && named("course");
    default:
      return isKnown(THREAD_KINDS, thread["kind"]);
  }
};

/**
 * Checks the shape the app dereferences on load and render: every collection, and each record's discriminant.
 * A save that fails resets the workspace and keeps a copy, which beats a page that crashes on every load.
 */
const parsePersisted = (raw: string): StorageValue<WorkspaceData> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      (parsed["version"] !== STORE_VERSION && parsed["version"] !== 2) ||
      !isRecord(parsed["state"])
    )
      return null;
    const state = parsed["version"] === 2 ? migrateV2(parsed["state"]) : parsed["state"];
    const prefs = state["prefs"];
    const valid =
      AI_SOURCES.includes(state["aiSource"]) &&
      STEPS.includes(state["onboarding"]) &&
      typeof state["resetAt"] === "number" &&
      Array.isArray(state["schools"]) &&
      state["schools"].every(isSchool) &&
      everyValue(state["connections"], isRecord) &&
      everyValue(state["cache"], isCache) &&
      everyValue(state["changes"], isChange) &&
      everyValue(state["threads"], isThread) &&
      isRecord(prefs) &&
      isRecord(prefs["threadUi"]) &&
      absentOrEveryValue(state["setups"], isRecord) &&
      absentOrEveryValue(state["newCourses"], Array.isArray) &&
      absentOrEveryValue(state["handoffs"], isRecord);
    // Checked above as far as the app reads it on load. Deeper fields are the app's own writes.
    return valid
      ? ({ state, version: STORE_VERSION } as unknown as StorageValue<WorkspaceData>)
      : null;
  } catch {
    return null;
  }
};

export const hasChanges = (data: Pick<WorkspaceData, "changes">, school: SchoolId): boolean =>
  Object.values(data.changes).some((change) => change.school === school);

/** The statuses that keep a token in the vault. */
const isVouched = (status: ConnectionRecord["status"] | undefined): boolean =>
  status === "connected" || status === "expired";

const emptyConnection = (school: SchoolId): ConnectionRecord => ({
  school,
  status: "disconnected",
  connectedAt: null,
  accountName: null,
  scopes: [],
  lastSyncedAt: null,
  syncError: null,
});
const initialData = (backend: Backend, resetAt: number): WorkspaceData => ({
  schools: [],
  connections: {},
  onboarding: "welcome",
  aiSource: "none",
  cache: {},
  changes: {},
  threads: backend.seedThreads(),
  setups: {},
  newCourses: {},
  prefs: { sidebarOpen: true, collapsed: {}, expandedThreads: {}, threadUi: {} },
  handoffs: {},
  resetAt,
});

export const expiredNoticeText = (school: string): string =>
  `Your ${school} connection expired. Reconnect to keep sending.`;

export const REJECTION_TEXT: Readonly<Record<Rejection, string>> = {
  incomplete: "This still has blanks to fill in, so nothing was approved.",
  "not-editable": "This change can't be edited right now.",
  "field-already-landed": "That part has already landed in the LMS, so it can't be changed.",
  "stale-approval": "The draft changed after you clicked, so nothing was approved.",
  "needs-confirmation":
    "This copy lands on a course that already has people or content in it, so it needs the typed confirmation first.",
  "needs-review": "The AI worked on this, so approve it from the preview.",
  "not-approved": "This change hasn't been approved.",
  "not-sendable": "This change can't be sent right now.",
  "not-sending": "This change isn't sending.",
  "not-conflicted": "This change has no conflict to resolve.",
};

const editsBetween = (before: ChangeContent, after: ChangeContent): readonly FieldEdit[] => {
  if (before.kind === "grade" && after.kind === "grade") {
    const scores = (after.rubric ?? []).flatMap((score): readonly FieldEdit[] => {
      const was = before.rubric?.find((r) => r.criterion === score.criterion)?.points;
      return was === undefined || was === score.points
        ? []
        : [
            {
              label: score.name,
              from: String(was ?? "unset"),
              to: String(score.points ?? "unset"),
            },
          ];
    });
    const fieldEdits = (["grade", "comment", "attachment"] as const).flatMap(
      (field): readonly FieldEdit[] => {
        const from = fieldsOf(before).includes(field) ? fieldText(before, field) : "";
        const to = fieldsOf(after).includes(field) ? fieldText(after, field) : "";
        if (field === "comment") return textEdit(FIELD_LABEL[field], from, to);
        return from === to ? [] : [{ label: FIELD_LABEL[field], from, to }];
      },
    );
    return [...scores, ...fieldEdits];
  }
  if (before.kind === "announcement" && after.kind === "announcement")
    return [
      ...textEdit("Title", before.title, after.title),
      ...textEdit(FIELD_LABEL.post, before.body, after.body),
    ];
  const [field] = fieldsOf(after);
  if (!field) return [];
  const from = fieldText(before, field);
  const to = fieldText(after, field);
  if (from === to) return [];
  return after.kind === "reply" || after.kind === "message" || after.kind === "text-fix"
    ? textEdit(FIELD_LABEL[field], from, to)
    : [{ label: FIELD_LABEL[field], from, to }];
};

const sentencesIn = (text: string): readonly string[] =>
  text.split(/(?<=[.?!])\s+|\n+/).filter((sentence) => sentence.trim());

/** Trims the sentences both versions share at either end, so the reply names only what moved. */
const textEdit = (label: string, before: string, after: string): readonly FieldEdit[] => {
  if (before === after) return [];
  const was = sentencesIn(before);
  const now = sentencesIn(after);
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head++;
  let tail = 0;
  while (
    tail < was.length - head &&
    tail < now.length - head &&
    was.at(-1 - tail) === now.at(-1 - tail)
  )
    tail++;
  const from = was.slice(head, was.length - tail).join(" ");
  const to = now.slice(head, now.length - tail).join(" ");
  return from || to ? [{ label, from, to }] : [];
};

const nextWorkOf = (state: WorkspaceData, now: number): readonly NextWork[] =>
  plannedHandoffs(
    planWork({
      groups: selectWhatsDue(state, now),
      extras: selectDueExtras(state),
      stages: selectWorkStages(state),
      expired: [],
      now,
    }),
  );

const scopeOf = (state: WorkspaceData, thread: Thread): Omit<AgentScope, "changes" | "focus"> => {
  const caches = Object.entries(state.cache).flatMap(([school, cache]) =>
    thread.school === null || thread.school === school ? [cache] : [],
  );
  const inCourse = <T extends { course: LmsRef<"course"> }>(items: readonly T[]) =>
    thread.course ? items.filter((item) => item.course === thread.course) : items;
  return {
    submissions: inCourse(caches.flatMap((cache) => cache.submissions)),
    assignments: inCourse(caches.flatMap((cache) => cache.assignments)),
    conversations: inCourse(caches.flatMap((cache) => cache.conversations)),
    courses: caches
      .flatMap((cache) => cache.courses)
      .filter((course) => !thread.course || course.ref === thread.course),
  };
};

interface OpenOptions {
  focus?: boolean;
}

/** One agent run. A run that opens something holds what it says until there is a change to file it under, so one student's lines never show under another's card. */
interface AgentRun {
  change: ChangeId | null;
  held: ThreadMessage[] | null;
  /** Work this run handed to other threads. The run isn't over until they are. */
  started: Promise<unknown>[];
}
const newRun = (change: ChangeId | null, held: ThreadMessage[] | null): AgentRun => ({
  change,
  held,
  started: [],
});

const sameWords = (a: ChangeContent, b: ChangeContent): boolean => {
  const trimmed = (_key: string, value: unknown) =>
    typeof value === "string" ? value.trim() : value;
  return JSON.stringify(a, trimmed) === JSON.stringify(b, trimmed);
};

const withoutFocus = (
  state: Pick<WorkspaceData, "threads" | "prefs">,
  gone: (focus: ChangeId) => boolean,
): Pick<WorkspaceData, "threads" | "prefs"> => {
  const left = Object.values(state.threads).filter(
    (thread) => thread.focus !== null && gone(thread.focus),
  );
  if (left.length === 0) return { threads: state.threads, prefs: state.prefs };
  const threads = {
    ...state.threads,
    ...Object.fromEntries(left.map((thread) => [thread.id, { ...thread, focus: null }])),
  };
  const threadUi = {
    ...state.prefs.threadUi,
    ...Object.fromEntries(
      left.map((thread) => [
        thread.id,
        {
          ...(state.prefs.threadUi[thread.id] ?? DEFAULT_THREAD_UI),
          current: null,
          queueOpen: true,
          panel: null,
        },
      ]),
    ),
  };
  return { threads, prefs: { ...state.prefs, threadUi } };
};

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const moveHomeToChat = (
  threads: WorkspaceData["threads"],
  newId: () => ThreadId,
): WorkspaceData["threads"] => {
  const home = threads[NORTH_STAR_THREAD];
  if (!home || home.kind !== "north-star" || home.messages.length === 0) return threads;
  const emptied = { ...home, messages: [], focus: null };
  const first = home.messages.find((message) => message.type === "user");
  if (!first) return { ...threads, [home.id]: emptied };
  const id = newId();
  const repointed = Object.values(threads).map((thread) => ({
    ...thread,
    messages: thread.messages.map((message) =>
      message.type === "handed-off" && message.from === home.id
        ? { ...message, from: id }
        : message,
    ),
  }));
  const chat: Thread = { ...home, id, kind: "north-star-chat", title: oneLine(first.text) };
  return Object.fromEntries([...repointed, emptied, chat].map((thread) => [thread.id, thread]));
};

const keepLocalFocus = (persisted: unknown, current: WorkspaceState): WorkspaceState => {
  const next = { ...current, ...(persisted as Partial<WorkspaceState>) };
  const threads = Object.fromEntries(
    Object.values(next.threads).map((thread) => {
      const mine = current.threads[thread.id]?.focus;
      const keep = mine && (current.blanks[mine] || (thread.focus && !next.changes[thread.focus]));
      return [thread.id, keep ? { ...thread, focus: mine } : thread];
    }),
  );
  return { ...next, threads };
};

export const createWorkspaceStore = (deps: WorkspaceDeps): WorkspaceStore => {
  const agent = deps.agent ?? createRuleAgent();
  const clock = { now: (): number => deps.realNow() };
  const backend = deps.backend(() => clock.now());
  const providers = new Map<SchoolId, LmsProvider>();
  const inFlight = new Map<string, Promise<unknown>>();
  let lastRaw: string | null = null;
  let writingChanges = false;
  /** The slot each thread was last asked to open, so a slow draft doesn't pull focus from a later click. */
  const wanted = new Map<ThreadId, string>();
  /** Slots drafting in the background. One focuses only once someone asks for it by name. */
  const background = new Set<string>();
  let loadNotice: string | null = null;

  const providerOf = (school: School): LmsProvider | null => {
    const existing = providers.get(school.id);
    if (existing) return existing;
    const created =
      backend.descriptors[school.provider]?.create({
        school,
        lease: deps.vault.leaseFor(school.id),
      }) ?? null;
    if (created) providers.set(school.id, created);
    return created;
  };

  const storage: PersistStorage<WorkspaceData> = {
    getItem: (name) => {
      const raw = deps.storage.getItem(name);
      lastRaw = raw;
      if (raw === null) return null;
      const parsed = parsePersisted(raw);
      if (!parsed) {
        // The reset that follows overwrites this key, and this may be the only record of what already landed.
        deps.storage.setItem(UNREADABLE_BACKUP_KEY, raw);
        loadNotice =
          "Saved data could not be read, so the workspace was reset. A copy of it was kept in this browser.";
      }
      return parsed;
    },
    setItem: (name, value) => {
      // Only the ledger writes changes. Any other save keeps the ones on disk, so a scroll in a stale tab can't roll back another tab's send.
      const onDisk = writingChanges ? null : parsePersisted(deps.storage.getItem(name) ?? "");
      const raw = JSON.stringify(
        onDisk ? { ...value, state: { ...value.state, changes: onDisk.state.changes } } : value,
      );
      deps.storage.setItem(name, raw);
      // Memory that disagrees with what was just saved has to reload before the next commit reads it.
      lastRaw =
        onDisk && JSON.stringify(onDisk.state.changes) !== JSON.stringify(value.state.changes)
          ? null
          : raw;
    },
    removeItem: (name) => deps.storage.removeItem(name),
  };

  // Set just below, once the store exists. Actions only run after that.
  let writeback: Writeback;

  const store = createStore<WorkspaceState>()(
    persist(
      (set, get) => {
        const nowIso = () => isoTime(clock.now());

        const schoolById = (id: SchoolId) => get().schools.find((school) => school.id === id);
        const provider = (id: SchoolId) => {
          const school = schoolById(id);
          return school ? providerOf(school) : null;
        };
        const patchConnection = (id: SchoolId, patch: Partial<ConnectionRecord>) => {
          const current = get().connections[id] ?? emptyConnection(id);
          set({ connections: { ...get().connections, [id]: { ...current, ...patch } } });
        };
        const post = (thread: ThreadId, message: ThreadMessage) => {
          const current = get().threads[thread];
          if (current)
            set({
              threads: {
                ...get().threads,
                [thread]: {
                  ...current,
                  messages: [...current.messages, message],
                  updatedAt: message.at,
                },
              },
            });
        };
        const noticeFocused = (change: ChangeId, text: string) => {
          for (const thread of Object.values(get().threads))
            if (thread.focus === change)
              post(thread.id, { type: "notice", text, at: nowIso(), change });
        };
        const expiredNotice = (school: SchoolId) =>
          expiredNoticeText(schoolById(school)?.name ?? school);
        const markExpired = (school: SchoolId) => {
          patchConnection(school, { status: "expired" });
          set({ notice: expiredNotice(school) });
        };

        /** `also` lands in the same save, so a setup and the changes it links can't be persisted apart. */
        const saveChanges = (
          changes: WorkspaceData["changes"],
          also: Partial<WorkspaceState> = {},
        ) => {
          writingChanges = true;
          try {
            set({ changes, ...also });
          } finally {
            writingChanges = false;
          }
        };

        const ledger: ChangeLedger = {
          get: (id) => {
            syncFromStorage();
            return get().changes[id];
          },
          all: () => {
            syncFromStorage();
            return Object.values(get().changes);
          },
          commit: (id, event) => {
            syncFromStorage();
            const record = get().changes[id];
            if (!record) return { ok: false, error: "not-sendable" };
            const next = transition(record, event);
            // persist writes synchronously inside set, so this returns only once the state is durable.
            if (next.ok) saveChanges({ ...get().changes, [id]: next.value });
            return next;
          },
        };

        const makeWriteback = () =>
          createWriteback({
            ledger,
            providerFor: (school) =>
              get().connections[school]?.status === "disconnected" ? null : provider(school),
            markExpired,
            now: () => clock.now(),
            sleep: deps.sleep,
            random: deps.random,
            policy: deps.policy ?? DEFAULT_RETRY_POLICY,
            ...(deps.locks === undefined ? {} : { locks: deps.locks }),
          });
        writeback = makeWriteback();

        const newChangeId = () =>
          `ch-${clock.now().toString(36)}-${deps.random().toString(36).slice(2, 10)}` as ChangeId;
        const newThreadId = () =>
          `t-${clock.now().toString(36)}-${deps.random().toString(36).slice(2, 8)}` as ThreadId;

        const setup = createSetupActions({
          get,
          set,
          nowIso,
          newChangeId,
          provider,
          writeback: () => writeback,
          ledger,
          saveChanges,
          post,
          markExpired,
          sleep: deps.sleep,
          locks:
            deps.locks === undefined
              ? typeof navigator === "undefined"
                ? null
                : (navigator.locks ?? null)
              : deps.locks,
          inFlight,
          runAgent: (thread, request, scan) =>
            runThreadAgent(thread, request, { scan }, newRun(null, null)),
        });

        const syncSchool = (school: SchoolId): Promise<boolean> => {
          const running = inFlight.get(`sync:${school}`) as Promise<boolean> | undefined;
          if (running) return running;
          set({ syncing: { ...get().syncing, [school]: true } });
          const run = runSync(school).finally(() => {
            inFlight.delete(`sync:${school}`);
            set({ syncing: { ...get().syncing, [school]: false } });
          });
          inFlight.set(`sync:${school}`, run);
          return run;
        };
        /** A read already out may predate what just happened, so this waits it out and reads again. */
        const syncFresh = async (school: SchoolId): Promise<boolean> => {
          await Promise.allSettled([inFlight.get(`sync:${school}`)]);
          return syncSchool(school);
        };

        const runSync = async (school: SchoolId): Promise<boolean> => {
          const lms = provider(school);
          if (!lms || get().connections[school]?.status === "disconnected") return false;
          // A disconnect or reset can land while the reads are out. Their answers must not bring the school back.
          const gone = () => get().connections[school]?.status === "disconnected";
          const fail = (error: LmsError): false => {
            if (gone()) return false;
            if (error.kind === "auth_expired") markExpired(school);
            patchConnection(school, { syncError: error.kind });
            return false;
          };
          const courses = await writeback.laneRead(school, () => lms.courses());
          if (!courses.ok) return fail(courses.error);
          const perCourse = await Promise.all(
            courses.value.map((course) =>
              Promise.all([
                writeback.laneRead(school, () => lms.assignments(course.ref)),
                writeback.laneRead(school, () => lms.students(course.ref)),
                writeback.laneRead(school, () => lms.submissions(course.ref)),
                writeback.laneRead(school, () => lms.announcements(course.ref)),
              ]),
            ),
          );
          const conversations = lms.capabilities.messaging
            ? await writeback.laneRead(school, () => lms.conversations())
            : ({ ok: true, value: [] } as const);
          if (!conversations.ok) return fail(conversations.error);
          const readThrough = get().prefs.readThrough ?? {};
          const seen = conversations.value.map((c) =>
            readThrough[c.ref] === c.messages.at(-1)?.id ? { ...c, unread: false } : c,
          );
          const cache: { -readonly [K in keyof SchoolCache]: SchoolCache[K][number][] } = {
            courses: [...courses.value],
            assignments: [],
            students: [],
            submissions: [],
            conversations: seen,
            announcements: [],
          };
          for (const [assignments, students, submissions, announcements] of perCourse) {
            if (!assignments.ok) return fail(assignments.error);
            if (!students.ok) return fail(students.error);
            if (!submissions.ok) return fail(submissions.error);
            if (!announcements.ok) return fail(announcements.error);
            cache.assignments.push(...assignments.value);
            cache.students.push(...students.value);
            cache.submissions.push(...submissions.value);
            cache.announcements.push(...announcements.value);
          }
          if (gone()) return false;
          set({ cache: { ...get().cache, [school]: cache } });
          patchConnection(school, { lastSyncedAt: nowIso(), syncError: null });
          await setup.readNewCourses(school, gone);
          return true;
        };

        const applyEdit = (effect: Extract<AgentEffect, { type: "edit" }>, thread: ThreadId) => {
          const prior = get().changes[effect.change];
          const result = ledger.commit(effect.change, {
            type: "edit",
            by: "agent",
            patch: effect.patch,
            at: nowIso(),
          });
          if (!result.ok) {
            post(thread, {
              type: "refusal",
              text: REJECTION_TEXT[result.error],
              at: nowIso(),
              change: effect.change,
            });
            return;
          }
          post(thread, {
            type: "agent",
            text: effect.why,
            at: nowIso(),
            edited: prior ? editsBetween(prior.content, result.value.content) : [],
            change: effect.change,
          });
        };

        const applyAnnotate = (effect: Extract<AgentEffect, { type: "annotate" }>) => {
          const record = get().changes[effect.change];
          if (record?.content.kind !== "grade") return;
          const { target } = record.content;
          const submission = Object.values(get().cache)
            .flatMap((cache) => cache.submissions)
            .find((s) => s.ref === target);
          if (!submission) return;
          const passages = passagesOf(submission);
          const anchors = effect.quotes.map((quote): PassageAnchor => {
            const start = passages[quote.paragraph]?.indexOf(quote.quote) ?? 0;
            return { paragraph: quote.paragraph, start, end: start + quote.quote.length };
          });
          ledger.commit(effect.change, {
            type: "annotate",
            rationale: { field: effect.field, why: effect.why, anchors },
            at: nowIso(),
          });
        };

        const say = (thread: ThreadId, run: AgentRun, message: ThreadMessage) => {
          if (run.held) run.held.push(message);
          else post(thread, run.change ? { ...message, change: run.change } : message);
        };
        const fileHeld = (thread: ThreadId, run: AgentRun, change: ChangeId | null) => {
          const held = run.held ?? [];
          run.held = null;
          run.change = change;
          for (const message of held) post(thread, change ? { ...message, change } : message);
        };

        const recordFrom = async (
          proposal: Proposal,
          by: ActivityActor,
          id: ChangeId,
        ): Promise<Result<ChangeRecord, string>> => {
          const lms = provider(proposal.school);
          if (!lms) return { ok: false, error: "That school isn't connected." };
          const remote = await writeback.laneRead(proposal.school, () =>
            lms.observe(proposal.content),
          );
          if (!remote.ok) {
            if (remote.error.kind === "auth_expired") markExpired(proposal.school);
            return {
              ok: false,
              error: `Couldn't read the LMS, so nothing was drafted. ${errorWords(remote.error)}`,
            };
          }
          const at = nowIso();
          return {
            ok: true,
            value: newChangeRecord({
              id,
              school: proposal.school,
              course: proposal.course,
              subject: proposal.subject,
              content: fitContent(proposal.content, lms.capabilities),
              basis: { readAt: at, remote: remote.value },
              at,
              by,
            }),
          };
        };

        const openOn = (content: ChangeContent) =>
          ledger
            .all()
            .find(
              (change) =>
                sameSlot(change.content, content) &&
                change.state.tag !== "sent" &&
                change.state.tag !== "discarded",
            );
        const blankOn = (content: ChangeContent) =>
          Object.values(get().blanks).find((blank) => sameSlot(blank.content, content));

        const focusIfWanted = (thread: ThreadId, id: ChangeId, content: ChangeContent) => {
          const slot = slotOf(content);
          const current = get().threads[thread];
          const stillWanted = wanted.get(thread);
          if (background.has(slot) && stillWanted !== slot) return;
          if (current && (stillWanted === undefined || stillWanted === slot))
            set({ threads: { ...get().threads, [thread]: { ...current, focus: id } } });
        };

        const applyPropose = async (
          effect: Extract<AgentEffect, { type: "propose" }>,
          thread: ThreadId,
          run: AgentRun,
        ) => {
          const made = await recordFrom(effect, "agent", newChangeId());
          if (!made.ok)
            return say(thread, run, { type: "refusal", text: made.error, at: nowIso() });
          // The read above took time, and one target gets one open change however the request arrived.
          const open = openOn(effect.content);
          if (open) {
            get().focusChange(thread, open.id);
            fileHeld(thread, run, open.id);
            return say(thread, run, {
              type: "agent",
              text: "There's already a draft for this, so I opened it instead of starting another.",
              at: nowIso(),
            });
          }
          const record = made.value;
          saveChanges({ ...get().changes, [record.id]: record });
          focusIfWanted(thread, record.id, record.content);
          fileHeld(thread, run, record.id);
        };

        const openBlank = async (thread: ThreadId, proposal: Proposal) => {
          const { content } = proposal;
          const made = await recordFrom(proposal, "you", blankOn(content)?.id ?? newChangeId());
          if (!made.ok) return post(thread, { type: "notice", text: made.error, at: nowIso() });
          if (get().aiOn()) return;
          const open = openOn(content);
          if (open) return focusIfWanted(thread, open.id, content);
          set({ blanks: { ...get().blanks, [made.value.id]: made.value } });
          focusIfWanted(thread, made.value.id, content);
        };

        const dropBlanks = (school?: SchoolId) => {
          const dropped = Object.values(get().blanks).filter(
            (blank) => school === undefined || blank.school === school,
          );
          const gone = new Set<ChangeId | null>(dropped.map((blank) => blank.id));
          const blanks = Object.fromEntries(
            Object.entries(get().blanks).filter(([id]) => !gone.has(id as ChangeId)),
          );
          set({ blanks, ...withoutFocus(get(), (focus) => gone.has(focus)) });
        };

        const awaitingReply = (course: LmsRef<"course">) =>
          allCaches()
            .flatMap((cache) => cache.conversations)
            .filter((c) => c.course === course && awaitsReply(c));

        const startWork = async (
          thread: ThreadId,
          course: LmsRef<"course">,
          work: HandoffWork,
        ): Promise<void> => {
          const state = get();
          switch (work.kind) {
            case "announcement":
              await state.openAnnouncement(thread, course, work.topic);
              return;
            case "replies": {
              const unread = awaitingReply(course);
              const opened: (ChangeId | null)[] = [];
              // One at a time, because a thread draws one working state and one focus.
              for (const conversation of unread)
                opened.push(await state.openConversation(thread, conversation.ref));
              state.setThreadUi(thread, { queueOpen: true, current: unread[0]?.ref ?? null });
              state.focusChange(thread, opened[0] ?? null);
              return;
            }
            case "reply": {
              const opened = await state.openConversation(thread, work.conversation);
              state.setThreadUi(thread, { queueOpen: true, current: work.conversation });
              state.focusChange(thread, opened);
              return;
            }
            case "grading":
              state.setThreadUi(thread, { queueOpen: true });
              return;
          }
        };

        const workExists = (
          thread: ThreadId,
          course: LmsRef<"course">,
          work: HandoffWork,
        ): boolean => {
          switch (work.kind) {
            case "announcement":
              return existingChange({ kind: "announcement", target: course }, null) !== null;
            case "replies": {
              const unread = awaitingReply(course);
              return (
                unread.length > 0 &&
                unread.every(
                  (conversation) =>
                    existingChange({ kind: "reply", target: conversation.ref }, null) !== null,
                )
              );
            }
            case "reply":
              return existingChange({ kind: "reply", target: work.conversation }, null) !== null;
            case "grading":
              return (
                get().threads[thread]?.messages.some((message) => message.type === "handed-off") ??
                false
              );
          }
        };

        /** Safe to run again after a reload: work that already exists is only focused. */
        const runHandoff = async (pending: PendingHandoff): Promise<void> => {
          const key = `${pending.thread} ${JSON.stringify(pending.work)}`;
          set({ handoffs: { ...get().handoffs, [key]: pending } });
          try {
            await startWork(pending.thread, pending.course, pending.work);
          } finally {
            const { [key]: _done, ...rest } = get().handoffs;
            set({ handoffs: rest });
          }
        };

        const applyHandoff = (
          effect: Extract<AgentEffect, { type: "handoff" }>,
          from: ThreadId,
          run: AgentRun,
        ) => {
          const course = selectCourse(get(), effect.course);
          if (!course) return;
          const to = get().threadForWork(course, effect.work);
          if (!workExists(to, effect.course, effect.work)) {
            const destination = get().threads[to];
            if (destination)
              set({
                threads: {
                  ...get().threads,
                  [to]: {
                    ...destination,
                    messages: destination.messages.filter((message) => !message.seeded),
                  },
                },
              });
            post(to, {
              type: "handed-off",
              from,
              request: effect.request,
              ...(effect.left === undefined ? {} : { left: effect.left }),
              at: nowIso(),
            });
          }
          say(from, run, {
            type: "handoff",
            to,
            course: effect.course,
            ...(effect.work.kind === "reply" ? { conversation: effect.work.conversation } : {}),
            ...(effect.work.kind === "replies"
              ? { people: awaitingReply(effect.course).map((c) => c.from) }
              : {}),
            brief: effect.brief,
            at: nowIso(),
          });
          run.started.push(runHandoff({ thread: to, course: effect.course, work: effect.work }));
        };

        const sinkFor = (thread: ThreadId, run: AgentRun): AgentSink => ({
          effect: async (effect) => {
            switch (effect.type) {
              case "say":
                return say(thread, run, {
                  type: "agent",
                  text: effect.text,
                  at: nowIso(),
                  ...(effect.lines ? { lines: effect.lines } : {}),
                  ...(effect.replies ? { replies: effect.replies } : {}),
                });
              case "decline":
                return say(thread, run, {
                  type: "declined",
                  text: effect.text,
                  at: nowIso(),
                  ...(effect.lines ? { lines: effect.lines } : {}),
                });
              case "work":
                return say(thread, run, { type: "work", lines: [effect.line], at: nowIso() });
              case "propose":
                return applyPropose(effect, thread, run);
              case "edit":
                return applyEdit(effect, thread);
              case "annotate":
                return applyAnnotate(effect);
              case "finding":
                return setup.applyFinding(thread, effect);
              case "handoff":
                return applyHandoff(effect, thread, run);
            }
          },
          refuse: (violation) =>
            say(thread, run, { type: "refusal", text: describeViolation(violation), at: nowIso() }),
        });

        const runThreadAgent = async (
          thread: ThreadId,
          request: string,
          narrow: Partial<Omit<AgentScope, "changes" | "focus">> | null,
          run: AgentRun,
        ) => {
          const current = get().threads[thread];
          if (!current || !get().aiOn()) return;
          const data = scopeOf(get(), current);
          const scope: AgentScope = {
            focus: current.focus,
            ...data,
            ...narrow,
            get changes() {
              return Object.values(get().changes).filter(
                (change) => !current.course || change.course === current.course,
              );
            },
          };
          const history = current.messages.flatMap((message): AgentInput["thread"]["history"] =>
            message.type === "user"
              ? [{ role: "user", text: message.text }]
              : message.type === "agent"
                ? [{ role: "agent", text: message.text }]
                : [],
          );
          set({ working: { ...get().working, [thread]: true } });
          try {
            await runAgent(
              agent,
              { request, thread: { history }, scope },
              sinkFor(thread, run),
              new AbortController().signal,
            );
            await Promise.allSettled(run.started);
          } finally {
            fileHeld(thread, run, run.change);
            set({ working: { ...get().working, [thread]: false } });
          }
        };

        /** Latest live change for a target. A sent grade stays the answer until the student submits again. */
        const existingChange = (
          content: Pick<ChangeContent, "kind" | "target">,
          submittedAt: IsoTime | null,
        ): ChangeRecord | null => {
          const candidates = Object.values(get().changes).filter(
            (change) => sameSlot(change.content, content) && change.state.tag !== "discarded",
          );
          return (
            candidates.find((change) => {
              if (change.state.tag !== "sent") return true;
              return (
                change.content.kind === "grade" &&
                (submittedAt === null || submittedAt <= change.state.at)
              );
            }) ?? null
          );
        };

        const openTarget = async (
          thread: ThreadId,
          submittedAt: IsoTime | null,
          request: string,
          narrow: Partial<Omit<AgentScope, "changes" | "focus">>,
          blank: Proposal,
          { focus = true }: OpenOptions = {},
        ): Promise<ChangeId | null> => {
          const { content } = blank;
          const slot = slotOf(content);
          if (focus) wanted.set(thread, slot);
          const existing = existingChange(content, submittedAt);
          if (existing) {
            if (focus) get().focusChange(thread, existing.id);
            return existing.id;
          }
          const running = inFlight.get(`open:${slot}`) as Promise<ChangeId | null> | undefined;
          if (running) return running;
          if (!focus) background.add(slot);
          const run = (
            get().aiOn()
              ? runThreadAgent(thread, request, narrow, newRun(null, []))
              : openBlank(thread, blank)
          )
            .then(() => existingChange(content, submittedAt)?.id ?? blankOn(content)?.id ?? null)
            .finally(() => {
              inFlight.delete(`open:${slot}`);
              background.delete(slot);
            });
          inFlight.set(`open:${slot}`, run);
          return run;
        };

        const allCaches = () => Object.values(get().cache);

        /** Puts the old token back after a refused replacement. A token the LMS has revoked isn't worth keeping. */
        const restoreToken = async (school: SchoolId, credential: Credential): Promise<boolean> => {
          await deps.vault.enroll(school, credential);
          const check = await provider(school)?.verify();
          return check?.ok === true || check?.error.kind !== "auth_expired";
        };

        /** Saves and checks a token for a school, which joins `schools`, kept in name order, only once the LMS accepts it. */
        const enroll = async (
          target: School,
          secret: Secret,
          onStage?: (stage: ConnectStage) => void,
        ): Promise<Result<AccountInfo, string>> => {
          const school = target.id;
          const known = schoolById(school) !== undefined;
          const descriptor = backend.descriptors[target.provider];
          const lms = providerOf(target);
          if (!descriptor || !lms) return { ok: false, error: "That school isn't available." };
          if (descriptor.enrollment.kind === "paste-token") {
            const { validate } = descriptor.enrollment;
            const invalid = revealSecret(secret, (raw) => validate(raw));
            if (invalid) return { ok: false, error: invalid };
          }
          const before = get().connections[school]?.status ?? "disconnected";
          const previous =
            before === "disconnected"
              ? null
              : await deps.vault
                  .leaseFor(school)
                  .use(async (credential) => credential)
                  .catch(() => null);
          onStage?.("saving");
          try {
            await deps.vault.enroll(school, { kind: "bearer", token: secret });
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : "The token could not be stored.",
            };
          }
          onStage?.("checking");
          const account = await writeback.laneRead(school, () => lms.verify());
          if (!account.ok) {
            const kept = previous !== null && (await restoreToken(school, previous));
            if (!kept) await deps.vault.forget(school);
            const reason =
              account.error.kind === "auth_expired"
                ? "That token was refused. Generate a new one and try again."
                : "The LMS could not be reached, so nothing was saved.";
            if (!known) {
              providers.delete(school);
              return { ok: false, error: reason };
            }
            patchConnection(school, {
              status: kept ? before : previous ? "expired" : "disconnected",
            });
            // A send during the check could have closed the lane on the replacement token.
            if (kept && before === "connected") writeback.reopen(school);
            return {
              ok: false,
              error:
                kept && before === "connected"
                  ? `${reason} Your current token is still in use.`
                  : reason,
            };
          }
          if (!schoolById(school))
            set({
              schools: [...get().schools, target].sort(bySchoolName),
            });
          patchConnection(school, {
            status: "connected",
            connectedAt: nowIso(),
            accountName: account.value.displayName,
            scopes: account.value.scopes,
            syncError: null,
          });
          if (get().notice === expiredNotice(school)) set({ notice: null });
          writeback.reopen(school);
          onStage?.("reading");
          await syncSchool(school);
          get().resumeSetups();
          return { ok: true, value: account.value };
        };

        return {
          ...initialData(backend, deps.realNow()),
          blanks: {},
          working: {},
          syncing: {},
          setupLive: {},
          setupOptions: {},
          notice: null,
          ...setup.actions,

          now: () => clock.now(),
          aiOn: () => deps.aiAlways === true || get().aiSource !== "none",

          boot: async () => {
            const { changes, blanks } = get();
            const { threads, prefs } = withoutFocus(
              get(),
              (focus) => !changes[focus] && !blanks[focus],
            );
            const seeded = backend.seedThreads();
            // A saved workspace keeps its grading messages but not the old name for the list.
            const renamed = Object.values(threads)
              .filter((thread) => thread.kind === "queue")
              .map((thread) => ({ ...thread, title: seeded[thread.id]?.title ?? thread.title }));
            const saved = [...Object.values(threads), ...renamed];
            const honest = saved.map((thread) => ({
              ...thread,
              messages: thread.messages.filter(
                (message) => !(message.seeded && message.type === "user"),
              ),
            }));
            set({
              threads: moveHomeToChat(
                { ...seeded, ...Object.fromEntries(honest.map((thread) => [thread.id, thread])) },
                newThreadId,
              ),
              prefs,
            });
            // A reload during connect or add can leave a token nothing vouched for, even for a school not added yet.
            for (const key of await deps.vault.keys())
              if (key !== "ai-key" && !isVouched(get().connections[key]?.status))
                await deps.vault.forget(key);
            for (const school of get().schools) {
              const status = get().connections[school.id]?.status;
              if (status === "connected" && !(await deps.vault.has(school.id))) {
                patchConnection(school.id, { status: "disconnected" });
                set({
                  notice: `The saved token for ${school.name} is gone. Connect again to continue.`,
                });
              }
            }
            if (get().aiSource === "key" && !(await deps.vault.has("ai-key")))
              set({ aiSource: "none" });
            await writeback.recover();
            for (const pending of Object.values(get().handoffs)) void runHandoff(pending);
            // A reload between connecting and the first sync would otherwise leave a connected school with no courses.
            for (const connection of Object.values(get().connections))
              if (connection.status === "connected" && connection.lastSyncedAt === null)
                void syncSchool(connection.school);
            get().resumeSetups();
            setup.rescanUnsettled();
          },

          connect: async (school, secret, onStage) => {
            const target = schoolById(school);
            return target
              ? enroll(target, secret, onStage)
              : { ok: false, error: "That school isn't available." };
          },

          addSchool: async (host, secret, onStage) => {
            const target =
              get().schools.find((school) => school.host === host) ?? backend.schoolAt(host);
            if (!target)
              return {
                ok: false,
                error: `Couldn't find a school at ${host}. Check it against your browser's address bar when you sign in to your school's LMS, or ask your school's IT help desk for it.`,
              };
            const result = await enroll(target, secret, onStage);
            return result.ok ? { ok: true, value: target } : result;
          },

          removeSchool: async (school) => {
            if (hasChanges(get(), school)) return false;
            await deps.vault.forget(school);
            providers.delete(school);
            const { [school]: _connection, ...connections } = get().connections;
            const { [school]: _cache, ...cache } = get().cache;
            const { [school]: _shells, ...newCourses } = get().newCourses;
            set({
              schools: get().schools.filter((entry) => entry.id !== school),
              connections,
              cache,
              newCourses,
            });
            dropBlanks(school);
            return true;
          },

          disconnect: async (school) => {
            await deps.vault.forget(school);
            patchConnection(school, { ...emptyConnection(school) });
            const { [school]: _dropped, ...cache } = get().cache;
            const { [school]: _shells, ...newCourses } = get().newCourses;
            set({ cache, newCourses });
            dropBlanks(school);
          },

          addAiKey: async (secret) => {
            await deps.vault.enroll("ai-key", { kind: "bearer", token: secret });
            set({ aiSource: "key" });
            dropBlanks();
          },

          chooseOnDeviceModel: async () => {
            await deps.vault.forget("ai-key");
            set({ aiSource: "on-device" });
            dropBlanks();
          },

          turnOffAi: async () => {
            await deps.vault.forget("ai-key");
            set({ aiSource: "none" });
          },

          scopeWordsFor: (school) => {
            const lms = provider(school);
            return lms
              ? [
                  ...new Set(
                    get().connections[school]?.scopes.map((scope) => lms.describeScope(scope)),
                  ),
                ]
              : [];
          },

          syncSchool,

          openSubmission: async (thread, ref, options) => {
            for (const cache of allCaches()) {
              const submission = cache.submissions.find((s) => s.ref === ref);
              if (!submission) continue;
              const assignment = cache.assignments.find((a) => a.ref === submission.assignment);
              const course = cache.courses.find((c) => c.ref === submission.course);
              if (!assignment || !course) return null;
              return openTarget(
                thread,
                submission.submittedAt,
                DRAFT_GRADE_REQUEST,
                {
                  submissions: [submission],
                  assignments: [assignment],
                  courses: [course],
                  conversations: [],
                },
                blankGrade(submission, assignment),
                options,
              );
            }
            return null;
          },

          openConversation: async (thread, ref, options) => {
            for (const cache of allCaches()) {
              const conversation = cache.conversations.find((c) => c.ref === ref);
              if (!conversation) continue;
              const course = cache.courses.find((c) => c.ref === conversation.course);
              if (!course) return null;
              return openTarget(
                thread,
                null,
                DRAFT_REPLY_REQUEST,
                {
                  conversations: [conversation],
                  courses: [course],
                  submissions: [],
                  assignments: [],
                },
                blankReply(conversation),
                options,
              );
            }
            return null;
          },

          openMessage: async (thread, ref) => {
            for (const cache of allCaches()) {
              const submission = cache.submissions.find((s) => s.ref === ref);
              if (!submission) continue;
              const assignment = cache.assignments.find((a) => a.ref === submission.assignment);
              const course = cache.courses.find((c) => c.ref === submission.course);
              if (!assignment || !course) return null;
              return openTarget(
                thread,
                null,
                DRAFT_MESSAGE_REQUEST,
                {
                  submissions: [submission],
                  assignments: [assignment],
                  courses: [course],
                  conversations: [],
                },
                blankMessage(submission, assignment),
              );
            }
            return null;
          },

          openAnnouncement: async (thread, ref, topic) => {
            for (const cache of allCaches()) {
              const course = cache.courses.find((c) => c.ref === ref);
              if (course)
                return openTarget(
                  thread,
                  null,
                  topic === undefined ? DRAFT_ANNOUNCEMENT_REQUEST : draftAnnouncementAbout(topic),
                  { courses: [course], submissions: [], assignments: [], conversations: [] },
                  blankAnnouncement(course),
                );
            }
            return null;
          },

          focusChange: (thread, change) => {
            const record = change && (get().changes[change] ?? get().blanks[change]);
            if (record) wanted.set(thread, slotOf(record.content));
            else wanted.delete(thread);
            const current = get().threads[thread];
            if (current)
              set({ threads: { ...get().threads, [thread]: { ...current, focus: change } } });
          },

          createThread: (init) => {
            const id = newThreadId();
            const thread: Thread = { ...init, id, messages: [], focus: null, updatedAt: nowIso() };
            set({ threads: { ...get().threads, [id]: thread } });
            return id;
          },

          settleThreads: (ids) => {
            const at = nowIso();
            const settled = ids.flatMap((id) => {
              const thread = get().threads[id];
              return thread && canSettle(thread)
                ? [[id, { ...thread, settledAt: at }] as const]
                : [];
            });
            if (settled.length > 0)
              set({ threads: { ...get().threads, ...Object.fromEntries(settled) } });
          },
          resumeThreads: (ids) => {
            const resumed = ids.flatMap((id) => {
              const thread = get().threads[id];
              if (thread?.settledAt === undefined) return [];
              const { settledAt: _settledAt, ...rest } = thread;
              return [[id, rest] as const];
            });
            if (resumed.length > 0)
              set({ threads: { ...get().threads, ...Object.fromEntries(resumed) } });
          },

          threadForWork: (course, work) => {
            const { threads, createThread } = get();
            const destination =
              work.kind === "grading"
                ? ({ kind: "grading", assignment: work.assignment } as const)
                : ({ kind: work.kind === "announcement" ? "announcement" : "messages" } as const);
            const existing = Object.values(threads).find(
              (thread) =>
                thread.course === course.ref &&
                thread.kind === destination.kind &&
                (destination.kind !== "grading" || thread.assignment === destination.assignment),
            );
            if (existing) return existing.id;
            const title =
              work.kind === "grading"
                ? workName({
                    kind: "grading",
                    assignment:
                      selectAssignment(get(), work.assignment)?.shortTitle ?? "assignment",
                  })
                : work.kind === "announcement"
                  ? workName({ kind: "announcement", title: "", course: course.code })
                  : `${course.code} messages`;
            const about = { school: course.school, course: course.ref, title };
            return createThread(
              destination.kind === "grading"
                ? { ...about, ...destination }
                : { ...about, kind: destination.kind },
            );
          },

          startChat: (text) => {
            if (!get().aiOn()) return null;
            const thread = get().createThread({
              school: null,
              course: null,
              kind: "north-star-chat",
              title: oneLine(text),
            });
            return { thread, done: get().sendToAgent(thread, text) };
          },

          sendToAgent: async (thread, text) => {
            const current = get().threads[thread];
            if (!get().aiOn() || current?.kind === "north-star") return;
            const focus = current?.focus ?? null;
            post(thread, { type: "user", text, at: nowIso(), ...(focus ? { change: focus } : {}) });
            const scan = await setup.scanScope(thread);
            // With no draft open, a messages thread is about the conversation on screen, so "draft a reply" has one answer.
            const showing = selectThreadUi(get(), thread).current;
            const open =
              current?.kind === "messages" && !focus && showing
                ? selectConversation(get(), showing as LmsRef<"conversation">)
                : null;
            const northStar =
              current?.kind === "north-star-chat"
                ? {
                    courses: get().schools.flatMap(
                      (school) => get().cache[school.id]?.courses ?? [],
                    ),
                    northStar: {
                      announcements: allCaches().flatMap((cache) => cache.announcements),
                      schools: get().schools,
                      now: nowIso(),
                      next: nextWorkOf(get(), get().now()),
                    },
                  }
                : null;
            await runThreadAgent(
              thread,
              text,
              northStar ??
                (scan && { scan }) ??
                (open && { conversations: [open], submissions: [], assignments: [] }),
              newRun(focus, null),
            );
          },

          setConversationRead: (ref, read) => {
            const conversation = allCaches()
              .flatMap((cache) => cache.conversations)
              .find((c) => c.ref === ref);
            if (!conversation) return;
            const { [ref]: _dropped, ...rest } = get().prefs.readThrough ?? {};
            const last = conversation.messages.at(-1)?.id;
            set({
              prefs: {
                ...get().prefs,
                readThrough: read && last ? { ...rest, [ref]: last } : rest,
              },
              cache: {
                ...get().cache,
                [conversation.school]: {
                  ...(get().cache[conversation.school] as SchoolCache),
                  conversations: (
                    get().cache[conversation.school] as SchoolCache
                  ).conversations.map((c) => (c.ref === ref ? { ...c, unread: !read } : c)),
                },
              },
            });
          },

          dispatchUser: (id, event) => {
            syncFromStorage();
            const blank = get().blanks[id];
            const saved = get().changes[id];
            if (saved && event.type === "edit" && saved.activity[0]?.actor === "you") {
              const next = transition(saved, event);
              if (next.ok && saved.seen === null && !get().aiOn() && isBlank(next.value.content)) {
                const { [id]: _unsaved, ...changes } = get().changes;
                const form = { ...next.value, activity: saved.activity.slice(0, 1) };
                saveChanges(changes, { blanks: { ...get().blanks, [id]: form } });
                return { ok: true, value: form };
              }
            }
            if (!blank || saved) return ledger.commit(id, event);
            if (event.type !== "edit") return { ok: false, error: "not-editable" };
            const { [id]: _promoted, ...blanks } = get().blanks;
            const open = openOn(blank.content);
            if (open) {
              set({ blanks });
              for (const thread of Object.values(get().threads))
                if (thread.focus === id) get().focusChange(thread.id, open.id);
              return { ok: false, error: "not-editable" };
            }
            const next = transition(blank, event);
            if (next.ok && sameWords(next.value.content, blank.content))
              return { ok: true, value: blank };
            if (next.ok) saveChanges({ ...get().changes, [id]: next.value }, { blanks });
            return next;
          },

          restoreChange: (before) => {
            const now = ledger.get(before.id);
            const justDiscarded =
              now?.state.tag === "discarded" && now.activity.length === before.activity.length + 1;
            if (!justDiscarded || openOn(before.content)) return false;
            saveChanges({ ...get().changes, [before.id]: before });
            return true;
          },

          sendChanges: async (ids, onItem) => {
            let results: readonly RunResult[];
            try {
              results = await writeback.send(ids, onItem);
            } catch {
              // A commit that could not be saved. Memory may be ahead of storage, so go back to what is durable.
              syncFromStorage(true);
              set({
                notice:
                  "Couldn't save the send state, so the send stopped. Reload to check where it got to.",
              });
              return ids.map((id) => ({ id, refused: "not-sendable" }));
            }
            const touched = new Set(
              results.flatMap((result) => {
                const record = get().changes[result.id];
                return record && "state" in result && result.state !== "approved"
                  ? [record.school]
                  : [];
              }),
            );
            await Promise.all(
              [...touched]
                .filter((school) => writeback.laneStatus(school).state !== "closed")
                .map((school) => syncFresh(school)),
            );
            await setup.afterSend(results.map((result) => result.id));
            return results;
          },

          resolveConflict: async (id, choices) => {
            const record = ledger.get(id);
            const lms = record && provider(record.school);
            if (!record || !lms) return { ok: false, error: "not-conflicted" };
            const remote = await writeback.laneRead(record.school, () =>
              lms.observe(record.content),
            );
            if (!remote.ok) return { ok: false, error: remote.error.kind };
            const resolved = ledger.commit(id, {
              type: "resolve-conflict",
              choices,
              remote: remote.value,
              at: nowIso(),
            });
            if (resolved.ok && resolved.value.state.tag === "discarded")
              noticeFocused(
                id,
                "Conflict resolved. There's nothing left to write, so this change is closed.",
              );
            return resolved;
          },

          checkAgain: async (id) => {
            const checked = await writeback.check(id);
            if (!checked.ok) return "unreachable";
            const finished = checked.value.state.tag === "sent";
            if (finished) {
              await syncFresh(checked.value.school);
              await setup.afterSend([id]);
            }
            return finished ? "confirmed" : "still-unconfirmed";
          },

          previewFor: (id) => {
            const record = get().changes[id] ?? get().blanks[id];
            const lms = record && provider(record.school);
            return record && lms ? previewOf(record, lms.capabilities.commentEffect) : null;
          },

          capabilitiesFor: (school) => provider(school)?.capabilities ?? null,

          enrollmentFor: (school) => {
            const target = schoolById(school);
            return target ? (backend.descriptors[target.provider]?.enrollment ?? null) : null;
          },
          newSchoolEnrollment: () =>
            backend.descriptors[backend.newSchoolProvider]?.enrollment ?? null,
          demoHosts: () => backend.demoHosts,

          laneStatus: (school) => writeback.laneStatus(school),
          setOnboarding: (step) => set({ onboarding: step }),
          setPrefs: (patch) => set({ prefs: { ...get().prefs, ...patch } }),
          setThreadUi: (thread, patch) => {
            const { prefs } = get();
            set({
              prefs: {
                ...prefs,
                threadUi: {
                  ...prefs.threadUi,
                  [thread]: { ...(prefs.threadUi[thread] ?? DEFAULT_THREAD_UI), ...patch },
                },
              },
            });
          },
          vendorLabelFor: (school) => provider(school)?.vendorLabel ?? null,
          agentLabel: () => agent.label,
          dismissNotice: () => set({ notice: null }),

          resetDemoData: async () => {
            await deps.vault.forgetAll();
            backend.reset();
            deps.storage.removeItem(WORKSPACE_STORAGE_KEY);
            inFlight.clear();
            writeback = makeWriteback();
            set({
              ...initialData(backend, deps.realNow()),
              blanks: {},
              working: {},
              syncing: {},
              setupLive: {},
              setupOptions: {},
              notice: "Demo data was reset.",
            });
          },
        };
      },
      {
        name: WORKSPACE_STORAGE_KEY,
        version: STORE_VERSION,
        storage,
        merge: keepLocalFocus,
        partialize: ({
          schools,
          connections,
          onboarding,
          aiSource,
          cache,
          changes,
          threads,
          setups,
          newCourses,
          prefs,
          handoffs,
          resetAt,
        }) => ({
          schools,
          connections,
          onboarding,
          aiSource,
          cache,
          changes,
          threads,
          setups,
          newCourses,
          prefs,
          handoffs,
          resetAt,
        }),
      },
    ),
  );

  clock.now = () => backend.epoch + (deps.realNow() - store.getState().resetAt);

  /** Another tab may have committed since we last read. A change must never be judged from a stale copy. */
  function syncFromStorage(force = false): void {
    if (!force && deps.storage.getItem(WORKSPACE_STORAGE_KEY) === lastRaw) return;
    void store.persist.rehydrate();
    if (loadNotice) applyLoadNotice();
  }

  const applyLoadNotice = () => {
    const notice = loadNotice;
    loadNotice = null;
    if (notice)
      store.setState({
        ...initialData(backend, deps.realNow()),
        blanks: {},
        working: {},
        syncing: {},
        setupLive: {},
        setupOptions: {},
        notice,
      });
  };
  applyLoadNotice();

  deps.subscribeStorage?.(() => {
    syncFromStorage();
    const { blanks, aiOn } = store.getState();
    if (aiOn() && Object.keys(blanks).length > 0)
      store.setState({
        blanks: {},
        ...withoutFocus(store.getState(), (focus) => blanks[focus] !== undefined),
      });
    for (const connection of Object.values(store.getState().connections))
      if (connection.status === "connected") writeback.reopen(connection.school);
    store.getState().resumeSetups();
  });

  return Object.assign(store, { syncFromStorage: () => syncFromStorage() });
};

const browserDeps = (): WorkspaceDeps => ({
  storage: localStorage,
  vault: createBrowserVault(),
  backend: fakeCanvasBackend({}),
  realNow: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
  subscribeStorage: (onChange) => {
    window.addEventListener("storage", (event) => {
      if (event.key === WORKSPACE_STORAGE_KEY || event.key === null) onChange();
    });
  },
});

let lab: FaultLab | null = null;
const FAKE_HOSTS = FAKE_SCHOOLS.map((school) => school.host);

/** Wires the fake LMS in. A real provider replaces this one function and the screens never notice. */
export const fakeCanvasBackend =
  (options: {
    noise?: NoiseConfig;
    demoScript?: boolean;
    storage?: StorageLike;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    onServer?: (server: FakeCanvasServer) => void;
  }) =>
  (now: () => number): Backend => {
    const server = new FakeCanvasServer({
      storage: options.storage ?? localStorage,
      now,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? (() => Math.random()),
      ...(options.noise ? { noise: options.noise } : {}),
      ...(options.demoScript === undefined ? {} : { demoScript: options.demoScript }),
    });
    lab = server;
    options.onServer?.(server);
    return {
      schoolAt: (host) => FAKE_SCHOOLS.find((school) => school.host === host) ?? null,
      demoHosts: FAKE_HOSTS,
      newSchoolProvider: "fake-canvas",
      descriptors: { "fake-canvas": createFakeCanvasDescriptor(server, now) },
      epoch: new Date(SEED.now).getTime(),
      seedThreads,
      reset: () => server.reset(),
    };
  };

let instance: WorkspaceStore | null = null;
export const workspaceStore = (): WorkspaceStore =>
  (instance ??= createWorkspaceStore(browserDeps()));

export const faultLab = (): FaultLab => {
  workspaceStore();
  return lab as FaultLab;
};

export const useWorkspace = <T>(selector: (state: WorkspaceState) => T): T =>
  useStore(workspaceStore(), selector);

export const useAiOn = (): boolean => useWorkspace((state) => state.aiOn());
