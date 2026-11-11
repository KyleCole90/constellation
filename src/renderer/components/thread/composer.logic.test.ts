import { describe, expect, it } from "vite-plus/test";

import type { GradeContent, RubricScore } from "~/shared/domain/change";

import { composerHints } from "./composer.logic";

const score = { name: "Thesis and claim", points: 22, outOf: 25 } as RubricScore;
const grade = (rubric: readonly RubricScore[] | null) =>
  ({ kind: "grade", rubric, outOf: 100 }) as GradeContent;

describe("composerHints", () => {
  it("a graded draft's examples touch only the comment, so none offers a score the agent didn't give", () => {
    for (const rubric of [[score], null])
      expect(
        composerHints({ kind: "grading", content: grade(rubric), canEdit: true }).examples,
      ).toEqual(["Drop the last sentence", "Make it warmer"]);
  });

  it("a change that can't be edited offers no examples the agent would have to refuse", () => {
    expect(
      composerHints({ kind: "grading", content: grade([score]), canEdit: false }).examples,
    ).toEqual([]);
  });

  it("a reply doesn't suggest rubric changes", () => {
    expect(
      composerHints({ kind: "messages", content: { kind: "reply" } as never, canEdit: true })
        .examples,
    ).toEqual(["Make it shorter", "Make it warmer"]);
  });

  it("an open conversation with no draft doesn't ask you to open a message", () => {
    const hint = (conversation?: "unanswered" | "answered") =>
      composerHints({ kind: "messages", content: null, canEdit: false, conversation }).placeholder;
    expect(hint()).toBe("Open a message and I'll draft a reply");
    expect(hint("unanswered")).toBe("Draft a reply, then correct it here");
    expect(hint("answered")).toBe("You answered this one. Open another message to reply");
  });

  it("an announcement thread with no draft says what to do instead of naming the agent", () => {
    const { placeholder } = composerHints({ kind: "announcement", content: null, canEdit: false });
    expect(placeholder).toBe("Start the draft, then correct it here");
    expect(
      composerHints({ kind: "general", content: null, canEdit: false }).placeholder,
    ).not.toContain("agent");
  });

  it("a setup thread only mentions findings once there are findings to ask about", () => {
    expect(
      composerHints({ kind: "setup", content: null, canEdit: false, setupStep: "dates" })
        .placeholder,
    ).not.toContain("finding");
    expect(
      composerHints({ kind: "setup", content: null, canEdit: false, setupStep: "review" })
        .placeholder,
    ).toContain("finding");
  });

  it("the queue with nothing open points at the rows and offers no corrections", () => {
    const hints = composerHints({ kind: "queue", content: null, canEdit: false });
    expect(hints.placeholder).toContain("Open a submission");
    expect(hints.examples).toEqual([]);
  });
});
