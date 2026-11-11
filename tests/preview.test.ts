import { describe, expect, it } from "vite-plus/test";

import type { ChangeContent } from "~/domain/change";
import { previewOf, type PreviewField } from "~/domain/preview";

import { AT, gradeContent, gradeRemote, held, newDraft, sending, step } from "./fixtures/changes";

const fieldOf = (fields: readonly PreviewField[], field: string): PreviewField => {
  const found = fields.find((candidate) => candidate.field === field);
  if (!found) throw new Error(`No ${field} field.`);
  return found;
};

const LONG =
  "This feedback runs on long enough that a person has to read all of it, and the preview must not shorten or rewrap a word of it.\n\nEven across paragraphs.";

describe("the send preview", () => {
  it("a first grade shows the grade and nothing about a prior one", () => {
    const grade = fieldOf(previewOf(newDraft(), "append"), "grade");
    expect(grade.label).toBe("Grade");
    expect(grade.body).toEqual({ kind: "grade", points: 18, outOf: 100 });
    expect(grade.note).toBeNull();
  });

  it("a resubmission says in one sentence which grade it replaces", () => {
    const grade = fieldOf(
      previewOf(newDraft("ch-1", gradeContent(), gradeRemote({ grade: 58 })), "append"),
      "grade",
    );
    expect(grade.body).toEqual({ kind: "grade", points: 18, outOf: 100 });
    expect(grade.note).toBe("Replaces the 58 / 100 now in the LMS.");
  });

  it("a grade that matches the LMS replaces nothing", () => {
    expect(
      fieldOf(
        previewOf(newDraft("ch-1", gradeContent(), gradeRemote({ grade: 18 })), "append"),
        "grade",
      ).note,
    ).toBeNull();
  });

  it("a late penalty shows the grade after the penalty and the arithmetic in words", () => {
    const grade = fieldOf(
      previewOf(
        newDraft("ch-1", gradeContent({ late: { days: 2, pointsPerDay: 2.5, waived: false } })),
        "append",
      ),
      "grade",
    );
    expect(grade.body).toEqual({ kind: "grade", points: 13, outOf: 100 });
    expect(grade.note).toBe("18 points, minus 5 for 2 days late at 2.5 per day.");
  });

  it.each([
    ["a waived penalty", { waived: true }, null, 18, "Late penalty waived."],
    [
      "an override",
      { waived: false },
      15,
      15,
      "Your total, in place of the 18 the scores add up to.",
    ],
  ])("%s shows the total it sends and says why", (_name, late, override, points, note) => {
    const content = gradeContent({ late: { days: 2, pointsPerDay: 2.5, ...late }, override });
    const grade = fieldOf(previewOf(newDraft("ch-1", content), "append"), "grade");
    expect(grade.body).toEqual({ kind: "grade", points, outOf: 100 });
    expect(grade.note).toBe(note);
  });

  it("each rubric score shows with its rating and no earlier value", () => {
    const rubric = fieldOf(previewOf(newDraft(), "append"), "rubric");
    expect(rubric.label).toBe("Rubric scores");
    expect(rubric.body).toEqual({
      kind: "rubric",
      rows: [
        {
          criterion: "lcc:criterion:2:thesis",
          name: "Thesis",
          points: 18,
          outOf: 25,
          rating: "Developing",
        },
      ],
    });
    expect(JSON.stringify(rubric)).not.toContain("none");
  });

  it("feedback shows whole, with its line breaks", () => {
    const comment = fieldOf(
      previewOf(newDraft("ch-1", gradeContent({ comment: LONG })), "append"),
      "comment",
    );
    expect(comment.label).toBe("Feedback");
    expect(comment.body).toEqual({ kind: "text", title: null, text: LONG });
  });

  it("says earlier feedback stays when the LMS adds a comment", () => {
    const remote = gradeRemote({ comments: [{ id: "c1", mine: true, text: "First pass." }] });
    expect(
      fieldOf(previewOf(newDraft("ch-1", gradeContent(), remote), "append"), "comment").note,
    ).toBe("Your earlier comments stay on the submission.");
  });

  it("says earlier feedback goes when the LMS replaces it", () => {
    const remote = gradeRemote({ comments: [{ id: "c1", mine: true, text: "First pass." }] });
    expect(
      fieldOf(previewOf(newDraft("ch-1", gradeContent(), remote), "replace"), "comment").note,
    ).toBe("Replaces your earlier feedback on the submission.");
  });

  it("someone else's comment gets no note", () => {
    const remote = gradeRemote({ comments: [{ id: "c1", mine: false, text: "From the TA." }] });
    expect(
      fieldOf(previewOf(newDraft("ch-1", gradeContent(), remote), "append"), "comment").note,
    ).toBeNull();
  });

  it("an attachment shows its name and size", () => {
    const attachment = fieldOf(
      previewOf(
        newDraft("ch-1", gradeContent({ attachment: { name: "notes.pdf", kb: 200 } })),
        "append",
      ),
      "attachment",
    );
    expect(attachment.body).toEqual({ kind: "attachment", name: "notes.pdf", kb: 200 });
  });

  it("a reply shows its text", () => {
    const content = {
      kind: "reply",
      target: "lcc:conversation:1",
      body: "See you Tuesday.",
    } as ChangeContent;
    const [field] = previewOf(
      newDraft("ch-1", content, { kind: "reply", targetVersion: "1", messages: [] }),
      "append",
    );
    expect(field?.label).toBe("Reply");
    expect(field?.body).toEqual({ kind: "text", title: null, text: "See you Tuesday." });
  });

  it("an announcement shows its title and body", () => {
    const content = {
      kind: "announcement",
      target: "lcc:course:1",
      title: "Week 10",
      body: "Class moves to room 204.",
    } as ChangeContent;
    const [field] = previewOf(
      newDraft("ch-1", content, { kind: "announcement", targetVersion: "1", posts: [] }),
      "append",
    );
    expect(field?.label).toBe("Announcement");
    expect(field?.body).toEqual({
      kind: "text",
      title: "Week 10",
      text: "Class moves to room 204.",
    });
  });

  it("each field reports its own status during a run", () => {
    const record = step(sending(), {
      type: "field-outcomes",
      outcomes: {
        grade: { status: "landed", at: AT, via: "response" },
        comment: { status: "unknown", since: AT },
      },
      at: AT,
    });
    const fields = previewOf(record, "append");
    expect(fieldOf(fields, "grade").status).toBe("landed");
    expect(fieldOf(fields, "comment").status).toBe("unknown");
    expect(fieldOf(fields, "rubric").status).toBe("sending");
  });

  it("an edit after a partial send shows the new value, ready to approve again", () => {
    const partly = held(
      step(sending(), {
        type: "field-outcomes",
        outcomes: {
          grade: { status: "landed", at: AT, via: "response" },
          comment: { status: "failed", error: { kind: "unavailable", status: 500 } },
        },
        at: AT,
      }),
    );
    const edited = step(partly, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", rubricPoints: { "lcc:criterion:2:thesis": 22 } },
      at: AT,
    });
    expect(edited.state.tag).toBe("draft");
    const grade = fieldOf(previewOf(edited, "append"), "grade");
    expect(grade.status).toBe("proposed");
    expect(grade.body).toEqual({ kind: "grade", points: 22, outOf: 100 });
  });

  it("a field that already landed has no note about what it replaces", () => {
    const partly = held(
      step(sending(), {
        type: "field-outcomes",
        outcomes: { comment: { status: "landed", at: AT, via: "response" } },
        at: AT,
      }),
    );
    const revoked = step(partly, { type: "revoke", at: AT });
    const comment = fieldOf(previewOf(revoked, "append"), "comment");
    expect(comment.status).toBe("landed");
    expect(comment.note).toBeNull();
  });
});
