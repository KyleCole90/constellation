import { describe, expect, it } from "vite-plus/test";

import { excerptNote, type SubmissionBody } from "~/domain/lms";

const text = (wordCount: number, paragraphs: readonly string[]): SubmissionBody => ({
  kind: "text",
  title: "Essay",
  wordCount,
  paragraphs,
});

describe("excerptNote", () => {
  it("says Excerpts when the text holds fewer words than the count claims", () => {
    expect(excerptNote(text(790, ["two paragraphs", "of a longer essay"]))).toBe("Excerpts");
  });

  it("says nothing when the text is all the words the count claims", () => {
    expect(excerptNote(text(5, ["three words here", "and two"]))).toBeNull();
  });

  it("keeps the transcript's wording for a recording, and says nothing when nothing was submitted", () => {
    expect(
      excerptNote({
        kind: "media",
        title: "Speech",
        durationLabel: "4:12",
        transcript: ["a line"],
      }),
    ).toBe("Auto transcript, excerpts");
    expect(excerptNote({ kind: "none" })).toBeNull();
  });
});
