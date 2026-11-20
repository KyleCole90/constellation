import { describe, expect, it } from "vite-plus/test";

import { type LmsRef, isoTime } from "~/shared/domain/ids";
import {
  askedInLms,
  namingAssignment,
  type Conversation,
  type Submission,
} from "~/shared/domain/lms";
import { lmsRef, schoolId } from "./fixtures/ids";

const SCHOOL = schoolId("s");
const COURSE = lmsRef<"course">("s:course:5660");
const JOEY = lmsRef<"student">("s:student:1");
const STEPHANIE = lmsRef<"student">("s:student:2");
const PORTFOLIO = { title: "Create a Music Theory ePortfolio" };
const COMPOSITION = { title: "Create Your Own Composition - First try!" };

const submission = (student: LmsRef<"student">, assignment: string): Submission => ({
  ref: lmsRef<"submission">(`s:submission:5660:${assignment}:${student}`),
  school: SCHOOL,
  course: COURSE,
  assignment: lmsRef<"assignment">(`s:assignment:5660:${assignment}`),
  student,
  studentName: "",
  workflow: "submitted",
  attempt: 1,
  lateDays: 0,
  submittedAt: isoTime("2026-10-11T20:34:00Z"),
  grade: null,
  rubricScores: null,
  comments: [],
  body: { kind: "none" },
  page: null,
});

const sent = (
  student: LmsRef<"student">,
  subject: string,
  text: string,
  at = "2026-11-14T20:57:00Z",
): Conversation => ({
  ref: lmsRef<"conversation">(`s:conversation:${subject.length}`),
  school: SCHOOL,
  course: COURSE,
  subject,
  from: "",
  students: [student],
  unread: false,
  messages: [{ id: "1", mine: true, author: "Teacher", text, at: isoTime(at) }],
});

const SENT = [
  sent(
    JOEY,
    "Your Music Theory ePortfolio link isn't working",
    "Hi Joey, thanks for turning in your Music Theory ePortfolio. When I opened the link I got an error page.",
  ),
  sent(
    JOEY,
    "Your composition link isn't opening",
    'Hi Joey, thanks for turning in your composition for "Create Your Own Composition - First try!"',
  ),
  sent(
    STEPHANIE,
    "Your Music Theory ePortfolio link isn't working",
    "Hi Stephanie, thanks for turning in your Music Theory ePortfolio.",
  ),
];

describe("whether the LMS shows the student was asked to resubmit (#102)", () => {
  it("matches each message to the work it names, by student and course", () => {
    expect(askedInLms(SENT, submission(JOEY, "portfolio"), PORTFOLIO)).toBe(
      "2026-11-14T20:57:00.000Z",
    );
    expect(askedInLms(SENT, submission(JOEY, "composition"), COMPOSITION)).not.toBeNull();
    expect(askedInLms(SENT, submission(STEPHANIE, "portfolio"), PORTFOLIO)).not.toBeNull();
  });

  it("leaves the student's other work, and other students' work, to grade", () => {
    expect(askedInLms(SENT, submission(STEPHANIE, "composition"), COMPOSITION)).toBeNull();
    expect(
      askedInLms(SENT, submission(lmsRef<"student">("s:student:3"), "portfolio"), PORTFOLIO),
    ).toBeNull();
  });

  it("ignores a message from before the work was turned in, and one the student started", () => {
    const old = sent(JOEY, "Music Theory ePortfolio", "ePortfolio", "2026-10-01T00:00:00Z");
    const theirs: Conversation = {
      ...sent(JOEY, "Music Theory ePortfolio", "ePortfolio"),
      messages: [
        {
          id: "1",
          mine: false,
          author: "Joey",
          text: "ePortfolio",
          at: isoTime("2026-11-14T20:57:00Z"),
        },
      ],
    };
    expect(askedInLms([old, theirs], submission(JOEY, "portfolio"), PORTFOLIO)).toBeNull();
  });

  it("a message that doesn't name its assignment gets a line that does", () => {
    const message = { subject: "Your link isn't working", body: "Hi Joey, can you resubmit?\n" };
    expect(namingAssignment(message, PORTFOLIO).body).toBe(
      "Hi Joey, can you resubmit?\n\nAssignment: Create a Music Theory ePortfolio",
    );
    const named = { subject: "Your Music Theory ePortfolio link", body: "Hi" };
    expect(namingAssignment(named, PORTFOLIO)).toBe(named);
  });
});
