import { ApprovalWitness, fingerprintOf } from "~/shared/domain/approval";
import {
  newChangeRecord,
  summarize,
  transition,
  type ChangeEvent,
  type ChangeRecord,
  type ChangeContent,
  type ChangeSummary,
  type GradeContent,
  type RemoteState,
} from "~/shared/domain/change";
import { isoTime } from "~/shared/domain/ids";
import { changeId, lmsRef, schoolId } from "./ids";

export const AT = isoTime("2026-10-30T12:00:00.000Z");
export const SCHOOL = schoolId("lcc");
export const COURSE = lmsRef<"course">("lcc:course:1");
export const SUBMISSION = lmsRef<"submission">("lcc:submission:1:2:3");
export const CRITERION = lmsRef<"criterion">("lcc:criterion:2:thesis");

export const gradeContent = (patch: Partial<GradeContent> = {}): GradeContent => ({
  kind: "grade",
  target: SUBMISSION,
  points: null,
  outOf: 100,
  rubric: [{ criterion: CRITERION, name: "Thesis", points: 18, outOf: 25 }],
  late: null,
  comment: "Strong opening. Keep going.",
  attachment: null,
  override: null,
  excused: false,
  ...patch,
});

export const gradeRemote = (
  patch: Partial<Extract<RemoteState, { kind: "grade" }>> = {},
): RemoteState => ({
  kind: "grade",
  targetVersion: "attempt:1",
  grade: null,
  rubric: null,
  excused: false,
  comments: [],
  attachments: [],
  ...patch,
});

export const newDraft = (
  id = "ch-1",
  content: ChangeContent = gradeContent(),
  remote: RemoteState = gradeRemote(),
): ChangeRecord =>
  newChangeRecord({
    id: changeId(id),
    school: SCHOOL,
    course: COURSE,
    subject: "Maya, Essay 2",
    content,
    basis: { readAt: AT, remote },
    at: AT,
    by: "agent",
  });

export const clickWitness = (record: ChangeRecord): ApprovalWitness => {
  const witness = ApprovalWitness.fromClick({ isTrusted: true, type: "click" }, [
    { changeId: record.id, fingerprint: fingerprintOf(record) },
  ]);
  if (!witness) throw new Error("A trusted click should mint a witness.");
  return witness;
};

export const step = (record: ChangeRecord, event: ChangeEvent): ChangeRecord => {
  const next = transition(record, event);
  if (!next.ok) throw new Error(`Rejected ${event.type}: ${next.error}`);
  return next.value;
};

export const approved = (record: ChangeRecord = newDraft()): ChangeRecord =>
  step(record, { type: "approve", witness: clickWitness(record), at: AT });
export const sending = (record: ChangeRecord = approved()): ChangeRecord =>
  step(record, { type: "begin-send", seen: {}, at: AT });
export const held = (record: ChangeRecord = sending()): ChangeRecord =>
  step(record, {
    type: "hold",
    cause: { tag: "failed", error: { kind: "unavailable", status: 500 }, retriesExhausted: false },
    at: AT,
  });
export const conflicted = (record: ChangeRecord = sending()): ChangeRecord =>
  step(record, {
    type: "conflict",
    conflicts: [
      { field: "grade", reason: "changed-by-other", basis: null, theirs: "65", mine: "18" },
    ],
    at: AT,
  });
export const sent = (record: ChangeRecord = sending()): ChangeRecord =>
  step(record, { type: "finish", at: AT });
export const discarded = (record: ChangeRecord = newDraft()): ChangeRecord =>
  step(record, { type: "discard", at: AT });

export const changeSummary = (patch: Partial<ChangeSummary> = {}): ChangeSummary => ({
  ...summarize(newDraft()),
  ...patch,
});
