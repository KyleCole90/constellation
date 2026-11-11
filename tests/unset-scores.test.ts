import { describe, expect, it } from "vite-plus/test";

import { fingerprintOf } from "~/shared/domain/approval";
import { blankAnnouncement, blankGrade, blankReply } from "~/shared/domain/blank";
import {
  fieldText,
  fieldsOf,
  finalGrade,
  fitContent,
  rawScore,
  scoredRubricPoints,
  summarize,
  transition,
  unfilled,
  type ChangeContent,
  type ChangeRecord,
  type GradeContent,
  type RemoteState,
} from "~/shared/domain/change";
import type { LmsRef } from "~/shared/domain/ids";
import type { Assignment, Conversation, Course, Submission } from "~/shared/domain/lms";
import { previewOf } from "~/shared/domain/preview";

import {
  AT,
  COURSE,
  CRITERION,
  SCHOOL,
  SUBMISSION,
  clickWitness,
  gradeContent,
  newDraft,
} from "./fixtures/changes";

const EVIDENCE = "lcc:criterion:2:evidence" as LmsRef<"criterion">;
const rubric = (thesis: number | null, evidence: number | null): GradeContent["rubric"] => [
  { criterion: CRITERION, name: "Thesis", points: thesis, outOf: 25 },
  { criterion: EVIDENCE, name: "Evidence", points: evidence, outOf: 25 },
];
const partial = () => gradeContent({ rubric: rubric(18, null) });
const overall = (points: number | null) => gradeContent({ rubric: null, points });

const CONTENT_AT_549E11D = {
  kind: "grade",
  target: "lcc:submission:1:2:3",
  points: null,
  outOf: 100,
  rubric: [
    { criterion: "lcc:criterion:2:thesis", name: "Thesis", points: 18, outOf: 25 },
    { criterion: "lcc:criterion:2:evidence", name: "Evidence", points: 0, outOf: 25 },
  ],
  late: { days: 1, pointsPerDay: 2 },
  comment: "Strong opening. Keep going.",
  attachment: null,
} as unknown as ChangeContent;
const REMOTE_AT_549E11D = {
  kind: "grade",
  targetVersion: "attempt:1",
  grade: null,
  rubric: null,
  comments: [],
  attachments: [],
} as unknown as RemoteState;
const FINGERPRINT_AT_549E11D = "1fd3d0b7e7605f";

describe("a total of part scores", () => {
  it("has no float noise, so the LMS gets the number the teacher sees", () => {
    const content = gradeContent({ rubric: rubric(0.1, 0.2) });
    expect(rawScore(content)).toBe(0.3);
    expect(finalGrade(content)).toBe(0.3);
    expect(
      finalGrade(
        gradeContent({
          rubric: rubric(10.1, 0.2),
          late: { days: 1, pointsPerDay: 0.1, waived: false },
        }),
      ),
    ).toBe(10.2);
  });
});

describe("a grade with an unset score", () => {
  it("has no total, with a rubric or without one", () => {
    expect(rawScore(partial())).toBeNull();
    expect(finalGrade(partial())).toBeNull();
    expect(rawScore(overall(null))).toBeNull();
    expect(
      finalGrade(
        gradeContent({
          rubric: null,
          points: null,
          late: { days: 2, pointsPerDay: 5, waived: false },
        }),
      ),
    ).toBeNull();
  });

  it("treats an entered 0 as a value, so the total is 0 rather than unset", () => {
    expect(rawScore(gradeContent({ rubric: rubric(0, 0) }))).toBe(0);
    expect(finalGrade(overall(0))).toBe(0);
    expect(fieldsOf(gradeContent({ rubric: rubric(0, 0) }))).toEqual([
      "grade",
      "rubric",
      "comment",
    ]);
    expect(unfilled(overall(0))).toEqual([]);
  });

  it("would write no grade and no rubric, but keeps a comment", () => {
    expect(fieldsOf(partial())).toEqual(["comment"]);
    expect(fieldsOf(overall(null))).toEqual(["comment"]);
    expect(fieldsOf(gradeContent({ rubric: rubric(null, null), comment: null }))).toEqual([]);
  });

  it("shows nothing in the preview about a score it won't write", () => {
    expect(previewOf(newDraft("ch-p", partial()), "append").map((field) => field.field)).toEqual([
      "comment",
    ]);
  });

  it("leaves an unset criterion out of the scores, instead of reading it as 0", () => {
    expect(scoredRubricPoints(rubric(18, null) ?? [])).toEqual({ [CRITERION]: 18 });
  });

  it("reads as empty text, never the word null", () => {
    expect(fieldText(overall(null), "grade")).toBe("");
  });

  it("stays unset when a school can't take a rubric", () => {
    const fitted = fitContent(gradeContent({ rubric: rubric(null, null) }), {
      rubricWrite: false,
      attachments: true,
    });
    expect(fitted.kind === "grade" && fitted.points).toBeNull();
    expect(fieldsOf(fitted)).toEqual(["comment"]);
  });
});

