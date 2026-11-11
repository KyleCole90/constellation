import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SchoolId } from "~/shared/domain/ids";
import type { DueItem } from "~/renderer/stores/selectors";

import {
  calendarDays,
  calendarSearch,
  calendarSummary,
  calendarView,
  LANE_WIDTH,
  MIN_DAY_WIDTH,
  nextDue,
  parseCalendarSearch,
  rangeLabel,
  toneOf,
  weekOf,
  weeksThatFit,
  wideLaneFits,
} from "./calendar.logic";

const SIDEBAR = 288;
const RAIL = 48;
const PANEL = 280;
const FRIDAY = new Date(2026, 9, 30).getTime();
const SUNDAY = new Date(2026, 9, 25).getTime();

const item = (fields: Partial<DueItem>) => ({ toGrade: 0, days: 0, ...fields }) as DueItem;
const dates = (today: number, week: number, weeks: 1 | 2) =>
  calendarDays(today, week, weeks).map((day) => `${day.date.getMonth() + 1}/${day.date.getDate()}`);

describe("weeksThatFit", () => {
  it("shows one week at 1440 with the sidebar open, and two weeks at 1680", () => {
    expect(weeksThatFit(1440 - SIDEBAR)).toBe(1);
    expect(weeksThatFit(1680 - SIDEBAR)).toBe(2);
  });

  it("shows one week at 1180, even with the sidebar folded to its rail", () => {
    expect(weeksThatFit(1180 - SIDEBAR)).toBe(1);
    expect(weeksThatFit(1180 - RAIL)).toBe(1);
  });

  it("drops to one week when the day panel opens at 1680", () => {
    expect(weeksThatFit(1680 - SIDEBAR - PANEL)).toBe(1);
  });

  it("turns over exactly where a day column reaches its minimum", () => {
    expect(weeksThatFit(LANE_WIDTH + 14 * MIN_DAY_WIDTH)).toBe(2);
    expect(weeksThatFit(LANE_WIDTH + 14 * MIN_DAY_WIDTH - 1)).toBe(1);
  });
});

describe("wideLaneFits", () => {
  it("drops the wide lane at 1280 with the day panel open, so a day keeps room for its longest word", () => {
    expect(wideLaneFits(1280 - SIDEBAR)).toBe(true);
    expect(wideLaneFits(1280 - SIDEBAR - PANEL)).toBe(false);
    expect(wideLaneFits(1440 - SIDEBAR - PANEL)).toBe(true);
  });
});

