import { CLAUDE_CODE_SETUP_URL } from "~/renderer/desktop";
import { ArrowUpRight, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ClaudeCodeStatus } from "~/shared/ipc";
import { cn } from "~/renderer/lib/utils";
import { workspaceStore } from "~/renderer/stores/workspace";

import { Button } from "../ui/button";
import { claudeCodeWords, readingOf, type ClaudeCodeReading } from "./claude-code.logic";

/** Asks main about the teacher's Claude Code once `active` turns true, and again on each `check`. */
export const useClaudeCode = (active: boolean) => {
  const [read, setRead] = useState<ClaudeCodeStatus | null | "checking">("checking");
  // A slow answer to an earlier check must not overwrite a newer one.
  const asked = useRef(0);
  const ask = useCallback(async () => {
    const mine = ++asked.current;
    const status = await workspaceStore().getState().claudeCodeStatus();
    if (mine === asked.current) setRead(status);
  }, []);
  const check = useCallback(() => {
    setRead("checking");
    void ask();
  }, [ask]);
  useEffect(() => {
    if (active) void ask();
  }, [active, ask]);
  const reading: ClaudeCodeReading = read === "checking" ? { kind: "checking" } : readingOf(read);
  return { reading, weekly: read === "checking" ? null : (read?.weekly ?? null), check };
};

export function ClaudeCodeCheck({
  reading,
  onCheck,
}: {
  reading: ClaudeCodeReading;
  onCheck: () => void;
}) {
  const ready = reading.kind === "ready";
  return (
    <div
      data-testid="claude-code-status"
      data-reading={reading.kind}
      className="flex flex-col gap-2"
    >
      <p
        role="status"
        className={cn(
          "flex items-start gap-1.5 text-meta",
          ready ? "text-success-foreground" : "text-muted-foreground",
        )}
      >
        {ready && <Check aria-hidden className="mt-0.5 size-3 flex-none" />}
        {claudeCodeWords(reading)}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {reading.kind === "missing" && (
          <a
            href={CLAUDE_CODE_SETUP_URL}
            target="_blank"
            rel="noreferrer"
            className="link flex items-center gap-1 whitespace-nowrap text-meta"
          >
            Install Claude Code <ArrowUpRight className="size-3" />
          </a>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={reading.kind === "checking"}
          onClick={onCheck}
        >
          Check again
        </Button>
      </div>
    </div>
  );
}
