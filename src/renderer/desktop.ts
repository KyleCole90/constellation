import { createContext, useContext, useSyncExternalStore } from "react";

import { errorReport, type Bridge } from "~/shared/ipc";

export const desktopBridge = (): Bridge => window.constellation;

const DesktopBridgeContext = createContext<Bridge | null>(null);

export const DesktopBridgeProvider = DesktopBridgeContext.Provider;

export const useDesktopBridge = (): Bridge => {
  const bridge = useContext(DesktopBridgeContext);
  if (!bridge) throw new Error("Render inside a DesktopBridgeProvider.");
  return bridge;
};

/** Hands an error's type and stack to main, which scrubs them and decides whether a report leaves. */
export const reportError = (error: unknown) => {
  void desktopBridge()
    .invoke("error.report", errorReport(error))
    .catch(() => {});
};

/** Drafts and chat come from Claude in main. Under verify, which runs on fakes, from the rules agent. */
export const realAi = (): boolean => !desktopBridge().fakes;

/** Anthropic's console page where the teacher caps what their key spends. The app has no cap of its own. */
export const SPEND_LIMITS_URL = "https://platform.claude.com/settings/limits";

/** Anthropic's page for installing Claude Code, which the teacher does themselves. */
export const CLAUDE_CODE_SETUP_URL = "https://code.claude.com/docs/en/setup";

/** Where saved tokens and keys live, as the UI names it. */
export const VAULT_PLACE = "your Mac's Keychain";

/** Claude needs the network; the rules agent doesn't. Offline, AI is disabled up front rather than queued. */
export const OFFLINE_REASON =
  "You're offline, so Claude can't draft or chat. Nothing is queued. Ask again once you're back online.";

// Only a browser's explicit `false` is offline: Node, in tests, has a navigator with no `onLine`.
export const isOnline = (): boolean =>
  (globalThis.navigator as { onLine?: boolean } | undefined)?.onLine !== false;

/** Sending needs the school; offline, Send is disabled up front, and a queued send could post twice. */
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
  useSyncExternalStore(onConnectivity, () => !realAi() || isOnline());
