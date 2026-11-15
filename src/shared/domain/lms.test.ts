import { describe, expect, it } from "vite-plus/test";

import { resubmitted, type Submission } from "./lms";

type Work = Pick<Submission, "workflow" | "attempt" | "grade">;
const graded: Work = { workflow: "graded", attempt: 4, grade: 11 };
const work = (patch: Partial<Work>): Work => ({ ...graded, ...patch });

describe("resubmitted (#133)", () => {
  it("a grade on the current attempt is not a resubmission, however many attempts came before", () => {
    expect(resubmitted(graded)).toBe(false);
  });

  it("an attempt turned in after the grade is, and the LMS reopens it as submitted with the old grade", () => {
    expect(resubmitted(work({ workflow: "submitted", attempt: 5 }))).toBe(true);
  });

  it("first work with no grade yet is not", () => {
    expect(resubmitted(work({ workflow: "submitted", attempt: 1, grade: null }))).toBe(false);
  });
});