describe("calendarDays", () => {
  it("week 0 runs from the Sunday before today to the Saturday after", () => {
    expect(dates(FRIDAY, 0, 1)).toEqual([
      "10/25",
      "10/26",
      "10/27",
      "10/28",
      "10/29",
      "10/30",
      "10/31",
    ]);
  });

  it("offsets count from today and match the day they name", () => {
    expect(calendarDays(FRIDAY, 0, 1).map((day) => day.daysFromToday)).toEqual([
      -5, -4, -3, -2, -1, 0, 1,
    ]);
    expect(
      calendarDays(FRIDAY, 0, 1)
        .filter((day) => day.isToday)
        .map((day) => day.date.getDate()),
    ).toEqual([30]);
  });

  it("marks Sunday and Saturday as the weekend", () => {
    expect(calendarDays(FRIDAY, 0, 1).map((day) => day.isWeekend)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("moves by whole weeks in both directions and across a month end", () => {
    expect(dates(FRIDAY, 1, 1)[0]).toBe("11/1");
    expect(dates(FRIDAY, -1, 1)[0]).toBe("10/18");
    expect(dates(FRIDAY, 0, 2)).toHaveLength(14);
    expect(dates(FRIDAY, 0, 2).at(-1)).toBe("11/7");
  });

  it("no week holds today except week 0", () => {
    expect(calendarDays(FRIDAY, 1, 2).some((day) => day.isToday)).toBe(false);
    expect(calendarDays(FRIDAY, -1, 1).some((day) => day.isToday)).toBe(false);
  });

  describe("across a clock change", () => {
    beforeEach(() => {
      vi.stubEnv("TZ", "America/Chicago");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("the long Sunday in November still gives one date per day at midnight", () => {
      const before = new Date(2026, 9, 31);
      const after = new Date(2026, 10, 2);
      expect(before.getTimezoneOffset()).not.toBe(after.getTimezoneOffset());
      const days = calendarDays(before.getTime(), 1, 2);
      expect(days.map((day) => day.date.getDate()).slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(days.every((day) => day.date.getHours() === 0)).toBe(true);
    });

    it("the short Sunday in March does too", () => {
      const days = calendarDays(new Date(2027, 2, 13).getTime(), 1, 1);
      expect(days.map((day) => day.date.getDate())).toEqual([14, 15, 16, 17, 18, 19, 20]);
      expect(days.every((day) => day.date.getHours() === 0)).toBe(true);
    });
  });
});

describe("weekOf", () => {
  it("keeps the whole current week in week 0", () => {
    expect(weekOf(FRIDAY, -5)).toBe(0);
    expect(weekOf(FRIDAY, 0)).toBe(0);
    expect(weekOf(FRIDAY, 1)).toBe(0);
  });

  it("the next Sunday starts week 1", () => {
    expect(weekOf(FRIDAY, 2)).toBe(1);
    expect(weekOf(FRIDAY, 8)).toBe(1);
    expect(weekOf(FRIDAY, 9)).toBe(2);
  });

  it("floors negative offsets into the earlier week", () => {
    expect(weekOf(FRIDAY, -6)).toBe(-1);
    expect(weekOf(FRIDAY, -12)).toBe(-1);
    expect(weekOf(FRIDAY, -13)).toBe(-2);
  });

  it("when today is Sunday, yesterday is already last week", () => {
    expect(weekOf(SUNDAY, 0)).toBe(0);
    expect(weekOf(SUNDAY, -1)).toBe(-1);
  });

  it("agrees with the days calendarDays puts in that week", () => {
    for (const week of [-3, -1, 0, 1, 4]) {
      for (const day of calendarDays(FRIDAY, week, 1))
        expect(weekOf(FRIDAY, day.daysFromToday)).toBe(week);
    }
  });
});

describe("toneOf", () => {
  it("work to grade wins, whenever it was due", () => {
    expect(toneOf(item({ toGrade: 3, days: -4 }))).toBe("to-grade");
    expect(toneOf(item({ toGrade: 1, days: 0 }))).toBe("to-grade");
    expect(toneOf(item({ toGrade: 2, days: 5 }))).toBe("to-grade");
  });

  it("past and fully graded is closed", () => {
    expect(toneOf(item({ toGrade: 0, days: -1 }))).toBe("closed");
  });

  it("today or later with nothing to grade is upcoming", () => {
    expect(toneOf(item({ toGrade: 0, days: 0 }))).toBe("upcoming");
    expect(toneOf(item({ toGrade: 0, days: 6 }))).toBe("upcoming");
  });
});

describe("calendarSummary", () => {
  const nineteen = Array.from({ length: 19 }, (_, index) => item({ toGrade: index < 10 ? 2 : 0 }));

  it("counts what's due in the window and how much of it has work to grade", () => {
    expect(calendarSummary(nineteen, 0)).toBe("19 due, 10 with work to grade");
  });

  it("an empty window counts zero, like its grid", () => {
    expect(calendarSummary([], 0)).toBe("0 due, 0 with work to grade");
  });

  it("adds the undated count only when there are some", () => {
    expect(calendarSummary(nineteen, 2)).toBe(
      "19 due, 10 with work to grade, 2 without a due date",
    );
  });
});

describe("nextDue", () => {
  const due = (...days: number[]) => days.map((offset) => item({ days: offset }));

  it("names the first day after the window with something due", () => {
    expect(nextDue(FRIDAY, due(-2, 4, 12, 9), calendarDays(FRIDAY, 0, 1))).toEqual({
      label: "Next due Nov 3",
      daysFromToday: 4,
    });
  });

  it("skips past what the window already shows", () => {
    expect(nextDue(FRIDAY, due(4, 12), calendarDays(FRIDAY, 0, 2))).toEqual({
      label: "Next due Nov 11",
      daysFromToday: 12,
    });
  });

  it("says when nothing is due after the window", () => {
    expect(nextDue(FRIDAY, due(-2, 4), calendarDays(FRIDAY, 4, 2))).toEqual({
      label: "Nothing due after Dec 5",
      daysFromToday: null,
    });
  });
});

describe("rangeLabel", () => {
  it("names the first and last day, across a month end", () => {
    expect(rangeLabel(calendarDays(FRIDAY, 0, 2))).toBe("Oct 25 to Nov 7");
  });

  it("names the week when only one fits", () => {
    expect(rangeLabel(calendarDays(FRIDAY, 1, 1))).toBe("Nov 1 to Nov 7");
  });
});

describe("the calendar URL", () => {
  const SATURDAY_AFTER = new Date(2026, 10, 7).getTime();
  const roundTrip = (today: number, search: Record<string, unknown>) =>
    calendarView(today, parseCalendarSearch(search));

  it("names the open day by its date, not by weeks from today", () => {
    const view = { week: 1, picked: 8, school: "all" } as const;
    expect(calendarSearch(FRIDAY, view)).toEqual({ day: "2026-11-07" });
    expect(roundTrip(FRIDAY, { day: "2026-11-07" })).toEqual(view);
  });

  it("opens the same week a week later", () => {
    const search = calendarSearch(FRIDAY, { week: 1, school: "all" });
    expect(search).toEqual({ week: "2026-11-01" });
    expect(roundTrip(SATURDAY_AFTER, search)).toMatchObject({ week: 0 });
    expect(roundTrip(SUNDAY, search)).toMatchObject({ week: 1 });
  });

  it("keeps the school filter", () => {
    const view = { week: 0, picked: undefined, school: "rsu" as SchoolId };
    expect(roundTrip(FRIDAY, calendarSearch(FRIDAY, view))).toEqual(view);
  });

  it("the day after Saturday opens in the next week", () => {
    const sundayAfter = { week: 0, picked: 2, school: "all" } as const;
    expect(roundTrip(FRIDAY, calendarSearch(FRIDAY, sundayAfter))).toEqual({
      ...sundayAfter,
      week: 1,
    });
  });

  it("drops values a hand-edited URL can't mean", () => {
    expect(parseCalendarSearch({ week: 1, day: "2026-02-30", school: "" })).toEqual({});
    expect(parseCalendarSearch({ week: "11/01/2026" })).toEqual({});
  });
});
