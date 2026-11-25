import type { AiSource } from "~/shared/ai-source";

import type { ClaudeCodeReading } from "../settings/claude-code.logic";

/** Why Finish setup waits, or null once it can go. */
export const setupBlocker = ({
  connected,
  choice,
  keySaved,
  claudeCode,
  reading,
}: {
  connected: number;
  choice: AiSource | null;
  keySaved: boolean;
  claudeCode: ClaudeCodeReading;
  /** The schools whose first read is still running, as one phrase, or "" when none is. */
  reading: string;
}): string | null =>
  connected === 0
    ? "Connect a school to finish."
    : choice === null
      ? "Choose an AI option to finish."
      : choice === "key" && !keySaved
        ? "Save your key to finish."
        : choice === "claude-code" && claudeCode.kind !== "ready"
          ? "Set up Claude Code to finish."
          : reading
            ? `Reading courses from ${reading}…`
            : null;
