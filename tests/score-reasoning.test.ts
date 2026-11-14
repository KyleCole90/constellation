import { describe, expect, it } from "vite-plus/test";

import { OVERALL_RATIONALE, type ChangeRecord } from "~/shared/domain/change";

import { AT, CRITERION, gradeContent, newDraft, step } from "./fixtures/changes";

const explain = (record: ChangeRecord, field: string, why: string): ChangeRecord =>
  step(record, { type: "annotate", rationale: { field, why, anchors: [] }, at: AT });

const reasons = (record: ChangeRecord) =>
  record.rationale.map(({ field, why }) => ({ field, why }));

describe("a score's reasoning follows the score (#47)", () => {
  const overall = () =>
    explain(
      newDraft("ch-1", gradeContent({ rubric: null, points: 19, outOf: 20 })),
      OVERALL_RATIONALE,
      "19/20. One point off because the chorale is never named.",
    );

  it("a correction that changes the score drops the old score's reasoning", () => {
    const corrected = step(overall(), {
      type: "edit",
      by: "agent",
      patch: { kind: "grade", points: 18 },
      at: AT,
    });
    expect(reasons(corrected)).toEqual([]);
  });

  it("the teacher's own score change drops it too", () => {
    const stepped = step(overall(), {
      type: "edit",
      by: "you",
      patch: { kind: "grade", points: 18 },
      at: AT,
    });
    expect(reasons(stepped)).toEqual([]);
  });

  it("new reasoning after the correction is what the card shows", () => {
    const corrected = explain(
      step(overall(), { type: "edit", by: "agent", patch: { kind: "grade", points: 18 }, at: AT }),
      OVERALL_RATIONALE,
      "18/20. Name the chorale next time.",
    );
    expect(reasons(corrected)).toEqual([
      { field: OVERALL_RATIONALE, why: "18/20. Name the chorale next time." },
    ]);
  });

  it("a comment-only correction keeps the reasoning", () => {
    const record = overall();
    const edited = step(record, {
      type: "edit",
      by: "agent",
      patch: { kind: "grade", comment: "Warmer now." },
      at: AT,
    });
    expect(reasons(edited)).toEqual(reasons(record));
  });

  it("a rubric correction drops only the moved criterion's reasoning", () => {
    const other = "lcc:criterion:2:evidence";
    const record = explain(
      explain(
        newDraft(
          "ch-2",
          gradeContent({
            rubric: [
              { criterion: CRITERION, name: "Thesis", points: 18, outOf: 25 },
              { criterion: other as typeof CRITERION, name: "Evidence", points: 20, outOf: 25 },
            ],
          }),
        ),
        CRITERION,
        "18/25 for the thesis.",
      ),
      other,
      "20/25 for the evidence.",
    );
    const corrected = step(record, {
      type: "edit",
      by: "agent",
      patch: { kind: "grade", rubricPoints: { [CRITERION]: 15 } },
      at: AT,
    });
    expect(reasons(corrected)).toEqual([{ field: other, why: "20/25 for the evidence." }]);
  });
});
