import {
  mayStillLand,
  summarize,
  type ChangeRecord,
  type ChangeSummary,
  type RemoteState,
  type Seen,
} from "./change";
import type {
  CopySource,
  CourseContent,
  CourseShell,
  Migration,
  SetContent,
  TextFixContent,
} from "./content";
import type { ChangeId, IsoTime, LmsRef, SchoolId, ThreadId } from "./ids";
import type { Finding, FindingKey, FindingType } from "./scan";
import type { PlanDraft, TermPlan } from "./term";

export type ChangeMap = Readonly<Record<ChangeId, ChangeRecord>>;

export interface Resolution {
  at: IsoTime;
  how: "dismissed" | "handled";
  reason: string | null;
}

export interface CourseSetup {
  course: LmsRef<"course">;
  school: SchoolId;
  thread: ThreadId;
  shell: CourseShell;
  source: CopySource | null;
  plan: TermPlan | null;
  /** The Dates form as last typed, so a reload keeps it. Cleared when the plan is confirmed or the source changes. Absent from setups saved before it existed. */
  draft?: PlanDraft | null;
  copy: ChangeId | null;
  publish: ChangeId | null;
  scan: { copy: ChangeId; at: IsoTime; version: string; findings: readonly Finding[] } | null;
  check: { at: IsoTime; version: string } | null;
  resolved: Readonly<Record<FindingKey, Resolution>>;
  fixes: Readonly<Record<FindingKey, ChangeId>>;
}

export interface JobView {
  label: string;
  /** Null until a read has said how far along the job is. */
  completion: number | null;
  message: string | null;
}

/** Live and unpersisted. A reload loses it, and the next read of the job restores it. */
export interface SetupLive {
  migration: Migration | null;
  scan: JobView | null;
}

export type SetupStage =
  | { tag: "source" }
  | { tag: "dates" }
  /** `stale` while the Dates form holds other dates than the copy was drafted from, so the copy on screen is not what the form says. */
  | { tag: "approve-copy"; copy: ChangeId; stale: boolean }
  | { tag: "copying"; job: JobView }
  | { tag: "copy-failed"; migration: Migration }
  | { tag: "scanning"; job: JobView }
  | { tag: "review" }
  | { tag: "publish-check"; publish: ChangeId | null }
  | { tag: "published" };

export const STEPS = [
  "Detect",
  "Source",
  "Dates",
  "Scan",
  "Review",
  "Publish check",
  "End of term",
] as const;

const STAGE_STEP: Readonly<Record<SetupStage["tag"], number>> = {
  source: 2,
  dates: 3,
  "approve-copy": 3,
  copying: 4,
  "copy-failed": 4,
  scanning: 4,
  review: 5,
  "publish-check": 6,
  published: 7,
};
/** One-based, as the rail numbers its steps. Detect is never current, because a setup exists only after the offer was taken. */
export const stepOf = (stage: SetupStage): number => STAGE_STEP[stage.tag];

const STAGE_WORDS: Readonly<Record<SetupStage["tag"], string>> = {
  source: "Choosing a source",
  dates: "Confirming dates",
  "approve-copy": "Copy waiting on you",
  copying: "Copying",
  "copy-failed": "Copy failed",
  scanning: "Scanning",
  review: "Reviewing findings",
  "publish-check": "Publish check",
  published: "Published",
};

export const stageWords = (stage: SetupStage): string => STAGE_WORDS[stage.tag];

const MIGRATION_LABEL: Readonly<Record<Migration["state"], string>> = {
  queued: "Waiting to start",
  preparing: "Reading the package",
  stalled: "Still waiting on the LMS",
  running: "Copying the course",
  completed: "Copied",
  failed: "The copy failed",
};
const jobOfMigration = ({ state, completion, message }: Migration): JobView => ({
  label: MIGRATION_LABEL[state],
  completion,
  message,
});
const CHECKING_COPY: JobView = { label: "Checking on the copy", completion: null, message: null };
const SCANNING: JobView = { label: "Scanning the course", completion: null, message: null };

