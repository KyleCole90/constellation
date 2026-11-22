import * as v from "valibot";

import { isoTime, type ThreadId } from "~/shared/domain/ids";
import { refs } from "~/shared/providers/canvas-refs";
import { ThreadIdSchema } from "~/shared/providers/schemas";
import { SEED, type SeedAssignment } from "~/shared/providers/fake-canvas/seed";

import { builtInThreads } from "./builtInThreads";
import { GRADING_LIST_THREAD } from "./selectors";
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

  for (const course of SEED.courses) {
    const school = course.schoolId;
    const courseRef = refs.course({ school, course: course.canvasId });
    for (const thread of course.threads) {
      const updatedAt = at(ageMinutes(thread.time));
      const found = course.assignments.find((a) => a.id === thread.assignmentId);
      let messages: readonly ThreadMessage[] = [];
      if (thread.kind === "grading" && found) {
        // Off-roster students' statuses trail the roster's, and no count holds them (#151).
        const assignment = { ...found, statuses: found.statuses.slice(0, course.students.length) };
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
        if (!found)
          throw new Error(`Seed thread ${thread.id} grades an assignment its course doesn't have.`);
        return {
          kind: "grading",
          school,
          course: courseRef,
          assignment: refs.assignment({
            school,
            course: course.canvasId,
            assignment: found.canvasId,
          }),
        };
      };
      const subject = subjectOf();
      threads.push({
        ...subject,
        id: v.parse(ThreadIdSchema, thread.id),
        title: thread.title,
        messages,
        focus: null,
        updatedAt,
      });
    }
  }

  threads.push({
    id: v.parse(ThreadIdSchema, "t-general"),
    school: null,
    course: null,
    kind: "general",
    title: "New thread",
    messages: [],
    focus: null,
    updatedAt: at(0),
  });
  return {
    ...builtInThreads(at(0)),
    ...Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        { ...thread, messages: thread.messages.map((message) => ({ ...message, seeded: true })) },
      ]),
    ),
  };
};
