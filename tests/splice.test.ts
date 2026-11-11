import { describe, expect, it } from "vite-plus/test";

import {
  applySplice,
  editableAfter,
  paragraphAfter,
  spliceAt,
  spliceState,
  type Splice,
} from "~/shared/domain/splice";

const at = (body: string, text: string, after: string, from = 0): Splice =>
  spliceAt(body, body.indexOf(text, from), text.length, after);
const applied = (body: string, { prefix, before, after, suffix }: Splice): string =>
  body.replace(prefix + before + suffix, prefix + after + suffix);

describe("spliceState", () => {
  const BODY = "Essay 2 is due Oct 12 at noon. Bring a draft.";
  const fix = at(BODY, "Oct 12", "Mar 15");

  it("is ready while the passage is there once", () => {
    expect(spliceState(BODY, fix)).toBe("ready");
  });

  it("is already-there once it landed, so a retry writes nothing", () => {
    expect(spliceState(applied(BODY, fix), fix)).toBe("already-there");
  });

  it("is ready when only an unrelated part of the body changed", () => {
    expect(spliceState(`Welcome back.\n\n${BODY} Extra words.`, fix)).toBe("ready");
  });

  it("is moved when the passage was rewritten", () => {
    expect(spliceState("Essay 2 is due whenever you like.", fix)).toBe("moved");
  });

  it("is moved when the context now appears twice", () => {
    expect(spliceState(`${BODY}\n\n${BODY}`, fix)).toBe("moved");
  });

  it("stays ready when a look-alike of the new text sits elsewhere", () => {
    const body = "Due Oct 12 now, and also Due Mar 8 now.";
    const look: Splice = { prefix: "Due ", before: "Oct 12", after: "Mar 8", suffix: " now" };
    expect(spliceState(body, look)).toBe("ready");
  });
});

describe("insertion with an empty before", () => {
  const BODY = "Syllabus text.";
  const insert = spliceAt(BODY, BODY.length, 0, "\n\nAccessibility statement.");

  it("is ready, then already-there, even though its context survives the write", () => {
    expect(insert.before).toBe("");
    expect(spliceState(BODY, insert)).toBe("ready");
    expect(spliceState(applied(BODY, insert), insert)).toBe("already-there");
  });

  it("reads as the new paragraph alone", () => {
    expect(paragraphAfter(BODY, insert)).toBe("Accessibility statement.");
  });

  it("keeps its paragraph break when a person rewrites the words", () => {
    const { lead, words } = editableAfter(insert);
    expect(words).toBe("Accessibility statement.");
    const edited = { ...insert, after: lead + "Title IX: contact the office." };
    expect(paragraphAfter(BODY, edited)).toBe("Title IX: contact the office.");
    expect(applySplice(BODY, edited)).toBe("Syllabus text.\n\nTitle IX: contact the office.");
  });

  it("works on an empty body", () => {
    const first = spliceAt("", 0, 0, "Statement.");
    expect(spliceState("", first)).toBe("ready");
    expect(spliceState("Statement.", first)).toBe("already-there");
    expect(spliceState("Something else.", first)).toBe("moved");
  });

  it("two inserts at the same spot do not invalidate each other", () => {
    const other = spliceAt(BODY, BODY.length, 0, "\n\nTitle IX notice.");
    expect(spliceState(applied(BODY, insert), other)).toBe("ready");
  });
});

describe("editableAfter", () => {
  it("leaves a replacement's words whole", () => {
    const body = "Due Oct 12 now.";
    expect(editableAfter(at(body, "Oct 12", "\n\nMar 8"))).toEqual({
      lead: "",
      words: "\n\nMar 8",
    });
  });
});

describe("spliceAt", () => {
  it("grows context until repeated text is unique, and picks the right occurrence", () => {
    const body = "Quiz on Oct 12 in class. Exam on Oct 12 in class.";
    const second = at(body, "Oct 12", "Mar 15", body.indexOf("Exam"));
    expect(spliceState(body, second)).toBe("ready");
    expect(applied(body, second)).toBe("Quiz on Oct 12 in class. Exam on Mar 15 in class.");
  });

  it("uses the whole body when only that tells identical runs apart", () => {
    const body = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const middle = spliceAt(body, 20, 1, "b");
    expect(`${middle.prefix}${middle.before}${middle.suffix}`).toBe(body);
    expect(spliceState(body, middle)).toBe("ready");
  });

  it("stays in its paragraph when that is enough, so a fix next door leaves it valid", () => {
    const body = "Quiz Oct 12.\n\nExam Oct 19.";
    const quiz = at(body, "Oct 12", "Mar 8");
    const exam = at(body, "Oct 19", "Mar 15");
    expect(quiz.suffix).toBe(".");
    expect(spliceState(applied(body, exam), quiz)).toBe("ready");
  });
});

describe("paragraphAfter", () => {
  const BODY = "First paragraph.\n\nEssay 2 is due Oct 12 at noon.\n\nLast paragraph.";

  it("gives the whole paragraph as it will read, before and after it lands", () => {
    const fix = at(BODY, "Oct 12", "Mar 15");
    expect(paragraphAfter(BODY, fix)).toBe("Essay 2 is due Mar 15 at noon.");
    expect(paragraphAfter(applied(BODY, fix), fix)).toBe("Essay 2 is due Mar 15 at noon.");
  });

  it("falls back to the fix's own context when the passage moved", () => {
    const fix = at(BODY, "Oct 12", "Mar 15");
    expect(paragraphAfter("Nothing like it.", fix)).toContain("Mar 15");
  });

  it("reads a deletion", () => {
    expect(paragraphAfter(BODY, at(BODY, " at noon", ""))).toBe("Essay 2 is due Oct 12.");
  });
});
