import { lateOf } from "~/shared/domain/blank";
import {
  isAgentContent,
  type AttachmentDraft,
  type ChangeContent,
  type ChangePatch,
  type ChangeRecord,
  type GradeContent,
  type RubricScore,
} from "~/shared/domain/change";
import type { CourseContent } from "~/shared/domain/content";
import type { ChangeId, IsoTime, LmsRef, Result, SchoolId } from "~/shared/domain/ids";
import {
  passagesOf,
  type Announcement,
  type Assignment,
  type Conversation,
  type Course,
  type School,
  type Submission,
} from "~/shared/domain/lms";
import { isFindingType, type Finding, type FindingType } from "~/shared/domain/scan";
import type { TermPlan } from "~/shared/domain/term";

/** What a course thread is asked to start. Each member names only what that work needs. */
export type HandoffWork =
  | { kind: "announcement"; topic?: string }
  | { kind: "replies" }
  | { kind: "reply"; conversation: LmsRef<"conversation"> }
  | { kind: "grading"; assignment: LmsRef<"assignment"> };

/** Something North Star points at. The parser checks it exists, so an answer can't cite a thing that isn't there. */
export type Source =
  | { kind: "course"; ref: LmsRef<"course"> }
  | { kind: "assignment"; ref: LmsRef<"assignment"> }
  | { kind: "announcement"; ref: LmsRef<"announcement"> }
  | { kind: "conversation"; ref: LmsRef<"conversation"> }
  | { kind: "submission"; ref: LmsRef<"submission"> }
  | { kind: "change"; ref: ChangeId }
  | { kind: "due" };

export interface AnswerLine {
  source: Source;
  title: string;
  detail?: string;
}

export interface NextWork {
  course: LmsRef<"course">;
  work: HandoffWork;
}

/** Everything an agent may cause. There is no approve or send member, so no parser branch can produce one. */
export type AgentEffect =
  | { type: "say"; text: string; lines?: readonly AnswerLine[]; replies?: readonly string[] }
  /** The agent saying no. The thread renders it apart from ordinary replies. */
  | { type: "decline"; text: string; lines?: readonly AnswerLine[] }
  | { type: "work"; line: string }
  /** What a model run cost, from the API's own count. The model can't write one: main adds it after the run. */
  | { type: "spend"; tokens: number; usd: number }
  | {
      type: "propose";
      school: SchoolId;
      course: LmsRef<"course">;
      subject: string;
      content: ChangeContent;
    }
  | { type: "edit"; change: ChangeId; patch: ChangePatch; why: string }
  /** Rationale for one rubric criterion or the overall score, with quotes that must exist in the submission. */
  | {
      type: "annotate";
      change: ChangeId;
      field: string;
      why: string;
      quotes: readonly { paragraph: number; quote: string }[];
    }
  /**
   * Something the agent noticed in a course being set up. The quote has to be in the item's body. `after` is suggested
   * replacement text, which the store turns into a fix only by way of the scan rules, so an agent names no kind and sets no risk.
   */
  | {
      type: "finding";
      findingType: FindingType;
      item: LmsRef<"item">;
      quote: string;
      why: string;
      after: string | null;
    }
  /**
   * Starts work in a course thread. Only a North Star chat's scope allows it, and what starts is still only a draft.
   * `request` is the ask in the person's words, which may be messages back from the answer that named the course. `left` names what they asked for that this draft doesn't use.
   */
  | {
      type: "handoff";
      school: SchoolId;
      course: LmsRef<"course">;
      work: HandoffWork;
      brief: string;
      request: string;
      left?: string;
    };

/** Data only. No provider, store, vault, or token is reachable from here. `scope.changes` stays current during a run, so a propose is visible to the annotate that follows it. */
export interface AgentInput {
  request: string;
  thread: { history: readonly { role: "user" | "agent"; text: string }[] };
  scope: AgentScope;
}
/** The allowlist parseAgentEffect checks against. An agent cannot aim outside what the thread opened. */
export interface AgentScope {
  focus: ChangeId | null;
  changes: readonly ChangeRecord[];
  submissions: readonly Submission[];
  assignments: readonly Assignment[];
  conversations: readonly Conversation[];
  courses: readonly Course[];
  /** Present only in a setup thread. The rules' own findings ride along so the agent can speak to them. */
  scan?: { content: CourseContent; findings: readonly Finding[]; plan: TermPlan };
  northStar?: {
    announcements: readonly Announcement[];
    schools: readonly School[];
    now: IsoTime;
    next: readonly NextWork[];
  };
}

