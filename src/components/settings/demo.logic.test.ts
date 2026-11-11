import { describe, expect, it } from "vite-plus/test";

import { dialPatch, dialValue, parseGrade, type Noise } from "./demo.logic";

const NOISE: Noise = { rate429: 0.01, rate5xx: 0.2, rateLost: 0.005, latencyMs: [200, 900] };

describe("the noise dials", () => {
  it("show a rate as a percent, without float dust", () => {
    expect(dialValue(NOISE, "rateLost")).toBe(0.5);
    expect(dialValue({ ...NOISE, rate429: 0.07 }, "rate429")).toBe(7);
  });

  it("write a percent back as a rate and leave the rest alone", () => {
    expect(dialPatch(NOISE, "rate5xx", 25)).toEqual({ rate5xx: 0.25 });
  });

  it("push the other latency end along rather than make an inverted range", () => {
    expect(dialPatch(NOISE, "fastest", 1500)).toEqual({ latencyMs: [1500, 1500] });
    expect(dialPatch(NOISE, "slowest", 100)).toEqual({ latencyMs: [100, 100] });
    expect(dialPatch(NOISE, "slowest", 2000)).toEqual({ latencyMs: [200, 2000] });
  });
});

describe("a typed grade", () => {
  it("accepts zero and decimals", () => {
    expect(parseGrade("0")).toBe(0);
    expect(parseGrade("87.5")).toBe(87.5);
  });

  it("rejects blank, negative, and non-numbers", () => {
    expect(parseGrade("")).toBeNull();
    expect(parseGrade("  ")).toBeNull();
    expect(parseGrade("-1")).toBeNull();
    expect(parseGrade("abc")).toBeNull();
  });
});
