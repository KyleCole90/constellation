import type { SchoolId } from "~/shared/domain/ids";

const MINUTE = 60_000;
export const SYNC_EVERY_MS = 15 * MINUTE;
const FIRST_RETRY_MS = MINUTE;
/** Coming back to the app, or opening a view that lists courses, syncs at most this often. */
export const FRESHEN_EVERY_MS = 2 * MINUTE;

export interface AutoSyncDeps {
  connected(): readonly SchoolId[];
  /** Joins a sync of that school already running rather than starting a second. */
  sync(school: SchoolId): Promise<boolean>;
  online(): boolean;
  now(): number;
  /** Runs `run` once after `ms` and returns its cancel. Absent, nothing syncs on a timer. */
  timer?: (run: () => void, ms: number) => () => void;
}

/** After `failures` failed runs in a row: 1, 2, 4, 8 minutes, then the usual interval. */
export const nextSyncDelay = (failures: number): number =>
  failures === 0 ? SYNC_EVERY_MS : Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), SYNC_EVERY_MS);

/**
 * The one place school syncs start on their own: at launch, on a timer, when the network comes back, and, through
 * `freshen`, when the teacher returns to the window or opens a view of courses.
 */
export const createAutoSync = (deps: AutoSyncDeps) => {
  let failures = 0;
  let cancel = () => {};
  let running: Promise<void> | null = null;
  let startedAt = -Infinity;

  const run = async () => {
    startedAt = deps.now();
    if (deps.online()) {
      const results = await Promise.allSettled(deps.connected().map((school) => deps.sync(school)));
      const synced = results.every((result) => result.status === "fulfilled" && result.value);
      failures = synced ? 0 : failures + 1;
    }
    cancel();
    cancel = deps.timer?.(() => void now(), nextSyncDelay(failures)) ?? (() => {});
  };

  const now = (): Promise<void> =>
    (running ??= run().finally(() => {
      running = null;
    }));

  /** A sync unless one started in the last two minutes, so a teacher looking for something new finds it. */
  const freshen = (): Promise<void> =>
    deps.now() - startedAt < FRESHEN_EVERY_MS ? Promise.resolve() : now();

  return { now, freshen };
};
