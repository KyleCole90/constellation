import { describe, expect, it } from "vite-plus/test";

import type { DatedItem } from "~/shared/domain/content";
import type { IsoDate, IsoTime, LmsRef } from "~/shared/domain/ids";
import {
  findDateMentions,
  isoDate,
  mentionIsStale,
  moveOutOfBreak,
  planDays,
  planProblems,
  rewriteMention,
  shiftDate,
  shiftOptionsOf,
  shiftPreview,
  weekdayOf,
  type DateShiftOptions,
  type TermPlan,
  type Weekday,
} from "~/shared/domain/term";

const d = (text: string): IsoDate => text as IsoDate;
const SPRING_BREAK = { name: "Spring break", start: d("2027-03-08"), end: d("2027-03-12") };
const PLAN: TermPlan = {
  oldTerm: { name: "Fall 2026", start: d("2026-08-24"), end: d("2026-12-11"), days: [2, 4] },
  newTerm: { name: "Spring 2027", start: d("2027-01-19"), end: d("2027-05-07"), days: [1, 3] },
  breaks: [SPRING_BREAK],
};
const OPTIONS = shiftOptionsOf(PLAN);
const withBreaks = (...breaks: TermPlan["breaks"]): TermPlan => ({ ...PLAN, breaks });
const span = (
  oldStart: string,
  oldEnd: string,
  newStart: string,
  newEnd: string,
  substitutions: DateShiftOptions["substitutions"] = {},
): DateShiftOptions => ({
  oldStart: d(oldStart),
  oldEnd: d(oldEnd),
  newStart: d(newStart),
  newEnd: d(newEnd),
  substitutions,
});
const onPlan = (text: string): string => {
  const [mention] = findDateMentions(text, PLAN.oldTerm);
  if (!mention) throw new Error(`No mention in ${text}`);
  return rewriteMention(mention, moveOutOfBreak(shiftDate(mention.date, OPTIONS), PLAN).date);
};

describe("the worked case", () => {
  it("Tue 2026-10-13 goes to Mon 2027-03-08, then out of the break to Mon 2027-03-15, flagged", () => {
    const shifted = shiftDate(d("2026-10-13"), { ...OPTIONS, substitutions: { 2: 1 } });
    expect(shifted).toBe("2027-03-08");
    expect(moveOutOfBreak(shifted, PLAN)).toEqual({
      date: "2027-03-15",
      movedFrom: SPRING_BREAK,
      outsideTerm: false,
    });
  });

  it("shiftPreview shows both what the LMS will do and where the break move puts it", () => {
    const item: DatedItem = {
      ref: "item:1" as LmsRef<"item">,
      title: "Essay 2",
      dueAt: "2026-10-13T23:59:00Z" as IsoTime,
    };
    expect(shiftPreview([item], PLAN)).toEqual([
      {
        item,
        from: "2026-10-13",
        shifted: "2027-03-08",
        date: "2027-03-15",
        movedFrom: SPRING_BREAK,
        outsideTerm: false,
      },
    ]);
  });
});

describe("shiftDate against the LMS's own formula", () => {
  // Expected values came from an independent port of the Ruby method, run outside this codebase. They are not this module's output.
  it.each([
    ["2026-08-24", "2027-01-25"],
    ["2026-08-25", "2027-01-25"],
    ["2026-08-27", "2027-01-20"],
    ["2026-09-15", "2027-02-08"],
    ["2026-09-18", "2027-02-12"],
    ["2026-10-12", "2027-03-08"],
    ["2026-10-13", "2027-03-08"],
    ["2026-10-15", "2027-03-10"],
    ["2026-11-06", "2027-04-02"],
    ["2026-11-24", "2027-04-19"],
    ["2026-12-10", "2027-05-05"],
    ["2026-12-11", "2027-05-07"],
  ])("Fall 2026 %s becomes %s on the Tue/Thu to Mon/Wed plan", (from, to) => {
    expect(shiftDate(d(from), OPTIONS)).toBe(to);
  });

  it("Spring 2026 to Spring 2027 agrees too", () => {
    expect(
      shiftDate(
        d("2026-03-03"),
        span("2026-01-20", "2026-05-08", "2027-01-19", "2027-05-07", { 2: 1, 4: 3 }),
      ),
    ).toBe("2027-03-01");
  });

  it("leaves a date alone when the proportion already landed on the wanted weekday, instead of going back a week", () => {
    expect(shiftDate(d("2026-12-11"), OPTIONS)).toBe("2027-05-07");
  });

  it("does not clamp: a date past the old end lands past the new end", () => {
    expect(shiftDate(d("2026-12-25"), OPTIONS) > PLAN.newTerm.end).toBe(true);
  });
});