/** What the app sends when a person opens something to work on. The scope holds only that one thing. */
export const DRAFT_GRADE_REQUEST = "Draft a grade for this submission.";
export const DRAFT_REPLY_REQUEST = "Draft a reply to this conversation.";
export const DRAFT_ANNOUNCEMENT_REQUEST = "Draft an announcement for this course.";
export const DRAFT_MESSAGE_REQUEST = "Draft a message to this student about this assignment.";
/** The same ask with what the person said it should be about, in their words. */
export const draftAnnouncementAbout = (topic: string): string =>
  `Draft an announcement for this course about ${topic}.`;
export const SCAN_COURSE_REQUEST = "Look over this course for the new term.";
/** `Rationale.field` for a score with no rubric criterion behind it. */
export const OVERALL_RATIONALE = "overall";

export interface Agent {
  readonly label: string;
  /** Yields unknown, so a real model's output must pass the parser. The rule agent goes through it too. */
  run(input: AgentInput, signal: AbortSignal): AsyncIterable<unknown>;
}

export type AgentViolation =
  | { kind: "unknown-effect"; seen: string }
  | { kind: "malformed"; detail: string }
  | { kind: "out-of-scope"; target: string }
  | { kind: "out-of-range"; detail: string }
  | { kind: "quote-not-found"; quote: string };

const MAX_TEXT = 20_000;
const fail = (error: AgentViolation): Result<AgentEffect, AgentViolation> => ({ ok: false, error });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT;
const isTextList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isText);
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const clip = (value: unknown): string => String(value).slice(0, 80);

const parseAttachment = (raw: unknown): AttachmentDraft | null | undefined => {
  if (raw === null) return null;
  return isRecord(raw) && isText(raw["name"]) && isNumber(raw["kb"]) && raw["kb"] >= 0
    ? { name: raw["name"], kb: raw["kb"] }
    : undefined;
};

const parseGradeContent = (
  raw: Record<string, unknown>,
  scope: AgentScope,
): Result<GradeContent, AgentViolation> => {
  const submission = scope.submissions.find((s) => s.ref === raw["target"]);
  if (!submission)
    return { ok: false, error: { kind: "out-of-scope", target: clip(raw["target"]) } };
  const assignment = scope.assignments.find((a) => a.ref === submission.assignment);
  if (!assignment)
    return { ok: false, error: { kind: "out-of-scope", target: submission.assignment } };
  const outOf = assignment.pointsPossible;
  const attachment = parseAttachment(raw["attachment"] ?? null);
  const comment = raw["comment"] ?? null;
  if (attachment === undefined)
    return { ok: false, error: { kind: "malformed", detail: "attachment" } };
  if (comment !== null && !isText(comment))
    return { ok: false, error: { kind: "malformed", detail: "comment" } };
  const points = raw["points"] ?? null;
  if (points !== null && (!isNumber(points) || points < 0 || points > outOf))
    return {
      ok: false,
      error: { kind: "out-of-range", detail: `points ${clip(points)} of ${outOf}` },
    };
  const late = lateOf(submission, assignment);
  if (!assignment.rubric)
    return {
      ok: true,
      value: {
        kind: "grade",
        target: submission.ref,
        points,
        outOf,
        rubric: null,
        late,
        comment,
        attachment,
        override: null,
        excused: false,
      },
    };
  if (!Array.isArray(raw["rubric"]))
    return { ok: false, error: { kind: "malformed", detail: "rubric" } };
  const scores = new Map<unknown, unknown>(
    raw["rubric"].filter(isRecord).map((entry) => [entry["criterion"], entry["points"]]),
  );
  const rubric: RubricScore[] = [];
  for (const criterion of assignment.rubric) {
    const value = scores.get(criterion.ref);
    if (!isNumber(value) || value < 0 || value > criterion.maxPoints)
      return {
        ok: false,
        error: {
          kind: "out-of-range",
          detail: `${criterion.name}: ${clip(value)} of ${criterion.maxPoints}`,
        },
      };
    rubric.push({
      criterion: criterion.ref,
      name: criterion.name,
      points: value,
      outOf: criterion.maxPoints,
    });
  }
  return {
    ok: true,
    value: {
      kind: "grade",
      target: submission.ref,
      points: null,
      outOf,
      rubric,
      late,
      comment,
      attachment,
      override: null,
      excused: false,
    },
  };
};

