import { lastOf, type NonEmpty } from "~/renderer/lib/nonEmpty";
import { isoTime, type IsoDate, type SchoolId } from "~/shared/domain/ids";
import { dateOfTime, isoDate } from "~/shared/domain/term";
import { formatDay } from "~/renderer/lib/utils";
import { hasWorkToGrade, type DatedItem, type DueItem } from "~/renderer/stores/selectors";

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

export const toneOf = (item: Pick<DatedItem, "toGrade" | "days">): MarkerTone =>
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
export const calendarSummary = (inWindow: readonly DatedItem[], undated: number): string => {
  const toGrade = inWindow.filter((item) => toneOf(item) === "to-grade").length;
  const summary = `${inWindow.length} due, ${toGrade} with work to grade`;
  return undated > 0 ? `${summary}, ${undated} without a due date` : summary;
};

/** Work with no due date has no day to sit on, so the Calendar names how much of it waits to be graded instead of letting it vanish. */
export const undatedToGrade = (undated: readonly DueItem[]): string | null => {
  const toGrade = undated.reduce((sum, item) => sum + item.toGrade, 0);
  return toGrade > 0 ? `${toGrade} to grade with no due date` : null;
};

const shortDate = (date: Date): string => formatDay(date.toISOString());
export const rangeLabel = (days: NonEmpty<CalendarDay>): string =>
  `${shortDate(days[0].date)} to ${shortDate(lastOf(days).date)}`;

export type NextDue =
  | { label: string; daysFromToday: number }
  | { label: string; daysFromToday: null };

export const nextDue = (
  today: number,
  items: readonly DatedItem[],
  days: NonEmpty<CalendarDay>,
): NextDue => {
  const last = lastOf(days);
  const after = items.map((item) => item.days).filter((day) => day > last.daysFromToday);
  if (after.length === 0)
    return { label: `Nothing due after ${shortDate(last.date)}`, daysFromToday: null };
  const daysFromToday = Math.min(...after);
  return { label: `Next due ${shortDate(dateAt(today, daysFromToday))}`, daysFromToday };
};

/** A day in the URL, as the local date, so a saved link names the same day whenever it is opened. */
const isoDay = (date: Date): IsoDate =>
  dateOfTime(isoTime(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())));

const parseIsoDay = (value: unknown): IsoDate | undefined =>
  typeof value === "string" ? (isoDate(value) ?? undefined) : undefined;

const daysFrom = (today: number, iso: IsoDate): number => {
  const start = new Date(today);
  return Math.round(
    (Date.parse(`${iso}T00:00:00Z`) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
      86_400_000,
  );
};

// An open day implies its week, so the URL names one or the other.
type CalendarSearch = {
  week?: IsoDate;
  day?: IsoDate;
  school?: string;
};

export const parseCalendarSearch = (search: Record<string, unknown>): CalendarSearch => {
  const day = parseIsoDay(search.day);
  const week = parseIsoDay(search.week);
  const school = typeof search.school === "string" && search.school ? search.school : undefined;
  return {
    ...(day ? { day } : week ? { week } : {}),
    ...(school ? { school } : {}),
  };
};

export type CalendarView = { week: number; picked?: number | undefined; school: SchoolFilter };

/** A school the URL names that isn't here reads as every school. */
export const calendarView = (
  today: number,
  search: CalendarSearch,
  schools: readonly { id: SchoolId }[],
): CalendarView => {
  const picked = search.day === undefined ? undefined : daysFrom(today, search.day);
  const anchor = picked ?? (search.week === undefined ? 0 : daysFrom(today, search.week));
  const school = schools.find(({ id }) => id === search.school)?.id ?? "all";
  return { week: weekOf(today, anchor), picked, school };
};

export const calendarSearch = (today: number, view: CalendarView): CalendarSearch => ({
  ...(view.picked === undefined
    ? { week: isoDay(dateAt(today, view.week * 7 - new Date(today).getDay())) }
    : { day: isoDay(dateAt(today, view.picked)) }),
  ...(view.school === "all" ? {} : { school: view.school }),
});
