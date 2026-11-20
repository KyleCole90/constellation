import { type Brand, type IsoDate, type IsoTime } from "./ids";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface DateShiftOptions {
  oldStart: IsoDate;
  oldEnd: IsoDate;
  newStart: IsoDate;
  newEnd: IsoDate;
  substitutions: Readonly<Partial<Record<Weekday, Weekday>>>;
}
export type TermName = Brand<string, "TermName">;
export const termName = (text: string): TermName | null =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mint: the blank test is the brand's check
  text.trim() === "" ? null : (text as TermName);
export interface TermDates<D extends DraftDate = IsoDate> {
  name: TermName | null;
  start: D;
  end: D;
  days: readonly Weekday[];
}
export interface TermBreak<D extends DraftDate = IsoDate> {
  name: string;
  start: D;
  end: D;
}
export interface TermPlan {
  oldTerm: TermDates;
  newTerm: TermDates;
  breaks: readonly TermBreak[];
}
export type DraftDate = IsoDate | "";
export type DraftTerm = Omit<TermDates<DraftDate>, "name"> & { name: string };
export interface PlanDraft {
  oldTerm: DraftTerm;
  newTerm: DraftTerm;
  breaks: readonly TermBreak<DraftDate>[];
}
export const draftTerm = ({ name, start, end, days }: TermDates<DraftDate>): DraftTerm => ({
  name: name ?? "",
  start,
  end,
  days,
});
export const draftOf = (plan: TermPlan): PlanDraft => ({
  ...plan,
  oldTerm: draftTerm(plan.oldTerm),
  newTerm: draftTerm(plan.newTerm),
});
export interface BreakMove {
  date: IsoDate;
  movedFrom: TermBreak | null;
  outsideTerm: boolean;
}
export interface DueDay {
  title: string;
  due: IsoDate;
}
export interface ShiftRow extends BreakMove {
  title: string;
  from: IsoDate;
  shifted: IsoDate;
}

const DAY_MS = 86_400_000;
export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateAt = (day: number): IsoDate =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mint: the day part of toISOString is YYYY-MM-DD
  new Date(day * DAY_MS).toISOString().slice(0, 10) as IsoDate;
const floorMod7 = (value: number): number => ((value % 7) + 7) % 7;
const EPOCH_WEEKDAY = 4;
const isWeekday = (value: number): value is Weekday =>
  Number.isInteger(value) && value >= 0 && value <= 6;
const weekdayAt = (day: number): Weekday => {
  const weekday = floorMod7(day + EPOCH_WEEKDAY);
  if (!isWeekday(weekday)) throw new RangeError(`No weekday for day ${day}`);
  return weekday;
};
const roundHalfAway = (value: number): number => Math.sign(value) * Math.round(Math.abs(value));
const byNumber = (a: number, b: number): number => a - b;

export const sameSpanEnd = (start: IsoDate, from: IsoDate, to: IsoDate): IsoDate =>
  dateAt(dayNumber(start) + dayNumber(to) - dayNumber(from));
export const weekdayOf = (date: IsoDate): Weekday => weekdayAt(dayNumber(date));
export const meetingDaysOf = (dates: readonly IsoDate[]): readonly Weekday[] =>
  [...new Set(dates.map(weekdayOf))].sort(byNumber);
export const dateOfTime = (at: IsoTime): IsoDate =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mint: an IsoTime starts with its YYYY-MM-DD day
  at.slice(0, 10) as IsoDate;
export const timeOnDate = (at: IsoTime, date: IsoDate): IsoTime =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mint: swaps one YYYY-MM-DD day for another and keeps the time
  `${date}${at.slice(10)}` as IsoTime;
export const isoDate = (text: string): IsoDate | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = dayNumber(text);
  if (Number.isNaN(day)) return null;
  const date = dateAt(day);
  return date === text ? date : null;
};
const isInside = (date: IsoDate, range: { start: IsoDate; end: IsoDate }): boolean =>
  date >= range.start && date <= range.end;

export const planDays = (
  oldDays: readonly Weekday[],
  newDays: readonly Weekday[],
): Readonly<Record<Weekday, Weekday>> => {
  const from = [...oldDays].sort(byNumber);
  const to = [...newDays].sort(byNumber);
  const pairOf = (day: Weekday): Weekday => {
    const position = from.indexOf(day);
    return position === -1 ? day : (to[position] ?? to.at(-1) ?? day);
  };
  return {
    0: pairOf(0),
    1: pairOf(1),
    2: pairOf(2),
    3: pairOf(3),
    4: pairOf(4),
    5: pairOf(5),
    6: pairOf(6),
  };
};

export const shiftOptionsOf = ({ oldTerm, newTerm }: TermPlan): DateShiftOptions => ({
  oldStart: oldTerm.start,
  oldEnd: oldTerm.end,
  newStart: newTerm.start,
  newEnd: newTerm.end,
  substitutions: planDays(oldTerm.days, newTerm.days),
});

