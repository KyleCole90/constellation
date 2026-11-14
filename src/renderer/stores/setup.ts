import { SCAN_COURSE_REQUEST, type AgentEffect, type AgentScope } from "~/shared/agent/agent";
import {
  copySignature,
  errorWords,
  fieldText,
  newChangeRecord,
  summarize,
  transition,
  type ChangeContent,
  type ChangeRecord,
  type CourseCopyContent,
  type LmsError,
  type RemoteState,
  type SetContent,
  type UserEvent,
} from "~/shared/domain/change";
import type {
  CopySource,
  CourseContent,
  Migration,
  PackageTerm,
  SamplePackage,
  SourceCourse,
} from "~/shared/domain/content";
import type { ChangeId, IsoTime, LmsRef, Result, SchoolId, ThreadId } from "~/shared/domain/ids";
import { scanCourse, type FindingKey } from "~/shared/domain/scan";
import {
  canCancelSetup,
  canDropFix,
  copyMigration,
  fixBasis,
  keepWords,
  readinessOf,
  reconcile,
  reviewRows,
  rewordFinding,
  templateChangeOf,
  type CourseSetup,
  type Resolution,
  type SetupLive,
} from "~/shared/domain/setup";
import { quoteWords } from "~/shared/domain/preview";
import { planProblems, shiftOptionsOf, type PlanDraft, type TermPlan } from "~/shared/domain/term";
import type { LmsProvider, Read, TermSetup } from "~/shared/providers/provider";
import type { ChangeLedger, Writeback } from "~/renderer/writeback/writeback";

import type { Thread, ThreadMessage, WorkspaceData } from "./types";
import type { WorkspaceState } from "./workspace";

const POLL_MS = 500;
const SCAN_STEP_MS = 120;
const MAX_MISSES = 5;
const COPY_MARKS = [20, 60, 100] as const;
const SCAN_AREAS = [
  "syllabus",
  "pages",
  "assignments",
  "announcements",
  "modules",
  "files",
  "tools",
] as const;

type CourseRef = LmsRef<"course">;
type ScanScope = NonNullable<AgentScope["scan"]>;

export interface SetupOptions {
  sources: readonly SourceCourse[];
  samples: readonly SamplePackage[];
}

/** What `cancelSetup` dropped, so `restoreSetup` can put it back. */
interface CancelledSetup {
  setup: CourseSetup;
  thread: Thread;
  /** The copy as it was before the cancel discarded it. Null when there was no live copy to discard. */
  copy: ChangeRecord | null;
}

export interface SetupActions {
  startSetup(course: CourseRef): ThreadId;
  /** Drops the setup and its thread, so the course is offered again. Refused once the copy may have reached the LMS. */
  cancelSetup(course: CourseRef): Result<CancelledSetup, string>;
  /** Undoes `cancelSetup`. A discarded copy comes back as a new draft of the same content, so it needs approving again. */
  restoreSetup(cancelled: CancelledSetup): string | null;
  loadSetupOptions(school: SchoolId): Promise<void>;
  chooseSource(course: CourseRef, source: CopySource | null): string | null;
  /** `hint` is what main read from the package itself. A sample package's listed term, which names the term too, wins over it. */
  chooseCartridgeFile(
    course: CourseRef,
    file: { name: string; size: number; hint?: PackageTerm | null },
  ): string | null;
  /** True where main's own file picker chooses the package, so the page shows a button rather than a file input. */
  picksPackage(school: SchoolId): boolean;
  /** Opens main's file picker and chooses the package it answers. Null when chosen or cancelled, else the refusal. */
  pickCartridge(course: CourseRef): Promise<string | null>;
  editDates(course: CourseRef, plan: PlanDraft): void;
  confirmDates(course: CourseRef, plan: TermPlan): Promise<string | null>;
  retryCopy(course: CourseRef): Promise<string | null>;
  scanNow(course: CourseRef): Promise<string | null>;
  dismissFinding(course: CourseRef, key: FindingKey, reason: string | null): string | null;
  markHandled(course: CourseRef, key: FindingKey): string | null;
  restoreFinding(course: CourseRef, key: FindingKey): Promise<string | null>;
  runPublishCheck(course: CourseRef): Promise<string | null>;
  proposePublish(course: CourseRef): Promise<Result<ChangeId, string>>;
  proposeTemplate(
    course: CourseRef,
  ): Promise<Result<{ thread: ThreadId; change: ChangeId }, string>>;
  resumeSetups(): void;
}

