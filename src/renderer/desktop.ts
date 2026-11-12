import { useSyncExternalStore } from "react";

import { errorReport, type Bridge } from "~/shared/ipc";

/** The preload's bridge. The desktop app has one; the web demo, and tests in Node, don't. */
export const desktopBridge: Bridge | undefined =
  typeof window === "undefined" ? undefined : window.constellation;

/**
 * Hands an error's type and stack to main, which scrubs them and decides whether a report leaves (docs/electron-spec.md,
 * D23). The web demo has no main, so it sends nothing.
 */
export const reportError = (error: unknown) => {
  void desktopBridge?.invoke("error.report", errorReport(error)).catch(() => {});
};

/** Drafts and chat come from Claude in main. Otherwise, in the web demo and in verify, from the rules agent. */
export const REAL_AI = desktopBridge?.agent === "claude";

/** Anthropic's console page where the teacher caps what their key spends. The app has no cap of its own. */
export const SPEND_LIMITS_URL = "https://platform.claude.com/settings/limits";

/** Where saved tokens and keys live, as the UI names it. */
export const VAULT_PLACE = desktopBridge ? "your Mac's Keychain" : "this browser's vault";

/** Claude needs the network; the rules agent doesn't. Offline, AI is disabled up front rather than queued (D28). */
export const OFFLINE_REASON =
  "You're offline, so Claude can't draft or chat. Nothing is queued. Ask again once you're back online.";

// Only a browser's explicit `false` is offline: Node, in tests, has a navigator with no `onLine`.
export const isOnline = (): boolean =>
  (globalThis.navigator as { onLine?: boolean } | undefined)?.onLine !== false;

/** Sending needs the school; offline, Send is disabled up front, and a queued send could post twice (D28). */
export const OFFLINE_SEND_REASON =
  "You're offline, so nothing can be sent. Nothing is queued. Send once you're back online.";

export const onConnectivity = (change: () => void) => {
  window.addEventListener("online", change);
  window.addEventListener("offline", change);
  return () => {
    window.removeEventListener("online", change);
    window.removeEventListener("offline", change);
  };
};

/** False only when Claude would be asked and the Mac is offline. */
export const useAiReachable = (): boolean =>
  useSyncExternalStore(onConnectivity, () => !REAL_AI || isOnline());
