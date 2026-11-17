/** Running promises by key, one lane per operation so each lane keeps its result type. A reset drops them all. */
export interface InFlight {
  lane<T>(): Map<string, Promise<T>>;
  clear(): void;
}

export const createInFlight = (): InFlight => {
  const lanes: Map<string, unknown>[] = [];
  return {
    lane: <T>() => {
      const lane = new Map<string, Promise<T>>();
      lanes.push(lane);
      return lane;
    },
    clear: () => {
      for (const lane of lanes) lane.clear();
    },
  };
};

/** Joins the run already out for `key`, or starts one. */
export const once = <T>(
  lane: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> => {
  const running = lane.get(key);
  if (running) return running;
  const started = run().finally(() => lane.delete(key));
  lane.set(key, started);
  return started;
};
