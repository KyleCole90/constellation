import type { Bridge } from "~/shared/ipc";

/** The preload's bridge. The desktop app has one; the web demo, and tests in Node, don't. */
export const desktopBridge: Bridge | undefined =
  typeof window === "undefined" ? undefined : window.constellation;

/** Where saved tokens and keys live, as the UI names it. */
export const VAULT_PLACE = desktopBridge ? "your Mac's Keychain" : "this browser's vault";