const parseContent = (raw: unknown, scope: AgentScope): Result<ChangeContent, AgentViolation> => {
  if (!isRecord(raw)) return { ok: false, error: { kind: "malformed", detail: "content" } };
  switch (raw["kind"]) {
    case "grade":
      return parseGradeContent(raw, scope);
    case "reply": {
      const conversation = scope.conversations.find((c) => c.ref === raw["target"]);
      if (!conversation)
        return { ok: false, error: { kind: "out-of-scope", target: clip(raw["target"]) } };
      if (!isText(raw["body"])) return { ok: false, error: { kind: "malformed", detail: "body" } };
      return { ok: true, value: { kind: "reply", target: conversation.ref, body: raw["body"] } };
    }
    case "message": {
      const submission = scope.submissions.find((s) => s.ref === raw["target"]);
      if (!submission)
        return { ok: false, error: { kind: "out-of-scope", target: clip(raw["target"]) } };
      if (!isText(raw["subject"]) || !isText(raw["body"]))
        return { ok: false, error: { kind: "malformed", detail: "subject or body" } };
      return {
        ok: true,
        value: {
          kind: "message",
          target: submission.ref,
          subject: raw["subject"],
          body: raw["body"],
        },
      };
    }
    case "announcement": {
      const course = scope.courses.find((c) => c.ref === raw["target"]);
      if (!course)
        return { ok: false, error: { kind: "out-of-scope", target: clip(raw["target"]) } };
      if (!isText(raw["title"]) || !isText(raw["body"]))
        return { ok: false, error: { kind: "malformed", detail: "title or body" } };
      return {
        ok: true,
        value: { kind: "announcement", target: course.ref, title: raw["title"], body: raw["body"] },
      };
    }
    default:
      return {
        ok: false,
        error: { kind: "malformed", detail: `content kind ${clip(raw["kind"])}` },
      };
  }
};

const parsePatch = (raw: unknown, record: ChangeRecord): Result<ChangePatch, AgentViolation> => {
  if (!isRecord(raw) || raw["kind"] !== record.content.kind)
    return { ok: false, error: { kind: "malformed", detail: "patch" } };
  const { content } = record;
  if (!isAgentContent(content))
    return { ok: false, error: { kind: "malformed", detail: `patch for ${content.kind}` } };
  switch (content.kind) {
    case "grade": {
      const patch: {
        kind: "grade";
        rubricPoints?: Record<string, number>;
        points?: number;
        comment?: string | null;
        attachment?: AttachmentDraft | null;
      } = { kind: "grade" };
      if (raw["rubricPoints"] !== undefined) {
        if (!isRecord(raw["rubricPoints"]))
          return { ok: false, error: { kind: "malformed", detail: "rubricPoints" } };
        const points: Record<string, number> = {};
        for (const [criterion, value] of Object.entries(raw["rubricPoints"])) {
          const score = content.rubric?.find((r) => r.criterion === criterion);
          if (!score)
            return { ok: false, error: { kind: "out-of-scope", target: clip(criterion) } };
          if (!isNumber(value) || value < 0 || value > score.outOf)
            return {
              ok: false,
              error: {
                kind: "out-of-range",
                detail: `${score.name}: ${clip(value)} of ${score.outOf}`,
              },
            };
          points[criterion] = value;
        }
        patch.rubricPoints = points;
      }
      if (raw["points"] !== undefined) {
        if (!isNumber(raw["points"]) || raw["points"] < 0 || raw["points"] > content.outOf)
          return {
            ok: false,
            error: {
              kind: "out-of-range",
              detail: `points ${clip(raw["points"])} of ${content.outOf}`,
            },
          };
        patch.points = raw["points"];
      }
      if (raw["comment"] !== undefined) {
        if (raw["comment"] !== null && !isText(raw["comment"]))
          return { ok: false, error: { kind: "malformed", detail: "comment" } };
        patch.comment = raw["comment"];
      }
      if (raw["attachment"] !== undefined) {
        const attachment = parseAttachment(raw["attachment"]);
        if (attachment === undefined)
          return { ok: false, error: { kind: "malformed", detail: "attachment" } };
        patch.attachment = attachment;
      }
      return { ok: true, value: patch };
    }
    case "reply":
    case "message":
      return isText(raw["body"])
        ? { ok: true, value: { kind: content.kind, body: raw["body"] } }
        : { ok: false, error: { kind: "malformed", detail: "body" } };
    case "announcement": {
      const patch: { kind: "announcement"; title?: string; body?: string } = {
        kind: "announcement",
      };
      if (raw["title"] !== undefined) {
        if (!isText(raw["title"]))
          return { ok: false, error: { kind: "malformed", detail: "title" } };
        patch.title = raw["title"];
      }
      if (raw["body"] !== undefined) {
        if (!isText(raw["body"]))
          return { ok: false, error: { kind: "malformed", detail: "body" } };
        patch.body = raw["body"];
      }
      return { ok: true, value: patch };
    }
    case "text-fix":
      return isText(raw["after"])
        ? { ok: true, value: { kind: "text-fix", after: raw["after"] } }
        : { ok: false, error: { kind: "malformed", detail: "after" } };
  }
};

