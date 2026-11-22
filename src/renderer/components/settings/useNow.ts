import { useEffect, useState } from "react";

import { useWorkspaceStore } from "~/renderer/stores/workspace";

const TICK_MS = 30_000;

/** The app clock, re-read often enough that "2 minutes ago" doesn't go stale on an open screen. */
export const useNow = (): number => {
  const store = useWorkspaceStore();
  const [now, setNow] = useState(() => store.getState().now());
  useEffect(() => {
    const timer = setInterval(() => setNow(store.getState().now()), TICK_MS);
    return () => clearInterval(timer);
  }, [store]);
  return now;
};
