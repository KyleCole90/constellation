import { useEffect, useLayoutEffect, useRef } from "react";

/** Blur is not the only way a field goes away: Back, ⌘1 or a reload can take it while it has focus. */
export function useCommitOnLeave(commit: () => void) {
  const latest = useRef(commit);
  useLayoutEffect(() => {
    latest.current = commit;
  });
  useEffect(() => {
    const leave = () => latest.current();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, []);
}