const parseLines = (
  raw: unknown,
  scope: AgentScope,
): Result<readonly AnswerLine[], AgentViolation> => {
  if (!Array.isArray(raw)) return { ok: false, error: { kind: "malformed", detail: "say lines" } };
  const lines: AnswerLine[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (
      !isRecord(entry) ||
      !isRecord(entry["source"]) ||
      !isText(entry["title"]) ||
      (entry["detail"] !== undefined && !isText(entry["detail"]))
    )
      return { ok: false, error: { kind: "malformed", detail: "say lines" } };
    const source = parseSource(entry["source"], scope);
    if (!source)
      return {
        ok: false,
        error: {
          kind: "out-of-scope",
          target: clip(entry["source"]["ref"] ?? entry["source"]["kind"]),
        },
      };
    lines.push({
      source,
      title: entry["title"],
      ...(entry["detail"] === undefined ? {} : { detail: entry["detail"] }),
    });
  }
  return { ok: true, value: lines };
};

const parseSource = (raw: Record<string, unknown>, scope: AgentScope): Source | null => {
  const isRef = (item: { ref: string }) => item.ref === raw["ref"];
  switch (raw["kind"]) {
    case "course": {
      const found = scope.courses.find(isRef);
      return found ? { kind: "course", ref: found.ref } : null;
    }
    case "assignment": {
      const found = scope.assignments.find(isRef);
      return found ? { kind: "assignment", ref: found.ref } : null;
    }
    case "announcement": {
      const found = scope.northStar?.announcements.find(isRef);
      return found ? { kind: "announcement", ref: found.ref } : null;
    }
    case "conversation": {
      const found = scope.conversations.find(isRef);
      return found ? { kind: "conversation", ref: found.ref } : null;
    }
    case "submission": {
      const found = scope.submissions.find(isRef);
      return found ? { kind: "submission", ref: found.ref } : null;
    }
    case "change": {
      const found = scope.changes.find((change) => change.id === raw["ref"]);
      return found ? { kind: "change", ref: found.id } : null;
    }
    case "due":
      return { kind: "due" };
    default:
      return null;
  }
};

const parseDecline = (
  raw: Record<string, unknown>,
  scope: AgentScope,
): Result<AgentEffect, AgentViolation> => {
  if (!isText(raw["text"])) return fail({ kind: "malformed", detail: "decline text" });
  if (raw["lines"] === undefined)
    return { ok: true, value: { type: "decline", text: raw["text"] } };
  const lines = parseLines(raw["lines"], scope);
  return lines.ok
    ? { ok: true, value: { type: "decline", text: raw["text"], lines: lines.value } }
    : fail(lines.error);
};

const parseSay = (
  raw: Record<string, unknown>,
  scope: AgentScope,
): Result<AgentEffect, AgentViolation> => {
  if (!isText(raw["text"])) return fail({ kind: "malformed", detail: "say text" });
  const replies = raw["replies"];
  if (replies !== undefined && !isTextList(replies))
    return fail({ kind: "malformed", detail: "say replies" });
  const answers = replies === undefined ? {} : { replies };
  if (raw["lines"] === undefined)
    return { ok: true, value: { type: "say", text: raw["text"], ...answers } };
  const lines = parseLines(raw["lines"], scope);
  return lines.ok
    ? { ok: true, value: { type: "say", text: raw["text"], lines: lines.value, ...answers } }
    : fail(lines.error);
};

