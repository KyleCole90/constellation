import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import type { ChangeRecord } from "~/domain/change";
import type { LmsRef, ThreadId } from "~/domain/ids";
import type { Assignment, Course } from "~/domain/lms";
import {
  INBOX_THREAD,
  selectAssignment,
  selectCourse,
  selectInboxRows,
  selectQueueRows,
  selectSubmission,
  type GradebookCell,
  type InboxRow,
} from "~/stores/selectors";
import { workspaceStore } from "~/stores/workspace";

import { cellTarget } from "./gradebook.logic";

const store = () => workspaceStore().getState();

const gradingThread = (assignment: Assignment): ThreadId | null => {
  const state = store();
  const course = selectCourse(state, assignment.course);
  return course && state.threadForWork(course, { kind: "grading", assignment: assignment.ref });
};

/** Selecting a conversation reads it, and shows it from the bottom rather than where another one was left. */
export const markInboxOpened = (conversation: LmsRef<"conversation">) => {
  store().setThreadUi(INBOX_THREAD, { current: conversation, panel: null, scrollTop: null });
  store().setConversationRead(conversation, true);
};

/** Back and Forward come here too, so this only shows what is there and drafts nothing. */
export const showInInbox = (conversation: LmsRef<"conversation">) => {
  const row = selectInboxRows(store()).find(
    (candidate) => candidate.conversation.ref === conversation,
  );
  markInboxOpened(conversation);
  store().focusChange(INBOX_THREAD, row?.change?.id ?? null);
  return row;
};

const openInInbox = (conversation: LmsRef<"conversation">) => {
  const row = showInInbox(conversation);
  if (row?.last?.mine !== true) void store().openConversation(INBOX_THREAD, conversation);
};

/** Each one sets the destination up and then goes there, so every screen arrives at the same state. */
export const useWorkLinks = () => {
  const navigate = useNavigate();
  return useMemo(() => {
    const toThread = (id: ThreadId) =>
      void navigate({ to: "/threads/$threadId", params: { threadId: id } });
    return {
      assignment: (assignment: Assignment) => {
        const thread = gradingThread(assignment);
        if (!thread) return;
        store().setThreadUi(thread, { queueOpen: true });
        toThread(thread);
      },
      startGrading: (assignment: Assignment) => {
        const state = store();
        const thread = gradingThread(assignment);
        if (!thread) return;
        const first = selectQueueRows(state, assignment.ref).find((row) => row.open);
        state.setThreadUi(thread, {
          queueOpen: !first,
          ...(first ? { current: first.submission.ref, panel: "source" as const } : {}),
        });
        state.focusChange(thread, first?.change?.id ?? null);
        if (first && !first.change) void state.openSubmission(thread, first.submission.ref);
        toThread(thread);
      },
      conversationThread: (row: InboxRow, { queueOpen = false }: { queueOpen?: boolean } = {}) => {
        const state = store();
        const thread = state.threadForWork(row.course, { kind: "replies" });
        state.setThreadUi(thread, { current: row.conversation.ref, queueOpen, panel: "source" });
        state.focusChange(thread, row.change?.id ?? null);
        if (row.last?.mine !== true) void state.openConversation(thread, row.conversation.ref);
        toThread(thread);
      },
      submission: (submission: LmsRef<"submission">) => {
        const state = store();
        const found = selectSubmission(state, submission);
        const assignment =
          found?.workflow === "missing" ? selectAssignment(state, found.assignment) : null;
        if (assignment) {
          // Missing work is a row only in its own assignment's grading list.
          const thread = gradingThread(assignment);
          if (!thread) return;
          const row = selectQueueRows(state, assignment.ref, true).find(
            (candidate) => candidate.submission.ref === submission,
          );
          state.setThreadUi(thread, {
            current: submission,
            queueOpen: true,
            queueFilter: "all",
            panel: null,
          });
          state.focusChange(thread, row?.change?.id ?? null);
          toThread(thread);
          return;
        }
        const queue = Object.values(state.threads).find((thread) => thread.kind === "queue");
        if (!queue) return;
        state.setThreadUi(queue.id, { current: submission, queueOpen: false, panel: "source" });
        state.focusChange(queue.id, null);
        void state.openSubmission(queue.id, submission);
        toThread(queue.id);
      },
      inbox: (conversation: LmsRef<"conversation">) => {
        openInInbox(conversation);
        void navigate({ to: "/inbox", search: { conversation } });
      },
      cell: (cell: GradebookCell, assignment: Assignment) => {
        const state = store();
        const submission = cell.submission;
        const target = cellTarget(cell);
        if (!submission || target === "none") return;
        const thread = gradingThread(assignment);
        if (!thread) return;
        state.setThreadUi(thread, {
          current: submission.ref,
          queueOpen: false,
          panel: target === "record" ? "writeback" : "source",
        });
        state.focusChange(thread, cell.change?.id ?? null);
        if (target === "work") void state.openSubmission(thread, submission.ref);
        toThread(thread);
      },
      change: (change: ChangeRecord, course: Course) => {
        const state = store();
        if (change.content.kind === "reply") {
          openInInbox(change.content.target);
          void navigate({ to: "/inbox", search: { conversation: change.content.target } });
          return;
        }
        const { content } = change;
        const assignment = selectAssignment(
          state,
          content.kind === "grade" || content.kind === "message"
            ? (selectSubmission(state, content.target)?.assignment ?? null)
            : null,
        );
        const thread = assignment
          ? gradingThread(assignment)
          : state.threadForWork(course, { kind: "announcement" });
        if (!thread) return;
        state.setThreadUi(thread, {
          current: change.content.target,
          queueOpen: false,
          panel: null,
        });
        state.focusChange(thread, change.id);
        toThread(thread);
      },
      announcement: (course: Course) => {
        const state = store();
        const thread = state.threadForWork(course, { kind: "announcement" });
        state.setThreadUi(thread, { panel: null });
        state.focusChange(thread, null);
        void state.openAnnouncement(thread, course.ref);
        toThread(thread);
      },
    };
  }, [navigate]);
};
