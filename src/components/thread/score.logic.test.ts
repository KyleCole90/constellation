import { describe, expect, it } from "vite-plus/test";

import { parseScore, stepScore } from "./score.logic";

describe("parseScore", () => {
  it("reads a whole or part score within the range", () => {
    expect(parseScore("18", 25)).toBe(18);
    expect(parseScore(" 7.5 ", 25)).toBe(7.5);
    expect(parseScore("25", 25)).toBe(25);
  });

  it("reads a typed 0 as a real score", () => {
    expect(parseScore("0", 25)).toBe(0);
  });

  it("holds a typed number inside the range", () => {
    expect(parseScore("26", 25)).toBe(25);
    expect(parseScore("-3", 25)).toBe(0);
  });

  it("gives null for empty text and words", () => {
    for (const text of ["", "   ", "abc", "-", "Infinity", "1e1", "0x5"])
      expect(parseScore(text, 25)).toBeNull();
  });
});

describe("stepScore", () => {
  it("starts an unset score at 0", () => {
    expect(stepScore(null, 1, 25)).toBe(0);
  });

  it("moves a score by one", () => {
    expect(stepScore(7, 1, 25)).toBe(8);
    expect(stepScore(7, -1, 25)).toBe(6);
  });

  it("holds a part score inside the range at both ends", () => {
    expect(stepScore(0.5, -1, 25)).toBe(0);
    expect(stepScore(24.5, 1, 25)).toBe(25);
  });

  it("has no float noise after a step from a part score", () => {
    expect(stepScore(1.1, -1, 25)).toBe(0.1);
    expect(stepScore(2.2, -1, 25)).toBe(1.2);
  });
});
