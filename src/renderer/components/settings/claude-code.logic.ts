import { CLAUDE_CODE_MINIMUM } from "~/shared/claude-code";
import type { ClaudeCodeStatus } from "~/shared/ipc";

/** What the app last read of the teacher's Claude Code, as the AI choice shows it. */
export type ClaudeCodeReading =
  | { kind: "checking" }
  | { kind: "no-answer" }
  | { kind: "missing" }
  | { kind: "too-old"; version: string }
  | { kind: "signed-out"; version: string }
  | { kind: "ready"; version: string };

export const readingOf = (status: ClaudeCodeStatus | null): ClaudeCodeReading =>
  status === null
    ? { kind: "no-answer" }
    : !status.installed
      ? { kind: "missing" }
      : status.tooOld
        ? { kind: "too-old", version: status.version }
        : status.signedIn
          ? { kind: "ready", version: status.version }
          : { kind: "signed-out", version: status.version };

export const claudeCodeWords = (reading: ClaudeCodeReading): string => {
  switch (reading.kind) {
    case "checking":
      return "Checking Claude Code…";
    case "no-answer":
      return "Constellation couldn't check Claude Code. Press Check again.";
    case "missing":
      return "Claude Code isn't installed on this Mac. Install it, then press Check again.";
    case "too-old":
      return `Update Claude Code. You have ${reading.version}, and Constellation needs ${CLAUDE_CODE_MINIMUM} or newer. Then press Check again.`;
    case "signed-out":
      return "Claude Code is signed out. Open Terminal, run claude and sign in, then press Check again.";
    case "ready":
      return `Ready. Claude Code ${reading.version} is signed in.`;
  }
};

/** "Weekly limit: 16% used, resets Fri 9:00 AM", in the Mac's time zone. Null before the first run reports one. */
export const weeklyWords = (weekly: ClaudeCodeStatus["weekly"]): string | null =>
  weekly === null
    ? null
    : `Weekly limit: ${Math.round(weekly.usedPercent)}% used, resets ${new Date(
        weekly.resetsAt,
      ).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
