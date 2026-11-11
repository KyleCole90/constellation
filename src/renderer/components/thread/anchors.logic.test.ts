import { describe, expect, it } from "vite-plus/test";

import {
  criterionHue,
  criterionNumbers,
  marksByParagraph,
  nextCriterion,
  segmentParagraph,
} from "./anchors.logic";

const TEXT = "abcdefghij";

describe("segmentParagraph", () => {
  it("text with no marks stays one plain segment", () => {
    expect(segmentParagraph(TEXT, [])).toEqual([{ text: TEXT, start: 0, keys: [], opens: [] }]);
  });

  it("two overlapping anchors split into three spans, the middle one carrying both", () => {
    const segments = segmentParagraph(TEXT, [
      { key: "a", start: 0, end: 6 },
      { key: "b", start: 3, end: 9 },
    ]);
    expect(segments.map((s) => [s.text, s.keys])).toEqual([
      ["abc", ["a"]],
      ["def", ["a", "b"]],
      ["ghi", ["b"]],
      ["j", []],
    ]);
  });

  it("an anchor nested inside another still splits cleanly", () => {
    const segments = segmentParagraph(TEXT, [
      { key: "a", start: 0, end: 10 },
      { key: "b", start: 4, end: 6 },
    ]);
    expect(segments.map((s) => s.keys)).toEqual([["a"], ["a", "b"], ["a"]]);
  });

  it("a passage split by an overlap opens once, at its first run", () => {
    const segments = segmentParagraph(TEXT, [
      { key: "a", start: 0, end: 6 },
      { key: "b", start: 3, end: 9 },
    ]);
    expect(segments.map((s) => s.opens)).toEqual([["a"], ["b"], [], []]);
  });

  it("every character survives, whatever the anchors do", () => {
    const segments = segmentParagraph(TEXT, [
      { key: "a", start: -5, end: 3 },
      { key: "b", start: 2, end: 99 },
      { key: "c", start: 7, end: 7 },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(TEXT);
  });

  it("an empty or backwards anchor highlights nothing", () => {
    expect(
      segmentParagraph(TEXT, [
        { key: "a", start: 5, end: 5 },
        { key: "b", start: 8, end: 2 },
      ]).every((s) => s.keys.length === 0),
    ).toBe(true);
  });

  it("the same criterion twice over one run lists it once", () => {
    expect(
      segmentParagraph("abc", [
        { key: "a", start: 0, end: 3 },
        { key: "a", start: 0, end: 3 },
      ])[0]?.keys,
    ).toEqual(["a"]);
  });
});

describe("marksByParagraph", () => {
  it("groups anchors by paragraph and keeps the criterion", () => {
    const marks = marksByParagraph([
      { field: "x", why: "", anchors: [{ paragraph: 1, start: 0, end: 2 }] },
      {
        field: "y",
        why: "",
        anchors: [
          { paragraph: 1, start: 1, end: 3 },
          { paragraph: 2, start: 0, end: 1 },
        ],
      },
    ]);
    expect(marks.get(1)?.map((m) => m.key)).toEqual(["x", "y"]);
    expect(marks.get(2)?.map((m) => m.key)).toEqual(["y"]);
  });
});

describe("nextCriterion", () => {
  it("starts at the first and cycles round an overlap", () => {
    expect(nextCriterion(["a", "b"], null)).toBe("a");
    expect(nextCriterion(["a", "b"], "a")).toBe("b");
    expect(nextCriterion(["a", "b"], "b")).toBe("a");
  });

  it("a selection from elsewhere starts over", () => {
    expect(nextCriterion(["a", "b"], "z")).toBe("a");
  });
});

describe("criterionNumbers", () => {
  it("numbers only criteria with a passage, in rubric order and without gaps", () => {
    const anchor = { paragraph: 0, start: 0, end: 1 };
    const rationale = [
      { field: "c", why: "", anchors: [anchor] },
      { field: "b", why: "", anchors: [] },
      { field: "a", why: "", anchors: [anchor] },
    ] as never;
    expect([...criterionNumbers(["a", "b", "c"], rationale)]).toEqual([
      ["a", 1],
      ["c", 2],
    ]);
  });
});

describe("criterionHue", () => {
  it("gives each of the first four numbers its own hue, then wraps", () => {
    expect([1, 2, 3, 4].map(criterionHue)).toEqual([
      "var(--crit-1)",
      "var(--crit-2)",
      "var(--crit-3)",
      "var(--crit-4)",
    ]);
    expect(criterionHue(5)).toBe("var(--crit-1)");
  });
});
