import { useNavigate } from "@tanstack/react-router";
import { ArrowUp } from "lucide-react";
import { useState } from "react";

import type { LmsRef } from "~/domain/ids";
import { selectConversation, selectThreadUi } from "~/stores/selectors";
import type { Thread } from "~/stores/types";
import { useAiOn, useWorkspace, workspaceStore } from "~/stores/workspace";

import { useSetupStep } from "../setup/SetupScreen";
import { Button } from "../ui/button";
import { composerHints } from "./composer.logic";
import { NextUp } from "./NextUp";
import { useChange } from "./useChange";
import { useCommitOnLeave } from "./useCommitOnLeave";

export function Composer({
  thread,
  batching = false,
  hero = false,
}: {
  thread: Thread;
  batching?: boolean;
  hero?: boolean;
}) {
  const ai = useAiOn();
  const working = useWorkspace((state) => state.working[thread.id] ?? false);
  const focused = useChange(thread.focus);
  const setupStep = useSetupStep(thread);
  const conversation = useWorkspace((state) => {
    const { current } = selectThreadUi(state, thread.id);
    if (thread.kind !== "messages" || !current) return undefined;
    const open = selectConversation(state, current as LmsRef<"conversation">);
    if (!open) return undefined;
    return open.messages.at(-1)?.mine ? "answered" : "unanswered";
  });
  const navigate = useNavigate();
  const saved = () => selectThreadUi(workspaceStore().getState(), thread.id).composer ?? "";
  const [text, setText] = useState(saved);
  useCommitOnLeave(() => {
    if (text !== saved()) workspaceStore().getState().setThreadUi(thread.id, { composer: text });
  });
  const hints = composerHints({
    kind: thread.kind,
    content: batching ? null : (focused?.record.content ?? null),
    canEdit: focused?.summary.canEdit ?? false,
    setupStep,
    conversation,
  });

  const correcting = !batching && setupStep === undefined && (focused?.summary.canEdit ?? false);

  const submit = (value: string) => {
    if (!value.trim() || working) return;
    setText("");
    if (!hero) return void workspaceStore().getState().sendToAgent(thread.id, value.trim());
    const started = workspaceStore().getState().startChat(value.trim());
    if (!started) return;
    const open = () => navigate({ to: "/threads/$threadId", params: { threadId: started.thread } });
    if (!document.startViewTransition) return void open();
    // A busy machine can take over 4 s to draw the chat. Chrome then skips the glide and rejects `ready`; the chat still opens.
    document.startViewTransition(open).ready.catch(() => {});
  };

  if (!ai) return null;

  const form = (
    <>
      {hints.examples.length > 0 && (
        <div data-composer-examples className="mb-2 flex flex-wrap gap-2">
          {hints.examples.map((example) => (
            <button
              key={example}
              type="button"
              disabled={working}
              onClick={() => submit(example)}
              className="inline-flex h-btn-sm cursor-pointer items-center rounded-full border border-border px-2.5 text-meta text-secondary-label hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:text-tertiary-label"
            >
              {example}
            </button>
          ))}
        </div>
      )}
      <div className="composer-shell rounded-[20px] border border-input bg-card py-2 pr-2 pl-4 focus-within:border-ring/60">
        <textarea
          data-composer
          autoFocus={thread.kind === "north-star" || thread.kind === "north-star-chat"}
          value={text}
          rows={1}
          placeholder={hints.placeholder}
          aria-label="Message the agent"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            const chord = event.metaKey || event.ctrlKey;
            if (chord && !text.trim()) return;
            event.preventDefault();
            if (chord && correcting)
              workspaceStore().getState().setThreadUi(thread.id, { panel: "writeback" });
            else submit(text);
          }}
          className="block max-h-32 min-h-[22px] w-full resize-none bg-transparent text-chat outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />
        <div className="mt-1 flex items-center gap-2">
          <span className="min-w-0 flex-1 text-meta text-muted-foreground">
            You approve every write.
          </span>
          <Button
            variant="default"
            size="icon-round"
            aria-label="Send to agent"
            disabled={!text.trim() || working}
            onClick={() => submit(text)}
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </>
  );

  if (!hero)
    return (
      <div className="composer-fade mx-auto w-full max-w-chat flex-none px-4 pt-4 pb-3">{form}</div>
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-chat px-4 pt-24 pb-6">
        <h1
          data-testid="hero-headline"
          className="pb-4 text-center text-2xl font-medium tracking-tight text-foreground sm:text-3xl"
        >
          What should we work on?
        </h1>
        {form}
        <NextUp />
      </div>
    </div>
  );
}
