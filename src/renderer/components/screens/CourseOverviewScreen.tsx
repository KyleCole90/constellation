import { Link } from "@tanstack/react-router";
import { ListChecks, Megaphone, MessageSquare, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { LmsRef } from "~/shared/domain/ids";
import type { Course } from "~/shared/domain/lms";
import { cn, formatDay, formatDayTime } from "~/renderer/lib/utils";
import {
  isSettled,
  selectCourseOverview,
  selectThreadName,
  selectThreadStatus,
  withoutChatThreads,
  type NeedsYou,
  type RosterRow,
} from "~/renderer/stores/selectors";
import type { Thread } from "~/renderer/stores/types";
import { useAiOn, useWorkspace } from "~/renderer/stores/workspace";

import { StatusPill } from "../StatusPill";
import { Badge, SubmissionBadge } from "../ui/badge";
import { Button } from "../ui/button";
import { OpensChevron } from "../ui/chevron";
import { TAB, toggleState } from "../ui/toggle";
import { useNewThread } from "../useNewThread";
import { SaveTemplateButton } from "../setup/SaveTemplateButton";
import { behindFirst } from "./course.logic";
import { CoursePage } from "./CourseHeader";
import { dueProgress } from "./due.logic";
import { useWorkLinks } from "./workLinks";

const ROW =
  "flex min-h-row-one w-full min-w-0 cursor-pointer items-center gap-2 py-1 pr-row-end pl-row-x text-left text-body hover:bg-accent focus-inset rounded-md";

function Section({
  name,
  title,
  action,
  flash = false,
  children,
}: {
  name: string;
  title: string;
  action?: ReactNode;
  flash?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      data-section={name}
      data-flash={flash}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border"
    >
      <div className="flex flex-none items-center justify-between border-b border-border bg-card px-row-x py-card-head-y">
        <h2 className="text-title text-foreground">{title}</h2>
        {action && <div className="-my-1.5 -mr-1.5">{action}</div>}
      </div>
      {children}
    </section>
  );
}

const List = ({ children }: { children: ReactNode }) => (
  <ul className="divide-y divide-border">{children}</ul>
);
const Nothing = ({ children }: { children: ReactNode }) => (
  <p className="px-3 py-2.5 text-meta text-muted-foreground">{children}</p>
);

function Stat({
  label,
  value,
  testId,
  onClick,
}: {
  label: string;
  value: string | number;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-row-hit
      data-stat={testId}
      onClick={onClick}
      className="flex cursor-pointer flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 text-left hover:bg-accent"
    >
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="tabular-nums text-page">{value}</span>
    </button>
  );
}

function NeedsYouRow({ item, course }: { item: NeedsYou; course: Course }) {
  const links = useWorkLinks();
  switch (item.kind) {
    case "change":
      return (
        <li data-row>
          <button type="button" className={ROW} onClick={() => links.change(item.change, course)}>
            <ListChecks className="size-3 flex-none text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{item.change.subject}</span>
            <StatusPill tone={item.summary.tone} label={item.summary.label} />
            <OpensChevron />
          </button>
        </li>
      );
    case "assignment":
      return (
        <li data-row>
          <button
            type="button"
            className={ROW}
            onClick={() => links.assignment(item.item.assignment)}
          >
            <ListChecks className="size-3 flex-none text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{item.item.assignment.title}</span>
            <StatusPill tone="todo" label={`${item.item.toGrade} to grade`} />
            <OpensChevron />
          </button>
        </li>
      );
    case "conversation":
      return (
        <li data-row>
          <button
            type="button"
            className={ROW}
            onClick={() => links.inbox(item.row.conversation.ref)}
          >
            <MessageSquare className="size-3 flex-none text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {item.row.conversation.from}{" "}
              <span className="text-muted-foreground">· {item.row.conversation.subject}</span>
            </span>
            {item.row.summary ? (
              <StatusPill tone={item.row.summary.tone} label={item.row.summary.label} />
            ) : (
              <StatusPill tone="unread" label="Unread" />
            )}
            <OpensChevron />
          </button>
        </li>
      );
  }
}

function RosterItem({ row, courseId }: { row: RosterRow; courseId: LmsRef<"course"> }) {
  return (
    <li data-row>
      <Link
        to="/courses/$courseId/gradebook"
        params={{ courseId }}
        hash={row.student.ref}
        data-roster={row.student.ref}
        className={ROW}
      >
        <span className="min-w-0 flex-1 truncate">{row.student.name}</span>
        {row.missing > 0 && (
          <SubmissionBadge data-missing-flag status="missing">
            {row.missing} missing
          </SubmissionBadge>
        )}
        <span className="flex w-[88px] flex-none justify-end">
          <Badge
            tone={
              row.standing === "At risk"
                ? "danger"
                : row.standing === "Watch"
                  ? "warning"
                  : "neutral"
            }
          >
            {row.standing}
          </Badge>
        </span>
        <span className="w-[38px] flex-none text-right tabular-nums text-meta text-muted-foreground">
          {row.percent === null ? "–" : `${row.percent}%`}
        </span>
        <OpensChevron />
      </Link>
    </li>
  );
}

function Roster({
  roster,
  courseId,
}: {
  roster: readonly RosterRow[];
  courseId: LmsRef<"course">;
}) {
  const [behind, setBehind] = useState(false);
  const rows = behind ? behindFirst(roster) : roster;
  return (
    <Section
      name="roster"
      title={`Roster (${roster.length})`}
      action={
        roster.length > 1 && (
          <button
            type="button"
            data-sort-behind
            aria-pressed={behind}
            onClick={() => setBehind(!behind)}
            className={cn(TAB, toggleState(behind))}
          >
            Behind first
          </button>
        )
      }
    >
      {roster.length === 0 ? (
        <Nothing>No students yet.</Nothing>
      ) : (
        <List>
          {rows.map((row) => (
            <RosterItem key={row.student.ref} row={row} courseId={courseId} />
          ))}
        </List>
      )}
    </Section>
  );
}

function ThreadItem({ thread }: { thread: Thread }) {
  const status = useWorkspace((state) => selectThreadStatus(state, thread.id));
  const name = useWorkspace((state) => selectThreadName(state, thread.id));
  return (
    <li data-row>
      <Link
        to="/threads/$threadId"
        params={{ threadId: thread.id }}
        data-course-thread={thread.id}
        className={ROW}
      >
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {status && <StatusPill {...status} />}
        <OpensChevron />
      </Link>
    </li>
  );
}

export function CourseOverviewScreen({ courseId }: { courseId: LmsRef<"course"> }) {
  const overview = useWorkspace((state) => selectCourseOverview(state, courseId, state.now()));
  const links = useWorkLinks();
  const newThread = useNewThread();
  const ai = useAiOn();
  const threads = overview ? withoutChatThreads(overview.threads, ai) : [];
  const open = threads.filter((thread) => !isSettled(thread));
  // Each press of To grade flashes Needs you again; the key restarts the animation.
  const [pointed, setPointed] = useState(0);
  return (
    <CoursePage courseId={courseId} actions={<SaveTemplateButton course={courseId} />}>
      {(course) =>
        overview && (
          <div data-testid="course-overview" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-3 px-4 py-3">
              <div className="grid grid-cols-4 gap-2">
                <Stat
                  label="To grade"
                  testId="to-grade"
                  value={overview.toGrade}
                  onClick={() => {
                    // One assignment's list holds the whole count. Otherwise Needs you lists each assignment with its share.
                    const grading = overview.assignments.filter((item) => item.toGrade > 0);
                    if (grading.length === 1 && grading[0]) {
                      links.assignment(grading[0].assignment);
                      return;
                    }
                    setPointed((count) => count + 1);
                    document
                      .querySelector('[data-section="needs-you"]')
                      ?.scrollIntoView({ block: "start" });
                  }}
                />
                <Stat
                  label="Due this week"
                  testId="due-this-week"
                  value={overview.dueThisWeek}
                  onClick={() =>
                    document
                      .querySelector('[data-section="assignments"]')
                      ?.scrollIntoView({ block: "start" })
                  }
                />
                <Stat
                  label="Unread"
                  testId="unread"
                  value={overview.unread}
                  onClick={() =>
                    document
                      .querySelector('[data-section="messages"]')
                      ?.scrollIntoView({ block: "start" })
                  }
                />
                <Stat
                  label="Average"
                  testId="average"
                  value={overview.classAverage === null ? "–" : `${overview.classAverage}%`}
                  onClick={() =>
                    document
                      .querySelector('[data-section="roster"]')
                      ?.scrollIntoView({ block: "start" })
                  }
                />
              </div>
              <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start gap-3">
                <div className="flex min-w-0 flex-col gap-3">
                  <Section key={pointed} name="needs-you" title="Needs you" flash={pointed > 0}>
                    {overview.needsYou.length === 0 ? (
                      <Nothing>Nothing is waiting on you here.</Nothing>
                    ) : (
                      <List>
                        {overview.needsYou.map((item) => (
                          <NeedsYouRow
                            key={
                              item.kind === "change"
                                ? item.change.id
                                : item.kind === "assignment"
                                  ? item.item.assignment.ref
                                  : item.row.conversation.ref
                            }
                            item={item}
                            course={course}
                          />
                        ))}
                      </List>
                    )}
                  </Section>
                  <Section name="assignments" title="Assignments to finish">
                    {overview.assignments.length === 0 ? (
                      <Nothing>Nothing is coming up.</Nothing>
                    ) : (
                      <List>
                        {overview.assignments.map((item) => (
                          <li key={item.assignment.ref} data-row>
                            <button
                              type="button"
                              data-course-assignment={item.assignment.ref}
                              className={ROW}
                              onClick={() => links.assignment(item.assignment)}
                            >
                              <span className="w-[48px] flex-none text-meta text-muted-foreground tabular-nums">
                                {item.assignment.dueAt && formatDay(item.assignment.dueAt)}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {item.assignment.title}
                              </span>
                              <span className="flex-none text-meta text-secondary-label tabular-nums">
                                {dueProgress(item).label}
                              </span>
                              <OpensChevron />
                            </button>
                          </li>
                        ))}
                      </List>
                    )}
                  </Section>
                  <Section
                    name="threads"
                    title="Threads"
                    action={
                      newThread && (
                        <Button variant="ghost-muted" size="sm" onClick={() => newThread(course)}>
                          <Plus className="size-3" />
                          New thread
                        </Button>
                      )
                    }
                  >
                    {open.length === 0 ? (
                      <Nothing>
                        {threads.length === 0
                          ? "No threads in this course yet."
                          : "Every thread here is settled."}
                      </Nothing>
                    ) : (
                      <List>
                        {open.map((thread) => (
                          <ThreadItem key={thread.id} thread={thread} />
                        ))}
                      </List>
                    )}
                  </Section>
                </div>
                <div className="flex min-w-0 flex-col gap-3">
                  <Section name="announcements" title="Recent announcements">
                    {overview.recentAnnouncements.length === 0 ? (
                      <Nothing>Nothing posted yet.</Nothing>
                    ) : (
                      <List>
                        {overview.recentAnnouncements.map((announcement) => (
                          <li key={announcement.ref} data-row>
                            <Link
                              to="/courses/$courseId/announcements"
                              params={{ courseId }}
                              data-course-announcement={announcement.ref}
                              className={ROW}
                            >
                              <Megaphone className="size-3 flex-none text-muted-foreground" />
                              <span className="min-w-0 flex-1 truncate">{announcement.title}</span>
                              <span className="flex-none text-meta text-muted-foreground">
                                {formatDay(announcement.postedAt)}
                              </span>
                              <OpensChevron />
                            </Link>
                          </li>
                        ))}
                      </List>
                    )}
                  </Section>
                  <Section name="messages" title="Recent messages">
                    {overview.recentMessages.length === 0 ? (
                      <Nothing>No messages in this course.</Nothing>
                    ) : (
                      <List>
                        {overview.recentMessages.map((row) => (
                          <li key={row.conversation.ref} data-row>
                            <button
                              type="button"
                              data-course-message={row.conversation.ref}
                              className={ROW}
                              onClick={() => links.inbox(row.conversation.ref)}
                            >
                              <span
                                aria-label={row.conversation.unread ? "Unread" : undefined}
                                className={cn(
                                  "size-1.5 flex-none rounded-full",
                                  row.conversation.unread ? "bg-info-foreground" : "bg-transparent",
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {row.conversation.from}{" "}
                                <span className="text-muted-foreground">
                                  · {row.conversation.subject}
                                </span>
                              </span>
                              <span className="flex-none text-meta text-muted-foreground">
                                {row.last && formatDayTime(row.last.at)}
                              </span>
                              <OpensChevron />
                            </button>
                          </li>
                        ))}
                      </List>
                    )}
                  </Section>
                  <Roster roster={overview.roster} courseId={courseId} />
                </div>
              </div>
            </div>
          </div>
        )
      }
    </CoursePage>
  );
}