describe("meeting days", () => {
  it("moves every Tue to a Mon and every Thu to a Wed across a whole term, all inside it", () => {
    for (let day = Date.parse("2026-08-24"); day <= Date.parse("2026-12-11"); day += 86_400_000) {
      const date = d(new Date(day).toISOString().slice(0, 10));
      const weekday = weekdayOf(date);
      if (weekday !== 2 && weekday !== 4) continue;
      const shifted = shiftDate(date, OPTIONS);
      expect(weekdayOf(shifted)).toBe(weekday === 2 ? 1 : 3);
      expect(shifted >= PLAN.newTerm.start && shifted <= PLAN.newTerm.end).toBe(true);
    }
  });

  it("a Friday deadline stays a Friday", () => {
    for (const friday of ["2026-09-18", "2026-11-06", "2026-12-11"])
      expect(weekdayOf(shiftDate(d(friday), OPTIONS))).toBe(5);
  });

  it("a weekday absent from substitutions keeps its weekday, the same as mapping it to itself", () => {
    const absent = span("2026-08-24", "2026-12-11", "2027-01-19", "2027-05-07");
    expect(shiftDate(d("2026-09-18"), absent)).toBe("2027-02-12");
    expect(shiftDate(d("2026-09-18"), { ...absent, substitutions: { 5: 5 } })).toBe("2027-02-12");
  });

  it("planDays is total over the week and leaves non-meeting days alone", () => {
    expect(planDays([2, 4], [1, 3])).toEqual({ 0: 0, 1: 1, 2: 1, 3: 3, 4: 3, 5: 5, 6: 6 });
  });

  it("planDays repeats the last new day when the new pattern is shorter", () => {
    expect(planDays([1, 3, 5], [2])).toEqual({ 0: 0, 1: 2, 2: 2, 3: 2, 4: 4, 5: 2, 6: 6 });
    const once = { ...OPTIONS, substitutions: planDays([2, 4], [1]) };
    expect(shiftDate(d("2026-10-13"), once)).toBe("2027-03-08");
    expect(shiftDate(d("2026-10-15"), once)).toBe("2027-03-08");
  });

  it("planDays ignores the order the days were picked in, and drops extra new days", () => {
    const picked: readonly Weekday[] = [4, 2];
    expect(planDays(picked, [3, 1])).toEqual(planDays([2, 4], [1, 3]));
    expect(planDays([2], [1, 3])[2]).toBe(1);
  });

  it("with no new meeting days, every day keeps its weekday", () => {
    expect(planDays([2, 4], [])[2]).toBe(2);
  });
});

describe("edges of the formula", () => {
  it("an empty old span sends everything to the start of the new term, then to the wanted weekday", () => {
    expect(
      shiftDate(
        d("2026-10-13"),
        span("2026-09-01", "2026-09-01", "2027-01-19", "2027-05-07", { 2: 1 }),
      ),
    ).toBe("2027-01-25");
  });

  it("rounds a half away from zero for an item before the old start, where Math.round would give a week later", () => {
    expect(
      shiftDate(
        d("2026-08-31"),
        span("2026-09-01", "2026-09-11", "2027-01-04", "2027-01-09", { 1: 0 }),
      ),
    ).toBe("2027-01-03");
  });
});

describe("moveOutOfBreak", () => {
  it("leaves a date outside any break alone", () => {
    expect(moveOutOfBreak(d("2027-02-10"), PLAN)).toEqual({
      date: "2027-02-10",
      movedFrom: null,
      outsideTerm: false,
    });
  });

  it("moves to the last class day before a break at the end of term, since after would leave the term", () => {
    const finals = { name: "Finals break", start: d("2027-05-03"), end: d("2027-05-07") };
    expect(moveOutOfBreak(d("2027-05-05"), withBreaks(finals))).toEqual({
      date: "2027-04-28",
      movedFrom: finals,
      outsideTerm: false,
    });
  });

  it("skips a second break that starts right after the first", () => {
    const next = { name: "Reading week", start: d("2027-03-13"), end: d("2027-03-19") };
    expect(moveOutOfBreak(d("2027-03-10"), withBreaks(SPRING_BREAK, next)).date).toBe("2027-03-22");
  });

  it("stays put and says so when the term has no class day to move to", () => {
    const noDays = { ...withBreaks(SPRING_BREAK), newTerm: { ...PLAN.newTerm, days: [] } };
    expect(moveOutOfBreak(d("2027-03-10"), noDays)).toEqual({
      date: "2027-03-10",
      movedFrom: null,
      outsideTerm: false,
    });
  });

  it("reports a date past the end of the term", () => {
    expect(moveOutOfBreak(d("2027-06-01"), PLAN)).toEqual({
      date: "2027-06-01",
      movedFrom: null,
      outsideTerm: true,
    });
  });
});