export const shiftDate = (date: IsoDate, options: DateShiftOptions): IsoDate => {
  const oldSpanDays = dayNumber(options.oldEnd) - dayNumber(options.oldStart);
  const newSpanDays = dayNumber(options.newEnd) - dayNumber(options.newStart);
  const oldEventDays = dayNumber(date) - dayNumber(options.oldStart);
  const percent = oldSpanDays > 0 ? oldEventDays / oldSpanDays : 0;
  const newStart = dayNumber(options.newStart);
  const proportional = newStart + roundHalfAway(newSpanDays * percent);
  const weekday = weekdayOf(date);
  const wanted = options.substitutions[weekday] ?? weekday;
  if (weekdayAt(proportional) === wanted) return dateAt(proportional);
  const forward = proportional + floorMod7(wanted - weekdayAt(proportional));
  return dateAt(forward - 7 < newStart ? forward : forward - 7);
};

export const breakHolding = (date: IsoDate, plan: TermPlan): TermBreak | null =>
  plan.breaks.find((held) => isInside(date, held)) ?? null;

const firstMeeting = (from: number, to: number, step: 1 | -1, plan: TermPlan): IsoDate | null => {
  for (let day = from; (day - to) * step <= 0; day += step) {
    const date = dateAt(day);
    if (plan.newTerm.days.includes(weekdayAt(day)) && !breakHolding(date, plan)) return date;
  }
  return null;
};

export const moveOutOfBreak = (date: IsoDate, plan: TermPlan): BreakMove => {
  const held = breakHolding(date, plan);
  const termStart = dayNumber(plan.newTerm.start);
  const termEnd = dayNumber(plan.newTerm.end);
  const moved =
    held &&
    (firstMeeting(dayNumber(held.end) + 1, termEnd, 1, plan) ??
      firstMeeting(Math.min(dayNumber(held.start) - 1, termEnd), termStart, -1, plan));
  const result = moved || date;
  return {
    date: result,
    movedFrom: moved ? held : null,
    outsideTerm: !isInside(result, plan.newTerm),
  };
};

export const meetingDayInside = (date: IsoDate, plan: TermPlan): IsoDate | null => {
  if (isInside(date, plan.newTerm)) return null;
  const termStart = dayNumber(plan.newTerm.start);
  const termEnd = dayNumber(plan.newTerm.end);
  return date < plan.newTerm.start
    ? firstMeeting(termStart, termEnd, 1, plan)
    : firstMeeting(termEnd, termStart, -1, plan);
};

export const shiftPreview = (items: readonly DueDay[], plan: TermPlan): readonly ShiftRow[] => {
  const options = shiftOptionsOf(plan);
  return items.map(({ title, due }) => {
    const shifted = shiftDate(due, options);
    return { title, from: due, shifted, ...moveOutOfBreak(shifted, plan) };
  });
};

export const NO_NEW_DAYS = "Pick at least one meeting day for the new term.";

export const planProblems = ({ oldTerm, newTerm, breaks }: TermPlan): readonly string[] => [
  ...(oldTerm.start >= oldTerm.end ? ["The old term has to end after it starts."] : []),
  ...(newTerm.start >= newTerm.end ? ["The new term has to end after it starts."] : []),
  ...(newTerm.days.length === 0 && oldTerm.days.length > 0 ? [NO_NEW_DAYS] : []),
  ...breaks.flatMap((held) => {
    if (held.start > held.end) return [`${held.name} has to end on or after the day it starts.`];
    return isInside(held.start, newTerm) && isInside(held.end, newTerm)
      ? []
      : [`${held.name} is not inside the new term.`];
  }),
];

