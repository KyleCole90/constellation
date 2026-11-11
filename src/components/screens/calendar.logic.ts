import { lastOf, type NonEmpty } from "~/lib/nonEmpty";
import type { SchoolId } from "~/domain/ids";
import { formatDay } from "~/lib/utils";
import { hasWorkToGrade, type DueItem } from "~/stores/selectors";

import type { SchoolFilter } from "./due.logic";

export const LANE_WIDTH = 160;
/* Room for the longest word in a seeded chip title ("Bibliography" is 70.5px at text-meta) plus the chip's 12px of padding, border and cell inset, rounded up. */
export const MIN_DAY_WIDTH = 83;

export const weeksThatFit = (gridWidth: number): 1 | 2 =>
  (gridWidth - LANE_WIDTH) / 14 >= MIN_DAY_WIDTH ? 2 : 1;

/** Whether one week fits beside the wide course lane. When it doesn't, the lane drops to course codes so no chip word breaks. */
export const wideLaneFits = (gridWidth: number): boolean =>
  (gridWidth - LANE_WIDTH) / 7 >= MIN_DAY_WIDTH;

export interface CalendarDay {
  daysFromToday: number;
  date: Date;
  isToday: boolean;
  isWeekend: boolean;
}

// Calendar fields rather than ms, because a day across a clock change isn't 24 hours.
const dateAt = (today: number, daysFromToday: number): Date => {
  const start = new Date(today);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + daysFromToday);
};

export const calendarDays = (
  today: number,
  weekFromNow: number,
  weeks: 1 | 2,
): NonEmpty<CalendarDay> => {
  const sunday = weekFromNow * 7 - new Date(today).getDay();
  const day = (index: number): CalendarDay => {
    const daysFromToday = sunday + index;
    const date = dateAt(today, daysFromToday);
    return {
      daysFromToday,
      date,
      isToday: daysFromToday === 0,
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
    };
  };
  return [day(0), ...Array.from({ length: weeks * 7 - 1 }, (_, index) => day(index + 1))];
};

export const weekOf = (today: number, daysFromToday: number): number =>
  Math.floor((daysFromToday + new Date(today).getDay()) / 7);

export type MarkerTone = "to-grade" | "upcoming" | "closed";

export const toneOf = (item: Pick<DueItem, "toGrade" | "days">): MarkerTone =>
  hasWorkToGrade(item) ? "to-grade" : item.days < 0 ? "closed" : "upcoming";

export const TONE_LOOK: Readonly<
  Record<MarkerTone, { borderPercent: number; fillPercent: number; dashed: boolean }>
> = {
  "to-grade": { borderPercent: 55, fillPercent: 16, dashed: false },
  upcoming: { borderPercent: 55, fillPercent: 0, dashed: false },
  // Nothing left to grade shows as a dashed outline, not as dimmed text, so it never reads as disabled.
  closed: { borderPercent: 70, fillPercent: 0, dashed: true },
};

/** Counts the items in the window shown, so it always agrees with the grid. */
export const calendarSummary = (inWindow: readonly DueItem[], undated: number): string => {
  const toGrade = inWindow.filter((item) => toneOf(item) === "to-grade").length;
  const summary = `${inWindow.length} due, ${toGrade} with work to grade`;
  return undated > 0 ? `${summary}, ${undated} without a due date` : summary;
};

const shortDate = (date: Date): string => formatDay(date.toISOString());
export const rangeLabel = (days: NonEmpty<CalendarDay>): string =>
  `${shortDate(days[0].date)} to ${shortDate(lastOf(days).date)}`;

export type NextDue =
  | { label: string; daysFromToday: number }
  | { label: string; daysFromToday: null };

export const nextDue = (
  today: number,
  items: readonly DueItem[],
  days: NonEmpty<CalendarDay>,
): NextDue => {
  const last = lastOf(days);
  const after = items.map((item) => item.days).filter((day) => day > last.daysFromToday);
  if (after.length === 0)
    return { label: `Nothing due after ${shortDate(last.date)}`, daysFromToday: null };
  const daysFromToday = Math.min(...after);
  return { label: `Next due ${shortDate(dateAt(today, daysFromToday))}`, daysFromToday };
};

/** A day in the URL, as local `YYYY-MM-DD`, so a saved link names the same day whenever it is opened. */
type IsoDay = string;

const isoDay = (date: Date): IsoDay =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");

const parseIsoDay = (value: unknown): IsoDay | undefined => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return isoDay(new Date(year, month - 1, day)) === value ? value : undefined;
};

const daysFrom = (today: number, iso: IsoDay): number => {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  const start = new Date(today);
  return Math.round(
    (Date.UTC(year, month - 1, day) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
      86_400_000,
  );
};

// An open day implies its week, so the URL names one or the other.
type CalendarSearch = {
  week?: IsoDay;
  day?: IsoDay;
  school?: SchoolId;
};

export const parseCalendarSearch = (search: Record<string, unknown>): CalendarSearch => {
  const day = parseIsoDay(search.day);
  const week = parseIsoDay(search.week);
  const school = typeof search.school === "string" && search.school ? search.school : undefined;
  return {
    ...(day ? { day } : week ? { week } : {}),
    ...(school ? { school: school as SchoolId } : {}),
  };
};

export type CalendarView = { week: number; picked?: number | undefined; school: SchoolFilter };

export const calendarView = (today: number, search: CalendarSearch): CalendarView => {
  const picked = search.day === undefined ? undefined : daysFrom(today, search.day);
  const anchor = picked ?? (search.week === undefined ? 0 : daysFrom(today, search.week));
  return { week: weekOf(today, anchor), picked, school: search.school ?? "all" };
};

export const calendarSearch = (today: number, view: CalendarView): CalendarSearch => ({
  ...(view.picked === undefined
    ? { week: isoDay(dateAt(today, view.week * 7 - new Date(today).getDay())) }
    : { day: isoDay(dateAt(today, view.picked)) }),
  ...(view.school === "all" ? {} : { school: view.school }),
});