describe("planProblems", () => {
  it("passes a good plan", () => {
    expect(planProblems(PLAN)).toEqual([]);
  });

  it.each<[string, TermPlan]>([
    ["reversed old term", { ...PLAN, oldTerm: { ...PLAN.oldTerm, end: d("2026-01-01") } }],
    ["empty old span", { ...PLAN, oldTerm: { ...PLAN.oldTerm, end: PLAN.oldTerm.start } }],
    ["reversed new term", { ...withBreaks(), newTerm: { ...PLAN.newTerm, end: d("2027-01-01") } }],
    ["no new meeting days", { ...PLAN, newTerm: { ...PLAN.newTerm, days: [] } }],
    ["reversed break", withBreaks({ ...SPRING_BREAK, end: d("2027-03-01") })],
    [
      "break outside the term",
      withBreaks({ ...SPRING_BREAK, start: d("2027-06-01"), end: d("2027-06-05") }),
    ],
  ])("refuses a %s", (_, plan) => {
    expect(planProblems(plan)).toHaveLength(1);
  });
});

describe("date mentions", () => {
  it.each([
    ["Tuesday, October 13", "Monday, March 15"],
    ["October 12", "March 15"],
    ["Oct 12", "Mar 15"],
    ["Oct. 12th", "Mar. 15th"],
    ["10/12", "3/15"],
    ["Tue 10/13", "Mon 3/15"],
    ["10/12/2026", "3/15/2027"],
    ["10/12/26", "3/15/27"],
    ["October 12, 2026", "March 15, 2027"],
    ["Friday, September 18", "Friday, February 12"],
    ["Sep 18", "Feb 12"],
  ])("rewrites %s as %s", (before, after) => {
    expect(onPlan(`Due ${before} at noon.`)).toBe(after);
  });

  it("leaves the words around a mention out of it", () => {
    const [mention] = findDateMentions("Week 3, Oct 12: bring a draft.", PLAN.oldTerm);
    expect(mention).toMatchObject({ index: 8, length: 6, text: "Oct 12" });
  });

  it.each(["/courses/10/12", "Feb 30", "Oct 123", "may 12", "13/40"])(
    "does not read %s as a date",
    (text) => {
      expect(findDateMentions(text, PLAN.oldTerm)).toEqual([]);
    },
  );

  it("reads a year-less date in the year that puts it nearest the term", () => {
    expect(findDateMentions("Oct 12", PLAN.oldTerm)[0]?.date).toBe("2026-10-12");
    expect(findDateMentions("Jan 5", PLAN.oldTerm)[0]?.date).toBe("2027-01-05");
    expect(
      findDateMentions("Dec 15", { start: d("2026-01-20"), end: d("2026-05-08") })[0]?.date,
    ).toBe("2025-12-15");
  });

  it("marks a range, whose second day it cannot rewrite", () => {
    expect(findDateMentions("Oct 12-14", PLAN.oldTerm)[0]?.range).toBe(true);
    expect(
      findDateMentions("Oct 12 - Oct 14", PLAN.oldTerm).map((mention) => mention.range),
    ).toEqual([false, false]);
  });

  it("isoDate refuses what is not a real day", () => {
    expect(isoDate("2026-02-30")).toBeNull();
    expect(isoDate("10/12")).toBeNull();
    expect(isoDate("2026-10-12")).toBe("2026-10-12");
  });

  const stale = (text: string): boolean => {
    const [mention] = findDateMentions(text, PLAN.oldTerm);
    if (!mention) throw new Error(`No mention in ${text}`);
    return mentionIsStale(mention, PLAN);
  };

  it.each([
    ["Oct 12", true],
    ["Aug 20", true],
    ["Mar 15", false],
    ["8/10", false],
    ["10/12", true],
    ["October 12, 2026", true],
    ["March 15, 2027", false],
    ["October 12, 1999", false],
  ])("%s reading as old is %s", (text, expected) => {
    expect(stale(text)).toBe(expected);
  });
});
