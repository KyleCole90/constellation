import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { PlannedWork } from "./due.logic";
import { useWorkLinks } from "./workLinks";

export function StepAction({
  step,
  slot,
  className,
  children,
  ...marks
}: {
  step: PlannedWork;
  slot?: "button";
  className: string;
  children: ReactNode;
  "data-card-primary"?: boolean;
  "aria-describedby"?: string;
}) {
  const links = useWorkLinks();
  const { work } = step;
  switch (work.kind) {
    case "grade":
      return (
        <button
          type="button"
          data-due-row={work.item.assignment.ref}
          onClick={() => links.startGrading(work.item.assignment)}
          data-slot={slot}
          className={className}
          {...marks}
        >
          {children}
        </button>
      );
    case "replies": {
      const [first] = work.rows;
      return (
        <button
          type="button"
          data-due-unread={first.conversation.ref}
          onClick={() => links.conversationThread(first)}
          data-slot={slot}
          className={className}
          {...marks}
        >
          {children}
        </button>
      );
    }
    case "announcement":
      return (
        <button
          type="button"
          data-due-draft={work.draft.thread.id}
          onClick={() => links.announcement(work.draft.course)}
          data-slot={slot}
          className={className}
          {...marks}
        >
          {children}
        </button>
      );
    case "reconnect":
      return (
        <Link to="/settings" data-slot={slot} className={className} {...marks}>
          {children}
        </Link>
      );
  }
}
