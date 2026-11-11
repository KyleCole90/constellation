import type { StorageLike } from "~/shared/providers/fake-canvas/server";

export interface MemoryStorage extends StorageLike {
  keys(): readonly string[];
  /** The next write throws, like a full localStorage. */
  failNextWrite(): void;
}

export const memoryStorage = (): MemoryStorage => {
  const items = new Map<string, string>();
  let failNext = false;
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (failNext) {
        failNext = false;
        throw new Error("QuotaExceededError");
      }
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    keys: () => [...items.keys()],
    failNextWrite: () => {
      failNext = true;
    },
  };
};
