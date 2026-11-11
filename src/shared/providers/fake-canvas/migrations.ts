import type { Migration, MigrationIssue } from "~/shared/domain/content";
import { isoTime, type IsoTime, type SchoolId } from "~/shared/domain/ids";
import { dateOfTime, shiftDate, timeOnDate, type DateShiftOptions } from "~/shared/domain/term";

import { refs } from "./refs";
import type { PackageIssueSeed, RawBody } from "./seed-term";

type MigrationType = "course_copy_importer" | "common_cartridge_importer";
type MigrationWorkflow = "pre_processing" | "running" | "completed" | "failed";

export interface MigrationIssueRecord {
  id: number;
  issue_type: "todo" | "warning" | "error";
  description: string;
  workflow_state: "active" | "resolved";
  fix_issue_html_url: string | null;
}

export interface MigrationRecord {
  id: number;
  school: SchoolId;
  course_id: number;
  migration_type: MigrationType;
  workflow_state: MigrationWorkflow;
  started_at: IsoTime;
  finished_at: IsoTime | null;
  settings: { source_course_id?: number; file?: string };
  date_shift_options: {
    shift_dates: true;
    old_start_date: string;
    old_end_date: string;
    new_start_date: string;
    new_end_date: string;
    day_substitutions: Record<string, number>;
  };
  /** Equals the change's copy field text. How a change finds its own job after a lost response. */
  signature: string;
  progress: {
    completion: number;
    message: string | null;
    workflow_state: "queued" | "running" | "completed" | "failed";
  };
  migration_issues: MigrationIssueRecord[];
  /** Content lands exactly once, on the read that first sees completion. */
  applied: boolean;
  failAt: { completion: number; message: string } | null;
}

export interface NewMigrationArgs {
  id: number;
  school: SchoolId;
  course_id: number;
  type: MigrationType;
  settings: MigrationRecord["settings"];
  shift: DateShiftOptions;
  signature: string;
  issues: readonly PackageIssueSeed[];
  now: IsoTime;
  failAt: MigrationRecord["failAt"];
}

export const newMigrationRecord = (args: NewMigrationArgs): MigrationRecord => ({
  id: args.id,
  school: args.school,
  course_id: args.course_id,
  migration_type: args.type,
  workflow_state: args.type === "common_cartridge_importer" ? "pre_processing" : "running",
  started_at: args.now,
  finished_at: null,
  settings: args.settings,
  date_shift_options: {
    shift_dates: true,
    old_start_date: args.shift.oldStart,
    old_end_date: args.shift.oldEnd,
    new_start_date: args.shift.newStart,
    new_end_date: args.shift.newEnd,
    day_substitutions: Object.fromEntries(
      Object.entries(args.shift.substitutions).map(([day, to]) => [day, to as number]),
    ),
  },
  signature: args.signature,
  progress: { completion: 0, message: null, workflow_state: "queued" },
  migration_issues: args.issues.map((issue, index) => ({
    id: args.id * 10 + index + 1,
    issue_type: issue.issue_type,
    description: issue.description,
    workflow_state: "active",
    fix_issue_html_url: issue.fixUrl,
  })),
  applied: false,
  failAt: args.failAt,
});

const PREPROCESS_UNTIL = 10;

const messageAt = (completion: number, type: MigrationType): string | null => {
  if (completion === 0) return null;
  if (completion < PREPROCESS_UNTIL)
    return type === "common_cartridge_importer"
      ? "Processing the package"
      : "Copying course settings";
  if (completion < 40) return "Importing pages and assignments";
  if (completion < 70) return "Importing files and modules";
  if (completion < 100) return "Shifting dates";
  return "Done";
};

/** Pure and clock-driven. The same record read at the same time comes back the same, so a reload loses nothing. */
export const advanceMigration = (
  record: MigrationRecord,
  nowMs: number,
  durationMs: number,
): MigrationRecord => {
  if (record.workflow_state === "completed" || record.workflow_state === "failed") return record;
  const elapsed = nowMs - Date.parse(record.started_at);
  const completion = Math.max(0, Math.min(100, Math.floor((elapsed / durationMs) * 100)));
  if (record.failAt && completion >= record.failAt.completion) {
    return {
      ...record,
      workflow_state: "failed",
      finished_at: isoTime(nowMs),
      progress: {
        completion: record.failAt.completion,
        message: record.failAt.message,
        workflow_state: "failed",
      },
    };
  }
  if (completion >= 100)
    return {
      ...record,
      workflow_state: "completed",
      finished_at: isoTime(nowMs),
      progress: {
        completion: 100,
        message: messageAt(100, record.migration_type),
        workflow_state: "completed",
      },
    };
  const workflow_state: MigrationWorkflow =
    record.migration_type === "common_cartridge_importer" && completion < PREPROCESS_UNTIL
      ? "pre_processing"
      : "running";
  return {
    ...record,
    workflow_state,
    progress: {
      completion,
      message: messageAt(completion, record.migration_type),
      workflow_state: completion === 0 ? "queued" : "running",
    },
  };
};

const toIssue = (issue: MigrationIssueRecord): MigrationIssue => ({
  severity: issue.issue_type,
  text: issue.description,
  open: issue.workflow_state === "active",
  fixUrl: issue.fix_issue_html_url,
});

const stateOf = (record: MigrationRecord): Migration["state"] => {
  switch (record.workflow_state) {
    case "pre_processing":
      return "preparing";
    case "running":
      return record.progress.workflow_state === "queued" ? "queued" : "running";
    case "completed":
    case "failed":
      return record.workflow_state;
  }
};

export const toMigration = (record: MigrationRecord): Migration => ({
  ref: refs.migration(record.school, record.course_id, record.id),
  signature: record.signature,
  state: stateOf(record),
  completion: record.progress.completion,
  message: record.progress.message,
  issues: record.migration_issues.map(toIssue),
});

export interface CopyArgs {
  sourceCourseId: number;
  sourceHost: string;
  targetCourseId: number;
  targetHost: string;
  shift: DateShiftOptions;
  /** Hands out item ids, so two copies into one course never collide. */
  nextId(): number;
}

/** What Canvas leaves after a completed import. Links to another host stay as they were. */
export const copyBody = (source: RawBody, args: CopyArgs): RawBody => {
  const sameHost = args.sourceHost === args.targetHost;
  const from = `/courses/${args.sourceCourseId}/`;
  const to = `/courses/${args.targetCourseId}/`;
  const rewrite = (text: string): string => (sameHost ? text.split(from).join(to) : text);
  return {
    items: source.items.map((item) => ({
      ...item,
      id: args.nextId(),
      body: rewrite(item.body),
      links: item.links.map((link) => ({ ...link, url: rewrite(link.url) })),
      dueAt:
        item.dueAt === null
          ? null
          : timeOnDate(item.dueAt, shiftDate(dateOfTime(item.dueAt), args.shift)),
      copied: true,
      version: 1,
    })),
    modules: source.modules.map((module) => ({ ...module, id: args.nextId() })),
    tools: source.tools.map((tool) => ({ ...tool, configured: false })),
  };
};