export interface DateMention {
  index: number;
  length: number;
  text: string;
  date: IsoDate;
  yearWritten: boolean;
  numeric: boolean;
  range: boolean;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LEAD =
  "(?:(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tues|Tue|Wed|Thurs|Thu|Fri|Sat)(\\.?,?\\s+))?";
const MONTH_WORD =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";
const NAMED = new RegExp(
  `(?<![\\w/])${LEAD}(${MONTH_WORD})(\\.?\\s+)(\\d{1,2})(st|nd|rd|th)?(?:(,?\\s+)(\\d{4}))?(?![\\w/])`,
  "g",
);
const NUMERIC = new RegExp(
  `(?<![\\w/.-])${LEAD}(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?(?![\\w/])`,
  "g",
);
const RANGE_TAIL = /^\s*[-–]\s*\d/;

const pad2 = (value: number): string => String(value).padStart(2, "0");
const yearOf = (date: IsoDate): number => Number(date.slice(0, 4));

const nearestInTerm = (
  monthDay: string,
  term: { start: IsoDate; end: IsoDate },
): IsoDate | null => {
  const distance = (date: IsoDate) =>
    isInside(date, term)
      ? 0
      : Math.min(
          Math.abs(dayNumber(date) - dayNumber(term.start)),
          Math.abs(dayNumber(date) - dayNumber(term.end)),
        );
  const candidates: IsoDate[] = [];
  for (let year = yearOf(term.start) - 1; year <= yearOf(term.end) + 1; year++) {
    const date = isoDate(`${year}-${monthDay}`);
    if (date) candidates.push(date);
  }
  return candidates.reduce<IsoDate | null>(
    (best, date) => (best === null || distance(date) < distance(best) ? date : best),
    null,
  );
};

const fullYear = (written: string): number =>
  written.length === 2 ? 2000 + Number(written) : Number(written);

const dateOfParts = (
  month: number,
  day: number,
  year: string | undefined,
  term: { start: IsoDate; end: IsoDate },
): IsoDate | null => {
  const monthDay = `${pad2(month)}-${pad2(day)}`;
  return year === undefined
    ? nearestInTerm(monthDay, term)
    : isoDate(`${fullYear(year)}-${monthDay}`);
};

export const findDateMentions = (
  body: string,
  term: { start: IsoDate; end: IsoDate },
): readonly DateMention[] => {
  const mention = (match: RegExpMatchArray, numeric: boolean): DateMention[] => {
    const parts = numeric
      ? { month: Number(match[3]), day: Number(match[4]), year: match[5] }
      : {
          month: MONTH_NAMES.findIndex((name) => name.startsWith((match[3] ?? "").slice(0, 3))) + 1,
          day: Number(match[5]),
          year: match[8],
        };
    const date = dateOfParts(parts.month, parts.day, parts.year, term);
    const index = match.index ?? 0;
    const text = match[0];
    return date
      ? [
          {
            index,
            length: text.length,
            text,
            date,
            yearWritten: parts.year !== undefined,
            numeric,
            range: RANGE_TAIL.test(body.slice(index + text.length)),
          },
        ]
      : [];
  };
  return [
    ...[...body.matchAll(NAMED)].flatMap((match) => mention(match, false)),
    ...[...body.matchAll(NUMERIC)].flatMap((match) => mention(match, true)),
  ].sort((a, b) => a.index - b.index);
};

const ordinalOf = (day: number): string => {
  if (day >= 11 && day <= 13) return "th";
  return ["th", "st", "nd", "rd"][day % 10] ?? "th";
};
const likeWritten = (value: number, written: string): string =>
  written.startsWith("0") ? pad2(value) : String(value);
const leadWord = (date: IsoDate, written: string | undefined): string => {
  if (written === undefined) return "";
  const name = DAY_NAMES[weekdayOf(date)] ?? "";
  return DAY_NAMES.includes(written) ? name : name.slice(0, 3);
};

export const rewriteMention = (mention: DateMention, date: IsoDate): string => {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const year = date.slice(0, 4);
  if (mention.numeric) {
    return mention.text.replace(
      NUMERIC,
      (
        _,
        lead: string | undefined,
        gap: string | undefined,
        oldMonth: string,
        oldDay: string,
        oldYear: string | undefined,
      ) =>
        `${leadWord(date, lead)}${gap ?? ""}${likeWritten(month, oldMonth)}/${likeWritten(day, oldDay)}${oldYear === undefined ? "" : `/${oldYear.length === 2 ? year.slice(2) : year}`}`,
    );
  }
  return mention.text.replace(
    NAMED,
    (
      _,
      lead: string | undefined,
      gap: string | undefined,
      oldMonth: string,
      monthGap: string,
      oldDay: string,
      ordinal: string | undefined,
      yearGap: string | undefined,
      oldYear: string | undefined,
    ) => {
      const name = MONTH_NAMES[month - 1] ?? "";
      return `${leadWord(date, lead)}${gap ?? ""}${MONTH_NAMES.includes(oldMonth) ? name : name.slice(0, 3)}${monthGap}${likeWritten(day, oldDay)}${ordinal === undefined ? "" : ordinalOf(day)}${oldYear === undefined ? "" : `${yearGap ?? ""}${year}`}`;
    },
  );
};

export const mentionIsStale = (mention: DateMention, plan: TermPlan): boolean => {
  const { date } = mention;
  if (mention.yearWritten)
    return (
      !isInside(date, plan.newTerm) &&
      yearOf(date) >= yearOf(plan.oldTerm.start) &&
      yearOf(date) <= yearOf(plan.oldTerm.end)
    );
  const inOld = isInside(date, plan.oldTerm);
  if (mention.numeric) return inOld;
  const inNew = nearestInTerm(date.slice(5), plan.newTerm);
  return inOld || inNew === null || !isInside(inNew, plan.newTerm);
};