/**
 * `seen` lists the jobs present when the first send started, so a retry with the same words cannot pick up the job that failed.
 * Before any send, no job can be this change's. `signature` is the copy field's text.
 */
export const copyMigration = (
  record: { seen: Seen | null },
  signature: string,
  migrations: readonly Migration[],
): Migration | null => {
  const { seen } = record;
  if (seen === null) return null;
  const known = new Set(seen["copy"] ?? []);
  return migrations.findLast((job) => job.signature === signature && !known.has(job.ref)) ?? null;
};

export const stageOf = (
  setup: CourseSetup,
  changes: ChangeMap,
  live: SetupLive | undefined,
): SetupStage => {
  const publish = setup.publish ? changes[setup.publish] : undefined;
  if (publish?.state.tag === "sent") return { tag: "published" };
  if (!setup.source) return { tag: "source" };
  const copy = setup.copy ? changes[setup.copy] : undefined;
  if (!setup.plan || !copy || copy.state.tag === "discarded") return { tag: "dates" };
  if (copy.state.tag !== "sent")
    return {
      tag: "approve-copy",
      copy: copy.id,
      stale: Boolean(setup.draft) && JSON.stringify(setup.draft) !== JSON.stringify(setup.plan),
    };
  if (setup.scan?.copy !== copy.id) {
    const migration = live?.migration ?? null;
    if (migration?.state === "failed") return { tag: "copy-failed", migration };
    if (migration?.state === "completed") return { tag: "scanning", job: live?.scan ?? SCANNING };
    return { tag: "copying", job: migration ? jobOfMigration(migration) : CHECKING_COPY };
  }
  if (!setup.check || !readinessOf(reviewRows(setup, changes)).ready) return { tag: "review" };
  return {
    tag: "publish-check",
    publish: publish && publish.state.tag !== "discarded" ? publish.id : null,
  };
};

/** A sending change is landing, and a held one in doubt may still land, so neither is discarded from here. */
export const canDropFix = ({ state }: ChangeRecord): boolean => {
  switch (state.tag) {
    case "draft":
    case "approved":
    case "conflicted":
      return true;
    case "held":
      return !mayStillLand(state.run);
    case "sending":
    case "sent":
    case "discarded":
      return false;
  }
};

/** Until the copy may have reached the LMS, nothing there depends on this setup, so dropping it leaves the shell as it was. */
export const canCancelSetup = (setup: CourseSetup, changes: ChangeMap): boolean => {
  const copy = setup.copy ? changes[setup.copy] : undefined;
  return !copy || copy.state.tag === "discarded" || canDropFix(copy);
};

const keysOf = (fixes: CourseSetup["fixes"]): readonly FindingKey[] =>
  Object.keys(fixes) as FindingKey[];

/**
 * Idempotent. A live or sent change keeps its link, so a rerun creates nothing twice and never overwrites an edited fix.
 * A sent fix whose key is found again wrote one of two twins, and the other now has its key. The sent fix moves to a key
 * no finding can have, where it stays the record of what was written, and the passage gets a new draft.
 */
export const reconcile = (
  setup: CourseSetup,
  findings: readonly Finding[],
  changes: ChangeMap,
): { create: readonly Finding[]; discard: readonly ChangeId[]; fixes: CourseSetup["fixes"] } => {
  const found = new Map(findings.map((finding) => [finding.key, finding]));
  const discard: ChangeId[] = [];
  const fixes: Record<FindingKey, ChangeId> = {};
  for (const key of keysOf(setup.fixes)) {
    const id = setup.fixes[key];
    const record = id ? changes[id] : undefined;
    if (!record || record.state.tag === "discarded") continue;
    if (record.state.tag === "sent" && found.get(key)?.fix && !setup.resolved[key])
      fixes[`${key}:${record.id}` as FindingKey] = record.id;
    else if ((!found.has(key) || setup.resolved[key]) && canDropFix(record))
      discard.push(record.id);
    else fixes[key] = record.id;
  }
  return {
    create: findings.filter(
      (finding) => finding.fix !== null && !setup.resolved[finding.key] && !fixes[finding.key],
    ),
    discard,
    fixes,
  };
};

