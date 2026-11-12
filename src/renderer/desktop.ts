import type { Bridge } from "~/shared/ipc";

/** The preload's bridge. The desktop app has one; the web demo, and tests in Node, don't. */
export const desktopBridge: Bridge | undefined =
  typeof window === "undefined" ? undefined : window.constellation;

/** Drafts and chat come from Claude in main. Otherwise, in the web demo and in verify, from the rules agent. */
export const REAL_AI = desktopBridge?.agent === "claude";

/** Anthropic's console page where the teacher caps what their key spends. The app has no cap of its own. */
export const SPEND_LIMITS_URL = "https://platform.claude.com/settings/limits";

/** Where saved tokens and keys live, as the UI names it. */
export const VAULT_PLACE = desktopBridge ? "your Mac's Keychain" : "this browser's vault";
