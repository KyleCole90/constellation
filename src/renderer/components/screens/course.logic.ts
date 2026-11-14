import type { LmsError } from "~/shared/domain/change";
import type { IsoTime } from "~/shared/domain/ids";
import type { RosterRow } from "~/renderer/stores/selectors";

const MINUTE = 60_000;
const STALE_AFTER = 60 * MINUTE;

export const ageWords = (at: IsoTime | null, now: number): string => {
  if (!at) return "never";
  const minutes = Math.max(Math.floor((now - new Date(at).getTime()) / MINUTE), 0);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `${Math.round(hours / 24)} days ago`;
};

export const isStale = (at: IsoTime | null, now: number): boolean =>
  at === null || now - new Date(at).getTime() > STALE_AFTER;

const failure = (error: LmsError["kind"], vendor: string): string => {
  if (error === "unavailable") return `Can't reach ${vendor}. Check your internet connection.`;
  if (error === "auth_expired") return `Couldn't refresh: your ${vendor} token expired.`;
  if (error === "rate_limited") return `Couldn't refresh: ${vendor} asked us to slow down.`;
  return `Couldn't refresh: ${vendor} gave an error.`;
};

/** Says the data on screen is the old data, so a failure never reads as an empty course. */
export const syncFailureWords = (
  error: LmsError["kind"],
  vendor: string,
  at: IsoTime | null,
  now: number,
): string => `${failure(error, vendor)} Showing data from ${ageWords(at, now)}.`;

/** Most missing work first, then the lowest grade. Students without a grade yet go after those with one. */
export const behindFirst = (roster: readonly RosterRow[]): readonly RosterRow[] => {
  const grade = (row: RosterRow) => row.percent ?? Number.MAX_SAFE_INTEGER;
  return [...roster].sort((a, b) => b.missing - a.missing || grade(a) - grade(b));
};