/** `manual` is a person's to do in the LMS. `fix` has a change, or will after the next reconcile. `checking` was sent after the last scan read the course, so that scan can't speak for it. `still-here` was sent, and a later scan still finds it. */
type RowStatus = "manual" | "fix" | "checking" | "still-here" | "fixed" | "dismissed" | "handled";

export interface ReviewRow {
  key: FindingKey;
  /** Null for a fix whose finding the last scan no longer finds. Its change's subject names it. */
  finding: Finding | null;
  status: RowStatus;
  change: ChangeRecord | null;
  summary: ChangeSummary | null;
  resolution: Resolution | null;
}

const row = (
  key: FindingKey,
  finding: Finding | null,
  status: RowStatus,
  change: ChangeRecord | null,
  resolution: Resolution | null,
): ReviewRow => ({
  key,
  finding,
  status,
  change,
  summary: change && summarize(change),
  resolution,
});

const liveChange = (
  setup: CourseSetup,
  key: FindingKey,
  changes: ChangeMap,
): ChangeRecord | null => {
  const id = setup.fixes[key];
  const record = id ? changes[id] : undefined;
  return record && record.state.tag !== "discarded" ? record : null;
};

const rowOfFinding = (setup: CourseSetup, finding: Finding, changes: ChangeMap): ReviewRow => {
  const change = liveChange(setup, finding.key, changes);
  const resolution = setup.resolved[finding.key] ?? null;
  if (resolution) return row(finding.key, finding, resolution.how, change, resolution);
  if (change?.state.tag === "sent")
    return row(
      finding.key,
      finding,
      setup.scan && change.state.at > setup.scan.at ? "checking" : "still-here",
      change,
      null,
    );
  return row(
    finding.key,
    finding,
    finding.fix === null && !change ? "manual" : "fix",
    change,
    null,
  );
};

export const reviewRows = (setup: CourseSetup, changes: ChangeMap): readonly ReviewRow[] => {
  const findings = setup.scan?.findings ?? [];
  const found = new Set(findings.map((finding) => finding.key));
  const gone = keysOf(setup.fixes).flatMap((key) => {
    const change = found.has(key) ? null : liveChange(setup, key, changes);
    return change
      ? [row(key, null, change.state.tag === "sent" ? "fixed" : "fix", change, null)]
      : [];
  });
  return [...findings.map((finding) => rowOfFinding(setup, finding, changes)), ...gone];
};

export const isOpenRow = ({ status }: ReviewRow): boolean => {
  switch (status) {
    case "manual":
    case "fix":
    case "checking":
    case "still-here":
      return true;
    case "fixed":
    case "dismissed":
    case "handled":
      return false;
  }
};

export type ReadinessGroup = "dates" | "empty-modules" | "unpublished" | "findings";

const READINESS_GROUP: Readonly<Record<FindingType, ReadinessGroup>> = {
  "plain-date": "dates",
  "date-in-break": "dates",
  "date-outside-term": "dates",
  "old-term-name": "findings",
  "old-course-link": "findings",
  "broken-link": "findings",
  "missing-file": "findings",
  "lti-link": "findings",
  "copied-announcement": "findings",
  "foreign-contact": "findings",
  "missing-statement": "findings",
  "unpublished-item": "unpublished",
  "empty-module": "empty-modules",
  "migration-issue": "findings",
};

export const readinessGroupOf = ({ finding }: ReviewRow): ReadinessGroup =>
  finding ? READINESS_GROUP[finding.type] : "findings";