export interface SetupHost {
  get(): WorkspaceState;
  set(patch: Partial<WorkspaceState>): void;
  nowIso(): IsoTime;
  newChangeId(): ChangeId;
  provider(school: SchoolId): LmsProvider | null | undefined;
  writeback(): Writeback;
  ledger: ChangeLedger;
  saveChanges(changes: WorkspaceData["changes"], also?: Partial<WorkspaceData>): void;
  post(thread: ThreadId, message: ThreadMessage): void;
  markExpired(school: SchoolId): void;
  sleep(ms: number): Promise<void>;
  locks: Pick<LockManager, "request"> | null;
  inFlight: Map<string, Promise<unknown>>;
  runAgent(thread: ThreadId, request: string, scan: ScanScope): Promise<void>;
}

const REFUSED_CSV = "Canvas course exports are .imscc, not CSV.";
const REFUSED_OTHER = "That file isn't a course export. Choose a file that ends in .imscc.";

const copyMarksOf = (job: Migration): readonly string[] => {
  const started = job.state !== "queued" || job.completion > 0;
  const marks = COPY_MARKS.filter((mark) => job.completion >= mark).map(
    (mark) => `Copying, ${mark} percent`,
  );
  return ["Creating the migration", ...(started ? ["Preparing the package"] : []), ...marks];
};