const parseHandoffWork = (
  raw: unknown,
  course: Course,
  scope: AgentScope,
): Result<HandoffWork, AgentViolation> => {
  if (!isRecord(raw)) return { ok: false, error: { kind: "malformed", detail: "handoff work" } };
  switch (raw["kind"]) {
    case "announcement": {
      const topic = raw["topic"];
      if (topic === undefined) return { ok: true, value: { kind: "announcement" } };
      return isText(topic)
        ? { ok: true, value: { kind: "announcement", topic } }
        : { ok: false, error: { kind: "malformed", detail: "announcement topic" } };
    }
    case "replies":
      return { ok: true, value: { kind: "replies" } };
    case "reply": {
      const conversation = scope.conversations.find(
        (c) => c.ref === raw["conversation"] && c.course === course.ref,
      );
      return conversation
        ? { ok: true, value: { kind: "reply", conversation: conversation.ref } }
        : { ok: false, error: { kind: "out-of-scope", target: clip(raw["conversation"]) } };
    }
    case "grading": {
      const assignment = scope.assignments.find(
        (a) => a.ref === raw["assignment"] && a.course === course.ref,
      );
      return assignment
        ? { ok: true, value: { kind: "grading", assignment: assignment.ref } }
        : { ok: false, error: { kind: "out-of-scope", target: clip(raw["assignment"]) } };
    }
    default:
      return {
        ok: false,
        error: { kind: "malformed", detail: `handoff work ${clip(raw["kind"])}` },
      };
  }
};

const parseHandoff = (
  raw: Record<string, unknown>,
  scope: AgentScope,
): Result<AgentEffect, AgentViolation> => {
  if (!scope.northStar) return fail({ kind: "out-of-scope", target: "handoff" });
  const course = scope.courses.find((c) => c.ref === raw["course"] && c.school === raw["school"]);
  if (!course) return fail({ kind: "out-of-scope", target: clip(raw["course"]) });
  const work = parseHandoffWork(raw["work"], course, scope);
  if (!work.ok) return fail(work.error);
  if (!isText(raw["brief"])) return fail({ kind: "malformed", detail: "brief" });
  if (!isText(raw["request"])) return fail({ kind: "malformed", detail: "request" });
  const left = raw["left"];
  if (left !== undefined && !isText(left)) return fail({ kind: "malformed", detail: "left" });
  return {
    ok: true,
    value: {
      type: "handoff",
      school: course.school,
      course: course.ref,
      work: work.value,
      brief: raw["brief"],
      request: raw["request"],
      ...(left === undefined ? {} : { left }),
    },
  };
};

const parseAnnotate = (
  raw: Record<string, unknown>,
  scope: AgentScope,
): Result<AgentEffect, AgentViolation> => {
  const record = scope.changes.find((c) => c.id === raw["change"]);
  if (!record) return fail({ kind: "out-of-scope", target: clip(raw["change"]) });
  if (record.content.kind !== "grade")
    return fail({ kind: "malformed", detail: "only a grade can be annotated" });
  const { target } = record.content;
  const submission = scope.submissions.find((s) => s.ref === target);
  if (!submission) return fail({ kind: "out-of-scope", target });
  if (!isText(raw["field"]) || !isText(raw["why"]) || !Array.isArray(raw["quotes"]))
    return fail({ kind: "malformed", detail: "annotate" });
  const passages = passagesOf(submission);
  const quotes: { paragraph: number; quote: string }[] = [];
  for (const entry of raw["quotes"] as readonly unknown[]) {
    if (!isRecord(entry) || !isText(entry["quote"]) || !Number.isInteger(entry["paragraph"]))
      return fail({ kind: "malformed", detail: "quote" });
    const paragraph = entry["paragraph"] as number;
    if (!passages[paragraph]?.includes(entry["quote"]))
      return fail({ kind: "quote-not-found", quote: clip(entry["quote"]) });
    quotes.push({ paragraph, quote: entry["quote"] });
  }
  return {
    ok: true,
    value: { type: "annotate", change: record.id, field: raw["field"], why: raw["why"], quotes },
  };
};

