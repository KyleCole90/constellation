import { isoTime, type SchoolId, type ThreadId } from "~/shared/domain/ids";
import { refs } from "~/shared/providers/canvas-refs";
import { assignmentCanvasId, SEED, type SeedAssignment } from "~/shared/providers/fake-canvas/seed";

import { GRADING_LIST_THREAD, INBOX_THREAD, NORTH_STAR_THREAD } from "./selectors";
import type { Thread, ThreadMessage, ThreadSubject } from "./types";

const OPEN = "NLR";
const openIn = (assignment: SeedAssignment): number =>
  [...assignment.statuses].filter((status) => OPEN.includes(status)).length;
const countOf = (assignment: SeedAssignment, status: string): number =>
  [...assignment.statuses].filter((s) => s === status).length;
const fmtDue = (due: string): string =>
  new Date(due).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

const MINUTE = 60_000;
const ageMinutes = (label: string): number => {
  const amount = Number.parseInt(label, 10);
  return label.endsWith("d") ? amount * 1440 : label.endsWith("h") ? amount * 60 : amount;
};

export const seedThreads = (): Readonly<Record<ThreadId, Thread>> => {
  const epoch = new Date(SEED.now).getTime();
  const at = (minutesAgo: number) => isoTime(epoch - minutesAgo * MINUTE);
  const threads: Thread[] = [];

  threads.push({
    id: NORTH_STAR_THREAD,
    school: null,
    course: null,
    kind: "north-star",
    title: "North Star",
    focus: null,
    updatedAt: at(0),
    messages: [],
  });

  const queueAt = at(0);
  threads.push({
    id: GRADING_LIST_THREAD,
    school: null,
    course: null,
    kind: "queue",
    title: "Grading list",
    focus: null,
    updatedAt: queueAt,
    messages: [
      {
        type: "work",
        lines: ["Read your connected schools", "Sorted ungraded submissions by due date"],
        at: queueAt,
      },
      {
        type: "agent",
        text: "Everything that needs a grade is in the list above, oldest due date first. Open one to read it, then ask me for a draft or grade it yourself. Nothing goes to the LMS until you approve it.",
        at: queueAt,
      },
    ],
  });

  SEED.courses.forEach((course, courseIndex) => {
    const school = course.schoolId as SchoolId;
    const courseRef = refs.course(school, course.canvasId);
    for (const thread of course.threads) {
      const updatedAt = at(ageMinutes(thread.time));
      const assignmentIndex = course.assignments.findIndex((a) => a.id === thread.assignmentId);
      const assignment = course.assignments[assignmentIndex];
      let messages: readonly ThreadMessage[] = [];
      if (thread.kind === "grading" && assignment) {
        const size = assignment.statuses.length;
        const notes = [
          countOf(assignment, "L") && `${countOf(assignment, "L")} late`,
          countOf(assignment, "R") && `${countOf(assignment, "R")} resubmitted`,
        ]
          .filter(Boolean)
          .join(", ");
        const absent = course.students.filter((_, student) => assignment.statuses[student] === "M");
        messages = [
          {
            type: "work",
            lines: [
              `Read ${size} submission records`,
              assignment.rubric
                ? `Loaded rubric: ${assignment.rubric.length} criteria, ${assignment.pts} points`
                : `No rubric on this assignment. Scoring out of ${assignment.pts}`,
            ],
            at: updatedAt,
          },
          {
            type: "agent",
            text: `**${openIn(assignment)}** ${openIn(assignment) === 1 ? "still needs" : "still need"} a grade${notes ? ` (${notes})` : ""}. ${assignment.title} was due ${fmtDue(assignment.due)}.${absent.length > 0 ? ` ${absent.join(", ")} ${absent.length === 1 ? "hasn't" : "haven't"} turned anything in. Missing work sits at the end of the list.` : ""}`,
            at: updatedAt,
          },
        ];
      }
      if (thread.kind === "messages") {
        messages = [
          {
            type: "work",
            lines: [`Read ${course.messages.length} unread conversations`],
            at: updatedAt,
          },
          {
            type: "agent",
            text: `There are **${course.messages.length} unread messages**. Open one and I'll draft a reply.`,
            at: updatedAt,
          },
        ];
      }
      if (thread.kind === "announcement") {
        const posted = course.announcements[0];
        messages = [
          {
            type: "work",
            lines: [`Read the last announcement: "${posted?.title ?? ""}"`],
            at: updatedAt,
          },
          { type: "agent", text: `Your last post was **${posted?.title ?? ""}**.`, at: updatedAt },
        ];
      }
      const subjectOf = (): ThreadSubject => {
        if (thread.kind !== "grading") return { kind: thread.kind, school, course: courseRef };
        if (!assignment)
          throw new Error(`Seed thread ${thread.id} grades an assignment its course doesn't have.`);
        return {
          kind: "grading",
          school,
          course: courseRef,
          assignment: refs.assignment(
            school,
            course.canvasId,
            assignmentCanvasId(assignment, courseIndex, assignmentIndex),
          ),
        };
      };
      const subject = subjectOf();
      threads.push({
        ...subject,
        id: thread.id as ThreadId,
        title: thread.title,
        messages,
        focus: null,
        updatedAt,
      });
    }
  });

  threads.push({
    id: INBOX_THREAD,
    school: null,
    course: null,
    kind: "messages",
    title: "Messages",
    messages: [],
    focus: null,
    updatedAt: at(0),
  });
  threads.push({
    id: "t-general" as ThreadId,
    school: null,
    course: null,
    kind: "general",
    title: "New thread",
    messages: [],
    focus: null,
    updatedAt: at(0),
  });
  return Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      { ...thread, messages: thread.messages.map((message) => ({ ...message, seeded: true })) },
    ]),
  );
};