export const createSetupActions = (host: SetupHost) => {
  const { get, set, nowIso, ledger } = host;
  /** The last read of each course, for the agent. Too big to persist, and a reload reads it again. */
  const lastContent = new Map<string, CourseContent>();
  /** One scan at a time per course, each reading fresh, so two quick sends can't commit an older read over a newer one. */
  const scanTails = new Map<string, Promise<unknown>>();

  const setupOf = (course: string): CourseSetup | undefined => get().setups[course];
  const patchSetup = (course: string, patch: Partial<CourseSetup>) => {
    const current = setupOf(course);
    if (current) set({ setups: { ...get().setups, [course]: { ...current, ...patch } } });
  };
  const patchLive = (course: string, patch: Partial<SetupLive>) => {
    const current = get().setupLive[course] ?? { migration: null, scan: null };
    set({ setupLive: { ...get().setupLive, [course]: { ...current, ...patch } } });
  };
  /** Takes in what another tab saved, so a save built on this can't write over it. */
  const latestChanges = (): WorkspaceData["changes"] => {
    ledger.all();
    return get().changes;
  };
  const copyOf = (setup: CourseSetup): ChangeRecord | undefined =>
    setup.copy ? get().changes[setup.copy] : undefined;
  const termOf = (school: SchoolId): TermSetup | undefined => host.provider(school)?.termSetup;
  const copyContentOf = (record: ChangeRecord | undefined): CourseCopyContent | null =>
    record?.content.kind === "course-copy" ? record.content : null;
  const failedJob = (course: string): boolean =>
    get().setupLive[course]?.migration?.state === "failed";

  const noteFailure = (school: SchoolId, error: LmsError): string => {
    if (error.kind === "auth_expired") host.markExpired(school);
    return errorWords(error);
  };

  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const running = host.inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const started = run().finally(() => host.inFlight.delete(key));
    host.inFlight.set(key, started);
    return started;
  };

  const postOnce = (thread: ThreadId, text: string) => {
    const said = get().threads[thread]?.messages.some(
      (message) => message.type === "work" && message.lines.includes(text),
    );
    if (!said) host.post(thread, { type: "work", lines: [text], at: nowIso() });
  };

  /** Lines say which attempt they belong to, because a retry has to report its own progress and not read as already said. */
  const attemptSuffix = (setup: CourseSetup): string => {
    const started = Object.values(get().changes).filter(
      (record) => record.content.target === setup.shell.copyTarget && record.seen !== null,
    ).length;
    return started > 1 ? ` (attempt ${started})` : "";
  };

  // ---- Reads. Every one goes through the school's lane, so a 429 slows the sends and the sync as well. ----

  const laneRead = <T>(school: SchoolId, read: () => Read<T>): Read<T> =>
    host.writeback().laneRead(school, read);

  const readObserve = async (
    school: SchoolId,
    content: ChangeContent,
  ): Promise<Result<RemoteState, string>> => {
    const lms = host.provider(school);
    if (!lms) return { ok: false, error: "That school isn't connected." };
    const remote = await laneRead(school, () => lms.observe(content));
    return remote.ok
      ? remote
      : {
          ok: false,
          error: `Couldn't read the LMS, so nothing was drafted. ${noteFailure(school, remote.error)}`,
        };
  };

  // ---- Drafting. Nothing here approves or sends. ----

  const draftCopy = async (
    setup: CourseSetup,
    source: CopySource,
    plan: TermPlan,
  ): Promise<string | null> => {
    const content: CourseCopyContent = {
      kind: "course-copy",
      target: setup.shell.copyTarget,
      into: { code: setup.shell.code, title: setup.shell.title },
      source,
      plan,
      shift: shiftOptionsOf(plan),
    };
    const remote = await readObserve(setup.school, content);
    if (!remote.ok) return remote.error;
    const changes = latestChanges();
    const current = setupOf(setup.course);
    if (!current) return null;
    const at = nowIso();
    const id = host.newChangeId();
    const record = newChangeRecord({
      id,
      school: setup.school,
      course: setup.course,
      subject: `Copy into ${setup.shell.code}`,
      content,
      basis: { readAt: at, remote: remote.value },
      at,
      by: "you",
    });
    host.saveChanges(
      { ...changes, [id]: record },
      { setups: { ...get().setups, [setup.course]: { ...current, plan, draft: null, copy: id } } },
    );
    get().focusChange(setup.thread, id);
    return null;
  };

  const discard = (id: ChangeId): boolean =>
    ledger.commit(id, { type: "discard", at: nowIso() }).ok;

  const confirmDates = async (course: CourseRef, plan: TermPlan): Promise<string | null> => {
    const setup = setupOf(course);
    if (!setup?.source) return "Choose what to copy first.";
    const problem = planProblems(plan)[0];
    if (problem) return problem;
    const copy = copyOf(setup);
    if (copy && summarize(copy).canEdit) {
      patchSetup(course, { plan, draft: null });
      get().focusChange(setup.thread, copy.id);
      const edit: UserEvent = {
        type: "edit",
        by: "you",
        patch: { kind: "course-copy", plan, shift: shiftOptionsOf(plan) },
        at: nowIso(),
      };
      const edited = get().dispatchUser(copy.id, edit);
      return edited.ok ? null : "This copy can't be changed right now.";
    }
    if (copy?.state.tag === "sent" && !failedJob(course))
      return "The copy has already gone to the LMS, so its dates are fixed.";
    if (
      copy &&
      copy.state.tag !== "sent" &&
      copy.state.tag !== "discarded" &&
      (!canDropFix(copy) || !discard(copy.id))
    )
      return "This copy can't be changed right now.";
    return draftCopy(setup, setup.source, plan);
  };

  const retryCopy = async (course: CourseRef): Promise<string | null> => {
    const setup = setupOf(course);
    const content = setup ? copyContentOf(copyOf(setup)) : null;
    if (!setup || !content) return "There is no copy to try again.";
    // A stalled job may still run, so the screen offering this says copying again could add the content twice.
    const state = get().setupLive[course]?.migration?.state;
    if (state !== "failed" && state !== "stalled") return "The copy hasn't failed.";
    const refused = await draftCopy(setup, content.source, content.plan);
    if (!refused) patchLive(course, { migration: null, scan: null });
    return refused;
  };

  // ---- Scanning. A scan and its reconcile commit together, so a reload finds both or neither. ----

  const readScanInputs = async (
    setup: CourseSetup,
    copy: ChangeRecord,
  ): Promise<Result<{ content: CourseContent; issues: Migration["issues"] }, string>> => {
    const term = termOf(setup.school);
    const copyContent = copyContentOf(copy);
    if (!term || !copyContent) return { ok: false, error: "That school isn't connected." };
    const jobs = await laneRead(setup.school, () => term.migrations(setup.course));
    if (!jobs.ok) return { ok: false, error: noteFailure(setup.school, jobs.error) };
    const content = await laneRead(setup.school, () => term.courseContent(setup.course));
    if (!content.ok) return { ok: false, error: noteFailure(setup.school, content.error) };
    lastContent.set(setup.course, content.value);
    return {
      ok: true,
      value: {
        content: content.value,
        issues: copyMigration(copy, copySignature(copyContent), jobs.value)?.issues ?? [],
      },
    };
  };

  const commitScan = (
    course: string,
    copy: ChangeRecord,
    content: CourseContent,
    issues: Migration["issues"],
    at: IsoTime,
  ) => {
    const changes: Record<ChangeId, ChangeRecord> = { ...latestChanges() };
    const setup = setupOf(course);
    if (!setup?.plan) return null;
    const written = Object.values(setup.fixes).flatMap((id) => {
      const record = changes[id];
      return record?.state.tag === "sent" && record.content.kind === "text-fix"
        ? [record.content]
        : [];
    });
    const rules = scanCourse(content, {
      plan: setup.plan,
      issues,
      written,
      contactEmail: content.policy.contactEmail ?? null,
    });
    const findings = setup.scan?.copy === copy.id ? keepWords(rules, setup.scan.findings) : rules;
    const planned = reconcile(setup, findings, changes);
    for (const id of planned.discard) {
      const record = changes[id];
      const next = record && transition(record, { type: "discard", at });
      if (next?.ok) changes[id] = next.value;
    }
    const fixes: Record<FindingKey, ChangeId> = { ...planned.fixes };
    for (const finding of planned.create) {
      const remote = finding.fix && fixBasis(finding.fix, content);
      if (!finding.fix || !remote) continue;
      const id = host.newChangeId();
      changes[id] = newChangeRecord({
        id,
        school: setup.school,
        course: setup.course,
        subject: (finding.where === finding.quote
          ? finding.where
          : `${finding.where}: ${quoteWords(finding.quote)}`
        ).slice(0, 90),
        content: finding.fix,
        basis: { readAt: at, remote },
        at,
        by: get().aiOn() ? "agent" : "you",
      });
      fixes[finding.key] = id;
    }
    const next: CourseSetup = {
      ...setup,
      fixes,
      scan: { copy: copy.id, at, version: content.version, findings },
    };
    const publish = next.publish ? changes[next.publish] : undefined;
    const reopened =
      publish && canDropFix(publish) && !readinessOf(reviewRows(next, changes)).ready
        ? transition(publish, { type: "discard", at })
        : null;
    if (reopened?.ok) changes[reopened.value.id] = reopened.value;
    host.saveChanges(changes, { setups: { ...get().setups, [setup.course]: next } });
    if (reopened?.ok && get().threads[setup.thread]?.focus === reopened.value.id)
      get().focusChange(setup.thread, null);
    return next;
  };

  /** Rules only. Runs after a send, and for every check, reading fresh each time. */
  const rescan = (course: string): Promise<Result<CourseSetup, string>> => {
    const run = async (): Promise<Result<CourseSetup, string>> => {
      const setup = setupOf(course);
      const copy = setup && copyOf(setup);
      if (!setup || !copy || copy.state.tag !== "sent")
        return { ok: false, error: "The course has not been copied yet." };
      const readAt = nowIso();
      const inputs = await readScanInputs(setup, copy);
      if (!inputs.ok) return inputs;
      const committed = commitScan(course, copy, inputs.value.content, inputs.value.issues, readAt);
      return committed
        ? { ok: true, value: committed }
        : { ok: false, error: "The course has not been copied yet." };
    };
    const started = (scanTails.get(course) ?? Promise.resolve()).then(run, run);
    scanTails.set(course, started);
    return started;
  };

  const firstScan = async (course: string, job: Migration) => {
    const before = setupOf(course);
    const copy = before && copyOf(before);
    if (!before || !copy) return;
    const suffix = attemptSuffix(before);
    for (const [index, area] of SCAN_AREAS.entries()) {
      patchLive(course, {
        migration: job,
        scan: {
          label: `Scanning ${area}`,
          completion: Math.round((index / SCAN_AREAS.length) * 100),
          message: null,
        },
      });
      postOnce(before.thread, `Scanning ${area}${suffix}`);
      await host.sleep(SCAN_STEP_MS);
    }
    const scanned = await rescan(course);
    if (!scanned.ok) {
      patchLive(course, {
        scan: { label: "The scan couldn't finish", completion: null, message: scanned.error },
      });
      return;
    }
    patchLive(course, { scan: null });
    const content = lastContent.get(course);
    const plan = scanned.value.plan;
    if (content && plan && scanned.value.scan)
      await host.runAgent(before.thread, SCAN_COURSE_REQUEST, {
        content,
        findings: scanned.value.scan.findings,
        plan,
      });
  };

  const driveWatch = async (course: string) => {
    let misses = 0;
    const missed = async (message: string): Promise<boolean> => {
      misses += 1;
      if (misses >= MAX_MISSES) {
        patchLive(course, { scan: { label: "Couldn't read the copy", completion: null, message } });
        return true;
      }
      await host.sleep(POLL_MS);
      return false;
    };
    for (;;) {
      const setup = setupOf(course);
      const copy = setup && copyOf(setup);
      const content = copyContentOf(copy);
      if (!setup || !copy || !content || copy.state.tag !== "sent" || setup.scan?.copy === copy.id)
        return;
      const term = termOf(setup.school);
      if (!term || get().connections[setup.school]?.status !== "connected") return;
      const jobs = await laneRead(setup.school, () => term.migrations(setup.course));
      if (!jobs.ok) {
        if (jobs.error.kind === "auth_expired") return void host.markExpired(setup.school);
        if (await missed(errorWords(jobs.error))) return;
        continue;
      }
      const job = copyMigration(copy, copySignature(content), jobs.value);
      if (!job) {
        if (await missed("The LMS isn't showing this copy.")) return;
        continue;
      }
      misses = 0;
      patchLive(course, { migration: job, scan: null });
      const suffix = attemptSuffix(setup);
      for (const line of copyMarksOf(job)) postOnce(setup.thread, `${line}${suffix}`);
      if (job.state === "failed") return;
      if (job.state === "completed") return firstScan(course, job);
      await host.sleep(POLL_MS);
    }
  };

  /** Two tabs run one watcher. The other waits on the lock, so it takes over if this tab closes, and has nothing to do otherwise. */
  const watch = (course: string): Promise<void> =>
    once(`setup-watch:${course}`, async () => {
      if (!host.locks) return driveWatch(course);
      await host.locks.request(`setup-watch:${course}`, async () => {
        latestChanges();
        await driveWatch(course);
      });
    });

  // ---- A person settling a finding. ----

  const resolve = (
    course: CourseRef,
    key: FindingKey,
    how: Resolution["how"],
    reason: string | null,
  ): string | null => {
    const setup = setupOf(course);
    if (!setup) return null;
    const id = setup.fixes[key];
    const record = id ? get().changes[id] : undefined;
    if (record && record.state.tag !== "sent" && record.state.tag !== "discarded") {
      if (!canDropFix(record) || !discard(record.id))
        return "This fix is being sent, or may still land, so it has to settle first.";
      if (get().threads[setup.thread]?.focus === record.id) get().focusChange(setup.thread, null);
    }
    patchSetup(course, {
      resolved: { ...setup.resolved, [key]: { at: nowIso(), how, reason: reason?.trim() || null } },
    });
    return null;
  };

  const actions: SetupActions = {
    startSetup: (course) => {
      const existing = setupOf(course);
      if (existing) return existing.thread;
      const shell = Object.values(get().newCourses)
        .flat()
        .find((entry) => entry.ref === course);
      if (!shell) throw new Error("That course isn't offered for setup.");
      const thread = get().createThread({
        school: shell.school,
        course,
        title: `Set up ${shell.code}`,
        kind: "setup",
      });
      const setup: CourseSetup = {
        course,
        school: shell.school,
        thread,
        shell,
        source: null,
        plan: null,
        copy: null,
        publish: null,
        scan: null,
        check: null,
        resolved: {},
        fixes: {},
      };
      set({ setups: { ...get().setups, [course]: setup } });
      return thread;
    },

    cancelSetup: (course) => {
      const setup = setupOf(course);
      const thread = setup && get().threads[setup.thread];
      if (!setup || !thread) return { ok: false, error: "This course has no setup to cancel." };
      const copy = copyOf(setup);
      if (copy?.state.tag === "sent")
        return {
          ok: false,
          error: "The copy has already gone to the LMS, so this setup can't be cancelled.",
        };
      const dropped =
        canCancelSetup(setup, get().changes) &&
        (!copy || copy.state.tag === "discarded" || discard(copy.id));
      if (!dropped)
        return {
          ok: false,
          error: "This copy is being sent, or may still land, so it has to settle first.",
        };
      const { [course]: _setup, ...setups } = get().setups;
      const { [course]: _live, ...setupLive } = get().setupLive;
      const { [setup.thread]: _thread, ...threads } = get().threads;
      set({ setups, setupLive, threads });
      const live = copy && copy.state.tag !== "discarded" ? copy : null;
      return { ok: true, value: { setup, thread, copy: live } };
    },

    restoreSetup: ({ setup, thread, copy: old }) => {
      if (setupOf(setup.course))
        return "This course has a setup again, so the cancelled one can't come back.";
      if (!old) {
        set({
          setups: { ...get().setups, [setup.course]: setup },
          threads: { ...get().threads, [thread.id]: thread },
        });
        return null;
      }
      const copy = newChangeRecord({
        id: host.newChangeId(),
        school: old.school,
        course: old.course,
        subject: old.subject,
        content: old.content,
        basis: old.basis,
        at: nowIso(),
        by: "you",
      });
      host.saveChanges(
        { ...latestChanges(), [copy.id]: copy },
        {
          setups: { ...get().setups, [setup.course]: { ...setup, copy: copy.id } },
          threads: {
            ...get().threads,
            [thread.id]: { ...thread, focus: thread.focus === old.id ? copy.id : thread.focus },
          },
        },
      );
      return null;
    },

    loadSetupOptions: async (school) => {
      const term = termOf(school);
      if (!term) return;
      const [sources, samples] = await Promise.all([
        laneRead(school, () => term.copySources()),
        laneRead(school, () => term.samplePackages()),
      ]);
      if (sources.ok && samples.ok)
        set({
          setupOptions: {
            ...get().setupOptions,
            [school]: { sources: sources.value, samples: samples.value },
          },
        });
    },

    chooseSource: (course, source) => {
      const setup = setupOf(course);
      if (!setup) return null;
      const copy = copyOf(setup);
      if (copy?.state.tag === "sent" && !failedJob(course))
        return "The copy has already gone to the LMS, so its source is fixed.";
      if (copy && copy.state.tag !== "sent" && copy.state.tag !== "discarded") {
        if (!canDropFix(copy) || !discard(copy.id))
          return "This copy is being sent, or may still land, so it has to settle first.";
      }
      if (get().threads[setup.thread]?.focus === setup.copy) get().focusChange(setup.thread, null);
      patchLive(course, { migration: null, scan: null });
      patchSetup(course, { source, plan: null, draft: null, copy: null });
      return null;
    },

    chooseCartridgeFile: (course, file) => {
      const name = file.name.toLowerCase();
      if (name.endsWith(".csv")) return REFUSED_CSV;
      if (!name.endsWith(".imscc")) return REFUSED_OTHER;
      const school = setupOf(course)?.school;
      const known = school
        ? get().setupOptions[school]?.samples.find((sample) => sample.name === file.name)
        : undefined;
      return actions.chooseSource(course, {
        kind: "cartridge",
        name: file.name,
        kb: Math.ceil(file.size / 1024),
        hint: known?.hint ?? file.hint ?? null,
      });
    },

    picksPackage: (school) => termOf(school)?.pickPackage !== undefined,

    pickCartridge: async (course) => {
      const school = setupOf(course)?.school;
      const term = school && termOf(school);
      if (!term?.pickPackage) return null;
      const picked = await term.pickPackage();
      if (!picked.ok) return errorWords(picked.error);
      return picked.value
        ? actions.chooseCartridgeFile(course, {
            name: picked.value.name,
            size: picked.value.kb * 1024,
            hint: picked.value.hint,
          })
        : null;
    },

    editDates: (course, plan) => patchSetup(course, { draft: plan }),

    confirmDates: (course, plan) => once(`setup-dates:${course}`, () => confirmDates(course, plan)),
    retryCopy: (course) => once(`setup-retry:${course}`, () => retryCopy(course)),

    scanNow: async (course) => {
      const setup = setupOf(course);
      const copy = setup && copyOf(setup);
      if (!setup || !copy || copy.state.tag !== "sent")
        return "The course has not been copied yet.";
      if (setup.scan?.copy !== copy.id) {
        patchLive(course, { scan: null });
        await watch(course);
        return null;
      }
      for (const id of Object.values(setup.fixes)) {
        const record = get().changes[id];
        if (record && summarize(record).recovery === "rescan") discard(id);
      }
      const scanned = await rescan(course);
      return scanned.ok ? null : scanned.error;
    },

    dismissFinding: (course, key, reason) => resolve(course, key, "dismissed", reason),
    markHandled: (course, key) => resolve(course, key, "handled", null),

    restoreFinding: async (course, key) => {
      const setup = setupOf(course);
      if (!setup) return null;
      const { [key]: _dropped, ...resolved } = setup.resolved;
      patchSetup(course, { resolved });
      const scanned = await rescan(course);
      return scanned.ok ? null : scanned.error;
    },

    runPublishCheck: async (course) => {
      const scanned = await rescan(course);
      if (!scanned.ok) return scanned.error;
      patchSetup(course, { check: { at: nowIso(), version: scanned.value.scan?.version ?? "" } });
      return null;
    },

    proposePublish: (course) =>
      once(`setup-publish:${course}`, async () => {
        const scanned = await rescan(course);
        if (!scanned.ok) return scanned;
        const setup = setupOf(course);
        if (!setup?.scan) return { ok: false, error: "The course has not been scanned yet." };
        if (!readinessOf(reviewRows(setup, get().changes)).ready)
          return {
            ok: false,
            error:
              "Something still needs attention. Run the publish check and work through what it names.",
          };
        if (setup.check?.version !== setup.scan.version)
          return {
            ok: false,
            error: "The course changed after the publish check. Run the check again.",
          };
        const open = setup.publish ? get().changes[setup.publish] : undefined;
        if (open && open.state.tag !== "discarded") return { ok: true, value: open.id };
        const content: SetContent = {
          kind: "item-set",
          target: setup.shell.stateTarget,
          where: setup.shell.code,
          intent: { set: "course-published" },
        };
        const remote = await readObserve(setup.school, content);
        if (!remote.ok) return remote;
        const changes = latestChanges();
        const current = setupOf(course);
        if (!current) return { ok: false, error: "This setup is gone." };
        const at = nowIso();
        const id = host.newChangeId();
        const record = newChangeRecord({
          id,
          school: setup.school,
          course,
          subject: `Publish ${setup.shell.code}`,
          content,
          basis: { readAt: at, remote: remote.value },
          at,
          by: "you",
        });
        host.saveChanges(
          { ...changes, [id]: record },
          { setups: { ...get().setups, [course]: { ...current, publish: id } } },
        );
        get().focusChange(setup.thread, id);
        return { ok: true, value: id };
      }),

    proposeTemplate: (course) =>
      once(`setup-template:${course}`, async () => {
        const known = templateChangeOf(get().changes, course);
        const threadFor = (code: string, school: SchoolId): ThreadId => {
          const existing =
            setupOf(course)?.thread ??
            Object.values(get().threads).find(
              (thread) => thread.kind === "setup" && thread.course === course,
            )?.id;
          return (
            existing ??
            get().createThread({
              school,
              course,
              title: `Save ${code} as a template`,
              kind: "setup",
            })
          );
        };
        const school =
          known?.school ??
          Object.values(get().cache)
            .flatMap((cache) => cache.courses)
            .find((entry) => entry.ref === course)?.school ??
          setupOf(course)?.school;
        const term = school && termOf(school);
        if (!school || !term) return { ok: false, error: "That school isn't connected." };
        const read = await laneRead(school, () => term.courseContent(course));
        if (!read.ok)
          return {
            ok: false,
            error: `Couldn't read this course. ${noteFailure(school, read.error)}`,
          };
        const { shell } = read.value;
        if (known)
          return { ok: true, value: { thread: threadFor(shell.code, school), change: known.id } };
        const content: SetContent = {
          kind: "item-set",
          target: shell.stateTarget,
          where: shell.code,
          intent: { set: "course-template" },
        };
        const remote = await readObserve(school, content);
        if (!remote.ok) return remote;
        if (remote.value.kind === "item-set" && remote.value.value === fieldText(content, "value"))
          return { ok: false, error: `${shell.code} is already a template.` };
        const at = nowIso();
        const id = host.newChangeId();
        const record = newChangeRecord({
          id,
          school,
          course,
          subject: `Save ${shell.code} as a template`,
          content,
          basis: { readAt: at, remote: remote.value },
          at,
          by: "you",
        });
        host.saveChanges({ ...latestChanges(), [id]: record });
        const thread = threadFor(shell.code, school);
        get().focusChange(thread, id);
        return { ok: true, value: { thread, change: id } };
      }),

    resumeSetups: () => {
      for (const setup of Object.values(get().setups)) {
        const copy = copyOf(setup);
        if (copy?.state.tag === "sent" && setup.scan?.copy !== copy.id) void watch(setup.course);
      }
    },
  };

  return {
    actions,

    /** Last in a sync, and its failure is its own: the sync already succeeded. */
    readNewCourses: async (school: SchoolId, gone: () => boolean) => {
      const term = termOf(school);
      if (!term) return;
      const shells = await laneRead(school, () => term.newCourses());
      if (shells.ok && !gone())
        set({ newCourses: { ...get().newCourses, [school]: shells.value } });
    },

    /** A reload can land between a send and its rescan, which leaves a sent fix waiting on a scan nothing started. */
    rescanUnsettled: () => {
      for (const setup of Object.values(get().setups)) {
        if (reviewRows(setup, get().changes).some((row) => row.status === "checking"))
          void rescan(setup.course);
      }
    },

    /** A copy that landed starts its watcher. Anything else that touched a set-up course rescans it, on rules alone. */
    afterSend: async (ids: readonly ChangeId[]) => {
      const rescans = new Set<string>();
      for (const id of ids) {
        const record = get().changes[id];
        const setup = record && setupOf(record.course);
        if (!record || !setup || record.state.tag === "approved" || record.state.tag === "draft")
          continue;
        if (id === setup.copy) {
          if (record.state.tag === "sent") void watch(setup.course);
        } else if (id !== setup.publish && setup.scan?.copy === setup.copy) {
          rescans.add(setup.course);
        }
      }
      await Promise.all([...rescans].map((course) => rescan(course)));
    },

    /** Rewords a rule's finding and, if the person has not touched its fix, the fix. Never creates a change. */
    applyFinding: (thread: ThreadId, effect: Extract<AgentEffect, { type: "finding" }>) => {
      const setup = Object.values(get().setups).find((entry) => entry.thread === thread);
      if (!setup?.scan) return;
      const reworded = rewordFinding(setup.scan.findings, effect);
      if (!reworded) return;
      const { was, now } = reworded;
      patchSetup(setup.course, {
        scan: {
          ...setup.scan,
          findings: setup.scan.findings.map((finding) => (finding === was ? now : finding)),
        },
      });
      const id = setup.fixes[was.key];
      const record = id ? get().changes[id] : undefined;
      if (
        !record ||
        record.state.tag !== "draft" ||
        record.content.kind !== "text-fix" ||
        was.fix?.kind !== "text-fix" ||
        effect.after === null
      )
        return;
      if (
        record.content.splice.after !== was.fix.splice.after ||
        effect.after === record.content.splice.after
      )
        return;
      ledger.commit(record.id, {
        type: "edit",
        by: "agent",
        patch: { kind: "text-fix", after: effect.after },
        at: nowIso(),
      });
    },

    /** Null outside a scanned setup thread. */
    scanScope: async (thread: ThreadId): Promise<ScanScope | null> => {
      const setup = Object.values(get().setups).find((entry) => entry.thread === thread);
      if (!setup?.scan || !setup.plan) return null;
      const known = lastContent.get(setup.course);
      if (known) return { content: known, findings: setup.scan.findings, plan: setup.plan };
      const term = termOf(setup.school);
      const read = term && (await laneRead(setup.school, () => term.courseContent(setup.course)));
      if (!read?.ok) return null;
      lastContent.set(setup.course, read.value);
      return { content: read.value, findings: setup.scan.findings, plan: setup.plan };
    },
  };
};
