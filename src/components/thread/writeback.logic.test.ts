import { describe, expect, it } from "vite-plus/test";

import type { FieldConflict, FieldKey } from "~/domain/change";
import type { PreviewField } from "~/domain/preview";

import {
  approvalResetWords,
  conflictColumns,
  conflictOptions,
  fieldChip,
  fieldCount,
  lastOutsideNote,
  missingWords,
  outcomeWords,
  previewHeading,
  retryRemainingLabel,
} from "./writeback.logic";

const file = (
  field: FieldKey,
  status: PreviewField["status"],
  label: string = field,
): PreviewField => ({
  field,
  label,
  status,
  body: { kind: "text", title: null, text: "" },
  note: null,
});
const conflict = (reason: FieldConflict["reason"]): FieldConflict => ({
  field: "grade",
  reason,
  basis: "70",
  theirs: "65",
  mine: "80",
});

describe("what a form with blanks asks for", () => {
  it("names one blank, two, and more", () => {
    expect(missingWords(["Score"])).toBe("Fill in Score to approve.");
    expect(missingWords(["Title", "Announcement"])).toBe(
      "Fill in Title and Announcement to approve.",
    );
    expect(missingWords(["Thesis", "Evidence", "Style"])).toBe(
      "Fill in Thesis, Evidence and Style to approve.",
    );
  });
});

describe("the preview heading", () => {
  it("says what the panel is showing at each stage", () => {
    expect(previewHeading([file("grade", "proposed")], false, "lms.example")).toBe(
      "What will be sent to lms.example",
    );
    expect(
      previewHeading([file("grade", "landed"), file("comment", "failed")], false, "lms.example"),
    ).toBe("Partly sent to lms.example");
    expect(previewHeading([file("grade", "landed")], true, "lms.example")).toBe(
      "What was sent to lms.example",
    );
  });
});

describe("outcomeWords", () => {
  it("a partial send says what landed and what did not, in words", () => {
    expect(outcomeWords([file("grade", "landed"), file("comment", "failed")])).toBe(
      "Grade is in the gradebook. The feedback did not post.",
    );
  });

  it("an unconfirmed field never reads as failed", () => {
    expect(outcomeWords([file("comment", "unknown")])).toBe(
      "We can't confirm the feedback posted.",
    );
  });
});

describe("retryRemainingLabel", () => {
  it("names only what is left", () => {
    expect(
      retryRemainingLabel([
        file("grade", "landed", "Grade"),
        file("comment", "failed", "Comment"),
        file("attachment", "failed", "Attachment"),
      ]),
    ).toBe("Retry remaining: Comment, Attachment");
  });
});

describe("fieldChip", () => {
  const sending = { tone: "working", banner: null } as const;
  const held = { tone: "attention", banner: "partial" } as const;
  const draft = { tone: "approval", banner: null } as const;

  it("shows nothing before a send has started", () => {
    expect(fieldChip("proposed", draft)).toBeNull();
  });

  it("a failure during a send is still being retried", () => {
    expect(fieldChip("failed", sending)?.label).toBe("Retrying");
  });

  it("a failure at rest reads as failed", () => {
    expect(fieldChip("failed", held)?.label).toBe("Failed");
  });

  it("a field held back says it was not written", () => {
    expect(fieldChip("proposed", held)?.label).toBe("Not written");
  });
});

describe("approvalResetWords", () => {
  it("names who reset it", () => {
    expect(approvalResetWords("edited")).toContain("You edited");
    expect(approvalResetWords("agent-edited")).toContain("The agent edited");
  });

  it("says nothing for a fresh draft", () => {
    expect(approvalResetWords(null)).toBeNull();
  });
});

describe("conflictOptions", () => {
  it("only a possible own write can be called already there", () => {
    expect(conflictOptions(conflict("changed-by-other")).map((o) => o.choice)).toEqual([
      "keep-mine",
      "use-theirs",
    ]);
    expect(conflictOptions(conflict("possible-own-write")).map((o) => o.choice)).toEqual([
      "keep-mine",
      "use-theirs",
      "it-landed",
    ]);
  });
});

describe("conflictColumns", () => {
  it("gives what the draft saw, what is there now, and what you propose", () => {
    expect(conflictColumns(conflict("changed-by-other"))).toMatchObject({
      saw: "70",
      now: "65",
      mine: "80",
    });
  });

  it("a new attempt reads in words rather than version ids", () => {
    expect(conflictColumns(conflict("target-changed"))).toMatchObject({
      saw: "The earlier attempt",
      now: "A newer attempt",
    });
  });

  it("a course copy says the course moved, not that a student submitted", () => {
    const columns = conflictColumns({
      field: "copy",
      reason: "target-changed",
      basis: "students:0|items:0",
      theirs: "students:14|items:3",
      mine: "ENG 101",
    });
    expect(columns.why).toBe(
      "The number of students or items in this course changed after the draft was read.",
    );
    expect(columns).toMatchObject({
      saw: "The course as the draft read it",
      now: "The course as it is now",
    });
  });

  it("an empty side reads as nothing", () => {
    expect(conflictColumns({ ...conflict("changed-by-other"), basis: null }).saw).toBe("Nothing");
  });
});

describe("lastOutsideNote", () => {
  it("takes the newest comment that isn't ours", () => {
    const comments = [
      { id: "1", mine: false, text: "older", at: "" },
      { id: "2", mine: false, text: "newer", at: "" },
      { id: "3", mine: true, text: "mine", at: "" },
    ] as never;
    expect(lastOutsideNote(comments)).toBe("newer");
  });

  it("is null when nobody else has written", () => {
    expect(lastOutsideNote([])).toBeNull();
  });
});

describe("fieldCount", () => {
  it("handles the singular", () => {
    expect(fieldCount(1)).toBe("1 field");
    expect(fieldCount(3)).toBe("3 fields");
  });
});