/** Not a second engine: every group is a count of open rows from the ordinary rules. */
export const readinessOf = (
  rows: readonly ReviewRow[],
): { ready: boolean; groups: Readonly<Record<ReadinessGroup, number>> } => {
  const groups: Record<ReadinessGroup, number> = {
    dates: 0,
    "empty-modules": 0,
    unpublished: 0,
    findings: 0,
  };
  for (const open of rows.filter(isOpenRow)) groups[readinessGroupOf(open)]++;
  return { ready: Object.values(groups).every((count) => count === 0), groups };
};

/**
 * What a fix's target reads as, taken from the scan's own read so a scan makes no extra requests. Null when the item is gone.
 * `present` is the reading every provider gives a live item. A text fix never consults its version, so the course's will do.
 */
export const fixBasis = (
  fix: TextFixContent | SetContent,
  content: CourseContent,
): RemoteState | null => {
  const item = content.items.find((entry) => entry.ref === fix.target);
  if (!item) return null;
  if (fix.kind === "text-fix")
    return { kind: "text-fix", targetVersion: content.version, body: item.body };
  const value =
    fix.intent.set === "due-at"
      ? item.dueAt
      : fix.intent.set === "item-published"
        ? item.published
          ? "published"
          : "unpublished"
        : "present";
  return { kind: "item-set", targetVersion: "present", value };
};

const withAfter = (fix: Finding["fix"], after: string): Finding["fix"] =>
  fix?.kind === "text-fix" ? { ...fix, splice: { ...fix.splice, after } } : fix;
const afterOf = (finding: Finding): string | null =>
  finding.fix?.kind === "text-fix" ? finding.fix.splice.after : null;

/** A rules-only rescan keeps the agent's words. The key hashes the quote, so a key found again means the quote is still there. */
export const keepWords = (
  next: readonly Finding[],
  prior: readonly Finding[],
): readonly Finding[] => {
  const byKey = new Map(prior.map((finding) => [finding.key, finding]));
  return next.map((finding) => {
    const before = byKey.get(finding.key);
    if (!before) return finding;
    const after = afterOf(before);
    return {
      ...finding,
      why: before.why,
      fix: after === null ? finding.fix : withAfter(finding.fix, after),
    };
  });
};

export interface FindingWords {
  findingType: Finding["type"];
  item: Finding["item"];
  quote: string;
  why: string;
  after: string | null;
}

/** Null when the agent spoke of something the rules did not find. An agent's finding only rewords a rule's, so it can mint nothing. */
export const rewordFinding = (
  findings: readonly Finding[],
  words: FindingWords,
): { was: Finding; now: Finding } | null => {
  const candidates = findings.filter(
    (finding) => finding.type === words.findingType && finding.item === words.item,
  );
  const was =
    candidates.find((finding) => finding.quote === words.quote) ??
    candidates.find((finding) => words.after !== null && afterOf(finding) === words.after) ??
    candidates[0];
  if (!was) return null;
  return {
    was,
    now: {
      ...was,
      why: words.why,
      fix: words.after === null ? was.fix : withAfter(was.fix, words.after),
    },
  };
};

export const templateChangeOf = (
  changes: ChangeMap,
  course: LmsRef<"course">,
): ChangeRecord | null =>
  Object.values(changes).findLast(
    (record) =>
      record.course === course &&
      record.state.tag !== "discarded" &&
      record.content.kind === "item-set" &&
      record.content.intent.set === "course-template",
  ) ?? null;

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const shellContents = ({
  studentCount,
  itemCount,
}: Pick<CourseShell, "studentCount" | "itemCount">): string =>
  studentCount === 0 && itemCount === 0
    ? "Empty"
    : `${count(studentCount, "student")}, ${count(itemCount, "item")}`;

export const offerWords = ({
  studentCount,
  itemCount,
}: Pick<CourseShell, "studentCount" | "itemCount">): string =>
  studentCount === 0 && itemCount === 0
    ? "New and empty"
    : `New, already has ${count(studentCount, "student")} and ${count(itemCount, "item")}`;