describe("what still needs a value", () => {
  it("names each unset criterion", () => {
    expect(unfilled(gradeContent({ rubric: rubric(null, null) }))).toEqual(["Thesis", "Evidence"]);
    expect(unfilled(partial())).toEqual(["Evidence"]);
  });

  it("names the score when there is no rubric", () => {
    expect(unfilled(overall(null))).toEqual(["Score"]);
  });

  it("doesn't need a comment on a grade", () => {
    expect(unfilled(gradeContent({ rubric: rubric(1, 2), comment: null }))).toEqual([]);
  });

  it("names a blank reply, and whitespace counts as blank", () => {
    expect(
      unfilled({ kind: "reply", target: "c" as LmsRef<"conversation">, body: "  \n" }),
    ).toEqual(["Reply"]);
    expect(unfilled({ kind: "reply", target: "c" as LmsRef<"conversation">, body: "Hi" })).toEqual(
      [],
    );
  });

  it("names blank fix text, so a cleared fix can't be approved", () => {
    const fix = (after: string): ChangeContent => ({
      kind: "text-fix",
      target: "p" as LmsRef<"item">,
      where: "Syllabus",
      splice: { prefix: "due ", before: "Oct 12", after, suffix: "." },
    });
    expect(unfilled(fix(" \n"))).toEqual(["New text"]);
    expect(unfilled(fix("\n\n"))).toEqual(["New text"]);
    expect(unfilled(fix("Mar 8"))).toEqual([]);
  });

  it("names a blank announcement title and body", () => {
    const target = COURSE;
    expect(unfilled({ kind: "announcement", target, title: "", body: "" })).toEqual([
      "Title",
      "Announcement",
    ]);
    expect(unfilled({ kind: "announcement", target, title: "Week 3", body: "" })).toEqual([
      "Announcement",
    ]);
    expect(
      unfilled({ kind: "announcement", target, title: "Week 3", body: "Read chapter 4." }),
    ).toEqual([]);
  });
});

describe("approving and sending a form with blanks", () => {
  it("a blank draft reads as in progress and offers no approval", () => {
    const summary = summarize(newDraft("ch-1", partial()));
    expect(summary).toMatchObject({
      label: "In progress",
      tone: "todo",
      canApprove: false,
      canEdit: true,
      canDiscard: true,
      missing: ["Evidence"],
    });
  });

  it("a complete draft still reads as needing approval", () => {
    expect(summarize(newDraft("ch-1", gradeContent({ rubric: rubric(0, 25) })))).toMatchObject({
      label: "AI draft. Not sent",
      tone: "approval",
      canApprove: true,
      missing: [],
    });
  });

  it("a genuine approval click on a form with blanks is refused", () => {
    const record = newDraft("ch-1", partial());
    expect(transition(record, { type: "approve", witness: clickWitness(record), at: AT })).toEqual({
      ok: false,
      error: "incomplete",
    });
  });

  it("a reply emptied by an edit is refused the same way", () => {
    const record = newDraft("ch-1", {
      kind: "reply",
      target: "c" as LmsRef<"conversation">,
      body: "  ",
    });
    expect(transition(record, { type: "approve", witness: clickWitness(record), at: AT })).toEqual({
      ok: false,
      error: "incomplete",
    });
  });

  it("an approved record with a blank score can't begin a send", () => {
    const draft = newDraft("ch-1", overall(null));
    const forged: ChangeRecord = {
      ...draft,
      state: {
        tag: "approved",
        approval: { changeId: draft.id, fingerprint: fingerprintOf(draft), at: AT, via: "button" },
      },
    };
    expect(transition(forged, { type: "begin-send", seen: {}, at: AT })).toEqual({
      ok: false,
      error: "not-sendable",
    });
  });

  it("an entered 0 can be approved", () => {
    const record = newDraft("ch-1", overall(0));
    expect(transition(record, { type: "approve", witness: clickWitness(record), at: AT }).ok).toBe(
      true,
    );
  });
});

describe("a record saved before scores could be unset", () => {
  const record: ChangeRecord = newDraft("ch-old", CONTENT_AT_549E11D, REMOTE_AT_549E11D);

  it("keeps the fingerprint its approval was given", () => {
    expect(fingerprintOf(record)).toBe(FINGERPRINT_AT_549E11D);
  });

  it("still writes its grade and rubric, with the stored 0 as a real score", () => {
    expect(fieldsOf(record.content)).toEqual(["grade", "rubric", "comment"]);
    expect(record.content.kind === "grade" && finalGrade(record.content)).toBe(16);
  });
});

describe("a blank form", () => {
  const criterion = { ref: CRITERION, name: "Thesis", maxPoints: 25, description: "" };
  const assignment = {
    ref: "a",
    shortTitle: "Essay 2",
    pointsPossible: 100,
    rubric: [criterion],
    latePointsPerDay: 5,
  } as unknown as Assignment;
  const submission = {
    ref: SUBMISSION,
    school: SCHOOL,
    course: COURSE,
    studentName: "Maya Lin",
    lateDays: 2,
  } as unknown as Submission;

  it("starts every score unset and keeps the late penalty", () => {
    const { content, subject } = blankGrade(submission, assignment);
    expect(subject).toBe("Maya Lin, Essay 2");
    expect(content).toMatchObject({
      kind: "grade",
      points: null,
      comment: null,
      attachment: null,
      late: { days: 2, pointsPerDay: 5, waived: false },
      rubric: [{ criterion: CRITERION, name: "Thesis", points: null, outOf: 25 }],
    });
  });

  it.each([[null], [[]]])("takes one overall score when the rubric is %j", (none) => {
    const { content } = blankGrade(submission, { ...assignment, rubric: none });
    expect(content).toMatchObject({ rubric: null, points: null });
    expect(unfilled(content)).toEqual(["Score"]);
  });

  it("starts a reply and an announcement empty", () => {
    const conversation = {
      ref: "c",
      school: SCHOOL,
      course: COURSE,
      from: "Maya Lin",
    } as unknown as Conversation;
    const course = { ref: COURSE, school: SCHOOL, code: "ENG101" } as unknown as Course;
    expect(blankReply(conversation).content).toMatchObject({ kind: "reply", body: "" });
    expect(blankAnnouncement(course).content).toMatchObject({
      kind: "announcement",
      title: "",
      body: "",
    });
  });
});