/** Allowlist parse. `{ type: "approve" }` is an unknown-effect and shows in the thread as refused. Output is rebuilt, so extra keys never pass through. */
export const parseAgentEffect = (
  raw: unknown,
  scope: AgentScope,
): Result<AgentEffect, AgentViolation> => {
  if (!isRecord(raw)) return fail({ kind: "malformed", detail: "effect is not an object" });
  switch (raw["type"]) {
    case "say":
      return parseSay(raw, scope);
    case "decline":
      return parseDecline(raw, scope);
    case "work":
      return isText(raw["line"])
        ? { ok: true, value: { type: "work", line: raw["line"] } }
        : fail({ kind: "malformed", detail: "work line" });
    case "spend":
      return isNumber(raw["tokens"]) &&
        Number.isInteger(raw["tokens"]) &&
        raw["tokens"] >= 0 &&
        isNumber(raw["usd"]) &&
        raw["usd"] >= 0
        ? { ok: true, value: { type: "spend", tokens: raw["tokens"], usd: raw["usd"] } }
        : fail({ kind: "malformed", detail: "spend" });
    case "propose": {
      const course = scope.courses.find(
        (c) => c.ref === raw["course"] && c.school === raw["school"],
      );
      if (!course) return fail({ kind: "out-of-scope", target: clip(raw["course"]) });
      if (!isText(raw["subject"])) return fail({ kind: "malformed", detail: "subject" });
      const content = parseContent(raw["content"], scope);
      if (!content.ok) return fail(content.error);
      return {
        ok: true,
        value: {
          type: "propose",
          school: course.school,
          course: course.ref,
          subject: raw["subject"],
          content: content.value,
        },
      };
    }
    case "edit": {
      const record = scope.changes.find((c) => c.id === raw["change"]);
      if (!record) return fail({ kind: "out-of-scope", target: clip(raw["change"]) });
      if (!isText(raw["why"])) return fail({ kind: "malformed", detail: "why" });
      const patch = parsePatch(raw["patch"], record);
      if (!patch.ok) return fail(patch.error);
      return {
        ok: true,
        value: { type: "edit", change: record.id, patch: patch.value, why: raw["why"] },
      };
    }
    case "annotate":
      return parseAnnotate(raw, scope);
    case "finding":
      return parseFinding(raw, scope);
    case "handoff":
      return parseHandoff(raw, scope);
    default:
      return fail({ kind: "unknown-effect", seen: clip(raw["type"]) });
  }
};

const parseFinding = (
  raw: Record<string, unknown>,
  scope: AgentScope,
): Result<AgentEffect, AgentViolation> => {
  if (!scope.scan) return fail({ kind: "out-of-scope", target: "course content" });
  const item = scope.scan.content.items.find((entry) => entry.ref === raw["item"]);
  if (!item) return fail({ kind: "out-of-scope", target: clip(raw["item"]) });
  if (!isFindingType(raw["findingType"]))
    return fail({ kind: "malformed", detail: `finding type ${clip(raw["findingType"])}` });
  if (!isText(raw["quote"]) || !item.body.includes(raw["quote"]))
    return fail({ kind: "quote-not-found", quote: clip(raw["quote"]) });
  if (!isText(raw["why"])) return fail({ kind: "malformed", detail: "why" });
  const after = raw["after"] ?? null;
  if (after !== null && !isText(after)) return fail({ kind: "malformed", detail: "after" });
  return {
    ok: true,
    value: {
      type: "finding",
      findingType: raw["findingType"],
      item: item.ref,
      quote: raw["quote"],
      why: raw["why"],
      after,
    },
  };
};

export const describeViolation = (violation: AgentViolation): string => {
  switch (violation.kind) {
    case "unknown-effect":
      return `The agent asked to "${violation.seen}", which it is not allowed to do. Only the Approve and Send buttons can act on the LMS.`;
    case "malformed":
      return `The agent produced something unreadable (${violation.detail}), so it was ignored.`;
    case "out-of-scope":
      return "The agent aimed at something outside this thread, so it was ignored.";
    case "out-of-range":
      return `The agent proposed a value out of range (${violation.detail}), so it was ignored.`;
    case "quote-not-found":
      return `The agent cited a passage that is not in the text it was given ("${violation.quote}"), so it was ignored.`;
  }
};

export interface AgentSink {
  /** Awaited, so the next yield parses against a scope that includes this effect. */
  effect(effect: AgentEffect): void | Promise<void>;
  refuse(violation: AgentViolation): void;
}

/** The only way agent output reaches the app. A model that throws reads like any other bad output. */
export const runAgent = async (
  agent: Agent,
  input: AgentInput,
  sink: AgentSink,
  signal: AbortSignal,
): Promise<void> => {
  try {
    for await (const raw of agent.run(input, signal)) {
      if (signal.aborted) return;
      const parsed = parseAgentEffect(raw, input.scope);
      if (parsed.ok) await sink.effect(parsed.value);
      else sink.refuse(parsed.error);
    }
  } catch {
    sink.refuse({ kind: "malformed", detail: "the agent stopped unexpectedly" });
  }
};
