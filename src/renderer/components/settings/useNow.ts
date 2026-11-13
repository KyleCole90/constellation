import { useEffect, useState } from "react";

import { workspaceStore } from "~/renderer/stores/workspace";

const TICK_MS = 30_000;

/** The app clock, re-read often enough that "2 minutes ago" doesn't go stale on an open screen. */
export const useNow = (): number => {
  const [now, setNow] = useState(() => workspaceStore().getState().now());
  useEffect(() => {
    const timer = setInterval(() => setNow(workspaceStore().getState().now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
};
