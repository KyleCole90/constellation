import type { SchoolId } from "~/shared/domain/ids";

const MINUTE = 60_000;
export const SYNC_EVERY_MS = 15 * MINUTE;
const FIRST_RETRY_MS = MINUTE;

export interface AutoSyncDeps {
  connected(): readonly SchoolId[];
  /** Joins a sync of that school already running rather than starting a second. */
  sync(school: SchoolId): Promise<boolean>;
  online(): boolean;
  /** Runs `run` once after `ms` and returns its cancel. Absent, nothing syncs on a timer. */
  timer?: (run: () => void, ms: number) => () => void;
}

/** After `failures` failed runs in a row: 1, 2, 4, 8 minutes, then the usual interval. */
export const nextSyncDelay = (failures: number): number =>
  failures === 0 ? SYNC_EVERY_MS : Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), SYNC_EVERY_MS);

/** The one place school syncs start on their own: at launch, on a timer, and when the network comes back. */
export const createAutoSync = (deps: AutoSyncDeps) => {
  let failures = 0;
  let cancel = () => {};
  let running: Promise<void> | null = null;

  const run = async () => {
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

  return { now };
};
