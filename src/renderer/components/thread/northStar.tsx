import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Star } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import type { AnswerLine as Line } from "~/shared/agent/agent";
import type { ThreadId } from "~/shared/domain/ids";
import { cn } from "~/renderer/lib/utils";
import {
  selectAssignment,
  selectCourse,
  selectHandoffName,
  selectSource,
  selectThreadStatus,
} from "~/renderer/stores/selectors";
import type { ThreadMessage } from "~/renderer/stores/types";
import { useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { SchoolBadge } from "../SchoolBadge";
import { useWorkLinks } from "../screens/workLinks";
import { StatusPill } from "../StatusPill";

function HandoffCard({
  message,
  from,
}: {
  message: Extract<ThreadMessage, { type: "handoff" }>;
  from: ThreadId;
}) {
  const course = useWorkspace((state) => selectCourse(state, message.course));
  const title = useWorkspace((state) => selectHandoffName(state, message));
  const status = useWorkspace(useShallow((state) => selectThreadStatus(state, message.to)));
  return (
    <li>
      <Link
        to="/threads/$threadId"
        params={{ threadId: message.to }}
        state={{ fromChat: from }}
        data-handoff={message.to}
        className="flex min-h-row-two min-w-0 items-center gap-2 pr-row-end pl-row-x hover:bg-accent focus-inset rounded-md"
      >
        {course && <SchoolBadge school={course.school} />}
        {course && <span className="flex-none text-meta text-secondary-label">{course.code}</span>}
        <span className="min-w-0 flex-1 py-row-y">
          <span className="block truncate text-body">{title}</span>
          <span className="block truncate text-meta text-muted-foreground">{message.brief}</span>
        </span>
        {status && <StatusPill {...status} />}
        <span className="flex flex-none items-center gap-0.5 text-meta text-info-foreground">
          Open
          <ChevronRight className="size-3" />
        </span>
      </Link>
    </li>
  );
}

/** Handoffs in a row are one answer, so they read as one list. */
export function HandoffGroup({
  messages,
  from,
}: {
  messages: readonly Extract<ThreadMessage, { type: "handoff" }>[];
  from: ThreadId;
}) {
  return (
    <ul
      data-testid="handoff-group"
      className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card"
    >
      {messages.map((message, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- entries are rendered whole from props and carry no id
        <HandoffCard key={index} message={message} from={from} />
      ))}
    </ul>
  );
}

export function HandedOffBanner({
  message,
}: {
  message: Extract<ThreadMessage, { type: "handed-off" }>;
}) {
  return (
    <div
      data-testid="handed-off"
      role="note"
      className="flex flex-col gap-1 rounded-lg border border-border bg-card px-banner-x py-banner-y"
    >
      <div className="flex items-center gap-2">
        <Star className="size-3.5 flex-none text-muted-foreground" />
        <span className="min-w-0 flex-1 text-body font-medium">From North Star</span>
        <Link
          to="/threads/$threadId"
          params={{ threadId: message.from }}
          className="link flex-none text-meta whitespace-nowrap"
        >
          Back to the chat
        </Link>
      </div>
      <p className="text-chat">{message.request}</p>
      {message.left && (
        <p className="text-meta text-warning-foreground">Left out of this draft: {message.left}</p>
      )}
    </div>
  );
}

const CHIP =
  "inline-flex h-btn-sm max-w-full min-w-0 cursor-pointer items-center rounded-full border border-border px-2.5 text-meta hover:bg-accent";

function AnswerLink({ line: { source, title, detail } }: { line: Line }) {
  const view = useWorkspace((state) => selectSource(state, source));
  const links = useWorkLinks();
  const navigate = useNavigate();
  if (!view) return null;
  const open = () => {
    switch (source.kind) {
      case "assignment": {
        const assignment = selectAssignment(workspaceStore().getState(), source.ref);
        return assignment ? links.assignment(assignment) : undefined;
      }
      case "conversation":
        return links.inbox(source.ref);
      case "submission":
        return links.submission(source.ref);
      case "course":
        return void navigate({ to: "/courses/$courseId", params: { courseId: source.ref } });
      case "announcement":
        return view.course
          ? void navigate({
              to: "/courses/$courseId/announcements",
              params: { courseId: view.course },
            })
          : undefined;
      case "change": {
        const state = workspaceStore().getState();
        const change = state.changes[source.ref];
        const course = view.course && selectCourse(state, view.course);
        return change && course ? links.change(change, course) : undefined;
      }
      case "due":
        return void navigate({ to: "/due" });
    }
  };
  return (
    <button
      type="button"
      data-source={source.kind}
      data-row-hit
      onClick={open}
      className="-mx-2 block w-[calc(100%+1rem)] cursor-pointer rounded-md px-2 py-1 text-left whitespace-pre-wrap hover:bg-accent"
    >
      <span className="font-medium text-info-foreground">{title}</span>
      {detail && <span className="text-secondary-label">{`  ${detail}`}</span>}
    </button>
  );
}

export function AnswerLines({ lines }: { lines: readonly Line[] }) {
  return (
    <ul data-testid="sources" className="mt-1">
      {lines.map((line, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- pieces split from one string have no id and can repeat
        <li key={index}>
          <AnswerLink line={line} />
        </li>
      ))}
    </ul>
  );
}

export function ReplyChips({ thread, replies }: { thread: ThreadId; replies: readonly string[] }) {
  const working = useWorkspace((state) => state.working[thread] ?? false);
  const send = (text: string) => {
    void workspaceStore().getState().sendToAgent(thread, text);
    document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus();
  };
  return (
    <div data-testid="replies" className="mt-2 flex flex-wrap gap-2">
      {replies.map((text, index) => (
        <button
          // oxlint-disable-next-line react/no-array-index-key -- pieces split from one string have no id and can repeat
          key={index}
          type="button"
          data-reply={text}
          disabled={working}
          onClick={() => send(text)}
          className={cn(CHIP, "text-foreground disabled:cursor-default disabled:opacity-55")}
        >
          <span className="truncate">{text}</span>
        </button>
      ))}
    </div>
  );
}
