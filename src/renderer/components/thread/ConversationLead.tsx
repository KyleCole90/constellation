import type { Conversation } from "~/shared/domain/lms";
import { cn, formatDayTime } from "~/renderer/lib/utils";
import type { Thread } from "~/renderer/stores/types";
import { useAiOn, useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { Button } from "../ui/button";

function History({ conversation }: { conversation: Conversation }) {
  return (
    <ol data-testid="history" className="flex flex-col gap-3">
      {conversation.messages.map((message) => (
        <li
          key={message.id}
          data-message={message.id}
          data-mine={message.mine}
          className={cn(
            "flex max-w-[86%] flex-col items-start gap-1",
            message.mine && "items-end self-end",
          )}
        >
          <span className={cn("text-meta text-muted-foreground", message.mine && "text-right")}>
            {message.mine ? "You" : message.author} · {formatDayTime(message.at)}
          </span>
          <span
            className={cn(
              "rounded-2xl px-3 py-2 text-chat whitespace-pre-wrap",
              message.mine ? "bg-message" : "border border-border bg-card",
            )}
          >
            {message.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The conversation, and a way to reply when nothing is open on it: just opened with AI on, or after a Discard. Opening never drafts, since a draft costs a model call. */
export function ConversationLead({
  thread,
  conversation,
}: {
  thread: Thread;
  conversation: Conversation;
}) {
  const working = useWorkspace((state) => state.working[thread.id] ?? false);
  const ai = useAiOn();
  const last = conversation.messages.at(-1);
  const open = (fill: "draft" | "by-hand") =>
    void workspaceStore().getState().openConversation(thread.id, conversation.ref, { fill });
  return (
    <>
      <History conversation={conversation} />
      {thread.focus === null && !working && last && !last.mine && (
        <div className="flex flex-wrap gap-btn-gap">
          <Button
            variant="default"
            data-draft-reply
            data-lands="[data-card-primary]"
            onClick={() => open("draft")}
          >
            {ai ? "Draft a reply" : "Write a reply"}
          </Button>
          {ai && (
            <Button
              variant="outline"
              data-write-reply
              data-lands="[data-change] textarea, [data-card-primary]"
              onClick={() => open("by-hand")}
            >
              Write it yourself
            </Button>
          )}
        </div>
      )}
    </>
  );
}
