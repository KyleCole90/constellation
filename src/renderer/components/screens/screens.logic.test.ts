import { describe, expect, it } from "vite-plus/test";

import type { ChangeSummary } from "~/shared/domain/change";
import { isoTime } from "~/shared/domain/ids";
import type { Assignment, School, Submission } from "~/shared/domain/lms";
import type {
  DueExtras,
  DueGroup,
  DatedItem,
  DueItem,
  GradebookCell,
  GradebookRow,
  InboxRow,
  RosterRow,
  Staged,
  ThreadStatus,
  WorkStage,
} from "~/renderer/stores/selectors";

import { toneOf } from "./calendar.logic";
import { ageWords, behindFirst, isStale, syncFailureWords } from "./course.logic";
import {
  dueProgress,
  dueSummary,
  nothingDueWords,
  filterDue,
  filterExtras,
  plannedHandoffs,
  planWork,
  sittingLoad,
  sittingName,
  sittingsOf,
  sittingWhen,
  stepInstruction,
  stepReason,
  whenWords,
} from "./due.logic";
import {
  cellMarks,
  cellTarget,
  filterColumns,
  filterRows,
  nextSort,
  pendingWords,
  sortRows,
  type RowFilter,
} from "./gradebook.logic";
import { filterInbox, messagingNotes, preview, statusCount } from "./inbox.logic";
import { AT, COURSE, SCHOOL, changeSummary } from "../../../../tests/fixtures/changes";
import {
  assignment as assignmentOf,
  conversation,
  course,
  dueItem,
  inboxRow,
  school,
} from "../../../../tests/fixtures/rows";
import { lmsRef, schoolId, threadId } from "../../../../tests/fixtures/ids";

/** A course named by its ref, as the plan shows it. */
const courseOf = (ref: string) => course({ ref: lmsRef<"course">(ref), code: ref.toUpperCase() });

const lcc = school("lcc", { name: "Lakeshore" });
const rsu = school("rsu", { name: "Ridge State" });

const due = (school: School, over: Partial<DueItem> = {}) =>
  dueItem({ school, toGrade: 1, submitted: 3, graded: 2, total: 14, ...over });
const groups: readonly DueGroup[] = [
  { key: "past", label: "Past due", items: [due(lcc), due(rsu)] },
  { key: "later", label: "Later", items: [due(rsu, { toGrade: 0 })] },
];
/** An announcement thread for a course, named by its ref, with a draft under way unless `drafted` is false. */
const draft = (
  ref: string,
  tone: ThreadStatus["tone"] = "todo",
  drafted = true,
  at: School = rsu,
): DueExtras["drafts"][number] => ({
  thread: {
    id: threadId(`t-${ref}`),
    kind: "announcement",
    school: at.id,
    course: lmsRef<"course">(ref),
    title: `${ref} news`,
    messages: [],
    focus: null,
    updatedAt: AT,
  },
  name: `${ref} news`,
  course: courseOf(ref),
  school: at,
  status: { label: drafted ? "In progress" : "Not started", tone },
  drafted,
});
const extras: DueExtras = {
  drafts: [draft("lcc", "todo", true, lcc), draft("rsu")],
  replies: [inboxRow({ school: lcc }), inboxRow({ school: lcc }), inboxRow({ school: rsu })],
};

describe("the work plan", () => {
  const NOW = new Date("2026-10-30T14:00:00").getTime();
  const assignment = (
    ref: string,
    title: string,
    days: number,
    toGrade: number,
    late = 0,
  ): DatedItem => ({
    ...dueItem({
      school: rsu,
      toGrade,
      late,
      submitted: toGrade,
      total: 10,
      course: courseOf(ref),
      assignment: assignmentOf({
        ref: lmsRef<"assignment">(`${ref}:${title}`),
        course: courseOf(ref).ref,
        title,
        shortTitle: title,
        dueAt: isoTime(NOW + days * 86_400_000 + 8 * 3_600_000),
      }),
    }),
    days,
  });
  const reply = (ref: string, from: string, status?: string): InboxRow => {
    const last = {
      id: "m1",
      mine: false,
      author: from,
      text: "A question.",
      at: isoTime(NOW - 86_400_000),
    };
    return inboxRow({
      school: rsu,
      course: courseOf(ref),
      conversation: conversation({
        ref: lmsRef<"conversation">(`${ref}:${from}`),
        course: courseOf(ref).ref,
        from,
        subject: `Question from ${from}`,
        unread: true,
        messages: [last],
      }),
      last,
      summary: status
        ? changeSummary({ label: status, tone: status === "Needs approval" ? "approval" : "ready" })
        : null,
    });
  };
  const plan = (
    items: readonly DueItem[],
    over: Partial<DueExtras> = {},
    stages: ReadonlyMap<string, WorkStage | Staged> = new Map(),
    expired: readonly School[] = [],
  ) =>
    planWork({
      groups: [{ key: "past", label: "Past due", items }],
      extras: { drafts: [], replies: [], ...over },
      stages: new Map(
        [...stages].map(([ref, staged]) => [
          ref,
          typeof staged === "string" ? { stage: staged, count: 1 } : staged,
        ]),
      ),
      expired,
      now: NOW,
    });

  it("grades undated work after the course's dated work, and says it has no due date", () => {
    const journal: DueItem = {
      ...assignment("old", "Journal", 0, 3),
      days: null,
      assignment: { ...assignment("old", "Journal", 0, 3).assignment, dueAt: null },
    };
    const steps = plan([journal, assignment("old", "Memo", -8, 2)]).steps;
    expect(steps.map((step) => [step.title, step.why])).toEqual([
      ["Memo", "8 days past due."],
      ["Journal", "No due date."],
    ]);
  });

  it("puts the course with the nearest next deadline first, even when other work is older", () => {
    const steps = plan([
      assignment("old", "Memo", -8, 2),
      assignment("hot", "Analysis", -4, 4),
      assignment("old", "Instruction Set", 7, 0),
      assignment("hot", "Response", 0, 0),
    ]).steps;
    expect(steps.map((step) => step.title)).toEqual(["Analysis", "Memo"]);
    expect(steps[0]?.why).toBe("Students need this back before Response, due tonight.");
  });

  it("keeps a course's grading ahead of its announcement and its replies", () => {
    const steps = plan(
      [assignment("hot", "Analysis", -4, 4), assignment("hot", "Response", 0, 0)],
      { drafts: [draft("hot")], replies: [reply("hot", "Ezra"), reply("hot", "Amara")] },
    ).steps;
    expect(steps.map((step) => step.verb)).toEqual(["Grade", "Post", "Reply to"]);
    expect(steps[2]?.title).toBe("Ezra, Amara");
    expect(steps[2]?.detail).toBe("Not started");
  });

  it("names a grade row by the assignment's short title, as its thread does", () => {
    const item = assignment("hot", "Speech 2", -4, 4);
    const row = plan([
      { ...item, assignment: { ...item.assignment, title: "Speech 2: Informative (recorded)" } },
    ]).steps[0];
    expect(row && stepInstruction(row)).toBe("Grade Speech 2");
  });

  it("asks to write an announcement nobody has started, and to post one that exists", () => {
    const missing = plan([], { drafts: [draft("hot", "todo", false)] });
    expect(missing.steps.map(stepInstruction)).toEqual(["Write the announcement: hot news"]);
    expect(missing.steps[0]?.detail).toBe("Not started");
    expect(sittingLoad(sittingsOf(missing)[0]!)).toBe("1 to write");
    expect(plan([], { drafts: [draft("hot")] }).steps.map(stepInstruction)).toEqual([
      "Post draft: hot news",
    ]);
  });

  it("splits a course's replies by what each one needs, so no step overstates the others", () => {
    const mixed = plan(
      [],
      { replies: [reply("hot", "Amara"), reply("hot", "Ezra", "Needs approval")] },
      new Map([["hot:Ezra", "review" as const]]),
    );
    expect(mixed.steps.map(stepInstruction)).toEqual([
      "Review the reply to Ezra",
      "Reply to Amara",
    ]);
    expect(mixed.steps.map((step) => step.detail)).toEqual(["Needs approval", "Not started"]);
    expect(sittingLoad(sittingsOf(mixed)[0]!)).toBe("1 to review, 1 reply");
    expect(plannedHandoffs(mixed)).toEqual([{ course: "hot", work: { kind: "replies" } }]);
  });

  it("names every status when replies at one stage differ", () => {
    const steps = plan(
      [],
      {
        replies: [reply("hot", "Ezra", "Needs approval"), reply("hot", "Amara", "Ready to send")],
      },
      new Map([
        ["hot:Ezra", "review" as const],
        ["hot:Amara", "review" as const],
      ]),
    ).steps;
    expect(steps.map((step) => step.detail)).toEqual(["Needs approval, Ready to send"]);
  });

  it("names the first person and counts the rest, so two courses never read the same", () => {
    const steps = (stage?: "review" | "stuck") =>
      plan(
        [],
        { replies: [reply("hot", "Ezra"), reply("hot", "Amara")] },
        new Map(
          stage
            ? [
                ["hot:Ezra", stage],
                ["hot:Amara", stage],
              ]
            : [],
        ),
      ).steps.map(stepInstruction);
    expect(steps()).toEqual(["Reply to Ezra and 1 other"]);
    expect(steps("review")).toEqual(["Review the replies to Ezra and 1 other"]);
    expect(steps("stuck")).toEqual(["Fix the replies to Ezra and 1 other"]);
  });

  it("says how many submissions came in late, and nothing when none did", () => {
    const details = plan([
      assignment("hot", "Analysis", -4, 3, 1),
      assignment("cold", "Memo", -8, 2),
    ]).steps.map((step) => step.detail);
    expect(details).toEqual(["2 submissions", "3 submissions, 1 late"]);
  });

  it("colours a step's detail only when it is one status", () => {
    const reviewing = new Map([
      ["hot:Ezra", "review" as const],
      ["hot:Amara", "review" as const],
    ]);
    const tones = (over: Partial<DueExtras>, stages: ReadonlyMap<string, "review"> = new Map()) =>
      plan([], over, stages).steps.map((step) => step.detailTone);
    expect(tones({ replies: [reply("hot", "Ezra", "Needs approval")] }, reviewing)).toEqual([
      "approval",
    ]);
    expect(
      tones(
        {
          replies: [reply("hot", "Ezra", "Needs approval"), reply("hot", "Amara", "Ready to send")],
        },
        reviewing,
      ),
    ).toEqual(["todo"]);
    expect(tones({ drafts: [draft("hot", "approval")] })).toEqual(["approval"]);
    expect(plan([assignment("hot", "Analysis", -4, 3, 1)]).steps[0]?.detailTone).toBe("todo");
    expect(plan([], {}, new Map(), [lcc]).steps[0]?.detailTone).toBe("attention");
  });

  it("puts stuck sends ahead of approvals, and approvals ahead of new work", () => {
    const stages = new Map([
      ["hot:Later", "review" as const],
      ["cold:Broken", "stuck" as const],
    ]);
    const steps = plan(
      [
        assignment("hot", "Analysis", -4, 4),
        assignment("hot", "Later", -3, 1),
        assignment("cold", "Broken", -1, 1),
        assignment("hot", "Response", 0, 0),
      ],
      {},
      stages,
    ).steps;
    expect(steps.map((step) => `${step.verb} ${step.title}`)).toEqual([
      "Fix Broken",
      "Review Later",
      "Grade Analysis",
    ]);
  });

  it("writes each step as a plain instruction at every stage", () => {
    const instructions = (
      stages: ReadonlyMap<string, "stuck" | "review">,
      tone?: ThreadStatus["tone"],
    ) =>
      plan(
        [assignment("hot", "Analysis", -4, 4), assignment("hot", "Response", 0, 0)],
        { drafts: [draft("hot", tone)], replies: [reply("hot", "Ezra")] },
        stages,
      ).steps.map(stepInstruction);
    expect(instructions(new Map())).toEqual([
      "Grade Analysis",
      "Post draft: hot news",
      "Reply to Ezra",
    ]);
    expect(
      instructions(
        new Map([
          ["hot:Analysis", "review"],
          ["hot:Ezra", "review"],
        ]),
        "ready",
      ),
    ).toEqual(["Review grades for Analysis", "Review draft: hot news", "Review the reply to Ezra"]);
    expect(
      instructions(
        new Map([
          ["hot:Analysis", "stuck"],
          ["hot:Ezra", "stuck"],
        ]),
        "attention",
      ),
    ).toEqual(["Fix grades for Analysis", "Fix draft: hot news", "Fix the reply to Ezra"]);
    expect(plan([], {}, new Map(), [lcc]).steps.map(stepInstruction)).toEqual([
      `Reconnect ${lcc.name}`,
    ]);
  });

  it("puts an expired school before all work", () => {
    const steps = plan([assignment("hot", "Analysis", -4, 4)], {}, new Map(), [lcc]).steps;
    expect(steps[0]?.verb).toBe("Reconnect");
  });

  it("gives work in a course with no deadline left a reason of its own", () => {
    const steps = plan([assignment("done", "Final", -3, 2)], {
      drafts: [draft("done")],
      replies: [reply("done", "Ezra")],
    }).steps;
    expect(steps.map((step) => step.why)).toEqual([
      "3 days past due.",
      "Still unsent.",
      "Waiting 1 day.",
    ]);
  });

  it("grades work turned in before an open deadline, and keeps the rest under not yet", () => {
    const result = plan([assignment("hot", "Response", 0, 3), assignment("hot", "Essay", 2, 0)]);
    expect(result.steps.map((step) => [step.verb, step.title, step.why])).toEqual([
      ["Grade", "Response", "Turned in early. Due tonight."],
    ]);
    expect(result.notYet.map((item) => item.assignment.title)).toEqual(["Essay"]);
    expect(result.totals.toGrade).toBe(3);
  });

  it("keeps work due after this week, such as next term's, out of not yet", () => {
    const result = plan([
      assignment("fall", "Outline", 7, 0),
      assignment("spring", "Essay 1", 103, 0),
      assignment("fall", "Final", 30, 0),
    ]);
    expect(result.notYet.map((item) => item.assignment.title)).toEqual(["Outline"]);
  });

  it("names a course's sitting after its next deadline, even one with early work to grade", () => {
    const [sitting] = sittingsOf(
      plan([assignment("hot", "Speech", -3, 2), assignment("hot", "Outline", 4, 2)]),
    );
    expect(sittingWhen(sitting!)).toBe("before Outline, due Tuesday");
    expect(sittingLoad(sitting!)).toBe("4 to grade");
  });

  it("agrees with the Calendar on what can be graded", () => {
    const items = [
      assignment("hot", "Open, some in", 2, 4),
      assignment("hot", "Open, none in", 3, 0),
      assignment("old", "Past, some in", -3, 2),
      assignment("old", "Past, all graded", -5, 0),
    ];
    const { steps, notYet, totals } = plan(items);
    const graded = new Set(steps.map((step) => step.title));
    expect(
      items.filter((item) => toneOf(item) === "to-grade").map((item) => item.assignment.title),
    ).toEqual(["Open, some in", "Past, some in"]);
    expect([...graded].toSorted()).toEqual(["Open, some in", "Past, some in"]);
    expect(notYet.map((item) => item.assignment.title)).toEqual(["Open, none in"]);
    expect(totals.toGrade).toBe(6);
  });

  it("treats a deadline that passed this morning as work to grade, not as still open", () => {
    const morning = assignment("hot", "Morning", 0, 3);
    const result = plan([
      {
        ...morning,
        assignment: {
          ...morning.assignment,
          dueAt: isoTime(NOW - 3_600_000),
        },
      },
    ]);
    expect(result.steps.map((step) => step.title)).toEqual(["Morning"]);
    expect(result.notYet).toEqual([]);
  });

  it("still lists stuck work on a deadline that hasn't passed", () => {
    const result = plan(
      [assignment("hot", "Early", 2, 1)],
      {},
      new Map([["hot:Early", "stuck" as const]]),
    );
    expect(result.steps[0]?.verb).toBe("Fix");
  });

  it("orders courses with the same deadline the same way every time", () => {
    const steps = plan([
      assignment("zed", "Late", -2, 1),
      assignment("abc", "Early", -2, 1),
      assignment("zed", "A", 3, 0),
      assignment("abc", "B", 3, 0),
    ]).steps;
    expect(steps.map((step) => step.courseCode)).toEqual(["ABC", "ZED"]);
  });

  describe("sittings", () => {
    const hot = () => [
      assignment("hot", "Analysis", -4, 4),
      assignment("hot", "Memo", -2, 2),
      assignment("hot", "Response", 0, 0),
    ];
    const cold = () => [assignment("cold", "Essay", -6, 3), assignment("cold", "Outline", 5, 0)];

    it("holds one block per course, nearest deadline first, with the course's steps in rank order", () => {
      const sittings = sittingsOf(
        plan([...cold(), ...hot()], {
          drafts: [draft("hot")],
          replies: [reply("hot", "Ezra"), reply("cold", "Amara")],
        }),
      );
      expect(sittings.map(sittingName)).toEqual(["HOT", "COLD"]);
      expect(sittings[0]?.steps.map((step) => step.verb)).toEqual([
        "Grade",
        "Grade",
        "Post",
        "Reply to",
      ]);
    });

    it("heads a block with the deadline its steps share", () => {
      const [sitting] = sittingsOf(plan(hot()));
      expect(sittingWhen(sitting!)).toBe("before Response, due tonight");
    });

    it("sums a block's load in the units an adjunct counts", () => {
      const [sitting] = sittingsOf(
        plan(hot(), {
          drafts: [draft("hot")],
          replies: [reply("hot", "Ezra"), reply("hot", "Amara")],
        }),
      );
      expect(sittingLoad(sitting!)).toBe("6 to grade, 1 to post, 2 replies");
    });

    it("keeps a course whole when a stuck step lifts it above a nearer deadline", () => {
      const stuck = new Map([["cold:Essay", "stuck" as const]]);
      const sittings = sittingsOf(
        plan([...hot(), ...cold(), assignment("cold", "Quiz", -1, 1)], {}, stuck),
      );
      expect(sittings.map(sittingName)).toEqual(["COLD", "HOT"]);
      expect(sittings[0]?.steps.map((step) => step.verb)).toEqual(["Fix", "Grade"]);
    });

    it("lets a row give a reason only when the block's deadline doesn't explain it", () => {
      const stuck = new Map([["hot:Analysis", "stuck" as const]]);
      const [sitting] = sittingsOf(plan(hot(), {}, stuck));
      expect(sitting?.steps.map((step) => stepReason(step, sitting))).toEqual([
        "1 send needs your attention before anything else reaches students.",
        null,
      ]);
      const review = new Map([["hot:Analysis", "review" as const]]);
      const [reviewing] = sittingsOf(plan(hot(), {}, review));
      expect(stepReason(reviewing!.steps[0]!, reviewing!)).toBe(
        "1 grade is waiting on you before it reaches students.",
      );
      const [closed] = sittingsOf(plan([assignment("done", "Final", -3, 2)]));
      expect(sittingWhen(closed!)).toBe("no deadline coming up");
      expect(stepReason(closed!.steps[0]!, closed!)).toBe("3 days past due.");
    });

    it("says how many changes wait, so a teacher finds as many as it promised (#93)", () => {
      const why = (staged: Staged) =>
        plan(hot(), {}, new Map([["hot:Analysis", staged]])).steps[0]?.why;
      expect(why({ stage: "review", count: 3 })).toBe(
        "3 grades are waiting on you before they reach students.",
      );
      expect(why({ stage: "stuck", count: 2 })).toBe(
        "2 sends need your attention before anything else reaches students.",
      );
    });

    it("gives an expired school a block of its own, ahead of the courses", () => {
      const sittings = sittingsOf(plan(hot(), {}, new Map(), [lcc]));
      expect(sittingName(sittings[0]!)).toBe(lcc.name);
      expect(sittingWhen(sittings[0]!)).toBe("before anything else");
      expect(sittingLoad(sittings[0]!)).toBe("sign-in expired");
    });
  });

  it("says when in the words an adjunct would use", () => {
    expect(whenWords(0, "2026-10-30T23:59:00")).toBe("tonight");
    expect(whenWords(1, "2026-10-31T23:59:00")).toBe("tomorrow");
    expect(whenWords(0, "2026-10-30T09:30:00")).toBe("today at 9:30 AM");
    expect(whenWords(3, "2026-11-02T18:00:00")).toBe("Monday");
    expect(whenWords(9, "2026-11-08T18:00:00")).toBe("Nov 8");
  });
});

describe("what's due", () => {
  it("the summary sentence names each total", () => {
    expect(dueSummary({ toGrade: 7, needsReply: 3, drafts: 2 })).toBe(
      "7 submissions to grade, 3 messages needing a reply, 2 unsent announcements.",
    );
  });

  it("the summary is singular for one of each", () => {
    expect(dueSummary({ toGrade: 1, needsReply: 1, drafts: 1 })).toBe(
      "1 submission to grade, 1 message needing a reply, 1 unsent announcement.",
    );
  });

  it("a school filter drops empty groups and narrows the extras", () => {
    expect(filterDue(groups, schoolId("lcc")).map((group) => group.key)).toEqual(["past"]);
    expect(filterExtras(extras, schoolId("lcc")).replies).toHaveLength(2);
    expect(filterDue(groups, "all")).toHaveLength(2);
  });

  it("an empty What's due never calls hidden work done", () => {
    expect(nothingDueWords("all", false)).toBe("Nothing is due, and nothing is waiting on you.");
    expect(nothingDueWords("all", true)).toBe("Nothing is due where you're connected.");
    expect(nothingDueWords(schoolId("lcc"), true)).toBe("Nothing is due at this school.");
  });

  it("work in progress shows a count and a bar, and future work shows neither", () => {
    expect(dueProgress(due(lcc, { graded: 9 }))).toEqual({
      label: "9 of 14 graded",
      fraction: 9 / 14,
    });
    expect(dueProgress(due(lcc, { submitted: 0, graded: 0 }))).toEqual({
      label: "Nothing submitted yet",
      fraction: null,
    });
  });
});

const summary = (over: Partial<ChangeSummary>) =>
  changeSummary({ canApprove: false, sentAt: null, label: "Needs approval", ...over });
const row = (
  school: School,
  over: { unread?: boolean; mine?: boolean; summary?: ChangeSummary | null } = {},
): InboxRow => {
  const last = {
    id: "m1",
    mine: over.mine ?? false,
    author: over.mine ? "You" : "Maya Ortiz",
    text: "When is it due?",
    at: isoTime("2026-10-31T09:00:00.000Z"),
  };
  return inboxRow({
    school,
    conversation: conversation({ unread: over.unread ?? false, messages: [last] }),
    last,
    summary: over.summary ?? null,
  });
};

describe("the inbox", () => {
  const rows = [
    row(lcc, { unread: true }),
    row(rsu, { summary: summary({ canApprove: true }) }),
    row(lcc, { mine: true, summary: summary({ sentAt: isoTime("2026-10-30T10:00:00.000Z") }) }),
  ];

  it("needs reply means the student spoke last and no reply is under way", () => {
    expect(filterInbox(rows, "needs-reply", "all")).toEqual([rows[0]]);
  });

  it("a student writing again after a sent reply needs a reply again", () => {
    expect(
      statusCount(
        [row(lcc, { summary: summary({ sentAt: isoTime("2026-10-30T10:00:00.000Z") }) })],
        "needs-reply",
      ),
    ).toBe(1);
  });

  it("each filter finds its own rows, and school narrows any of them", () => {
    expect(filterInbox(rows, "waiting", "all")).toEqual([rows[1]]);
    expect(filterInbox(rows, "all", schoolId("rsu"))).toEqual([rows[1]]);
  });

  it("a school whose provider can't message gets a plain note, whatever the provider is", () => {
    const notes = messagingNotes([lcc, rsu], (school) => ({ messaging: school !== "rsu" }));
    expect(notes).toEqual([
      "Ridge State doesn't offer messaging through its LMS, so its conversations can't show here.",
    ]);
  });

  it("a school with no connection yet says nothing", () => {
    expect(messagingNotes([lcc], () => null)).toEqual([]);
  });

  it("the preview says when the last word was yours", () => {
    expect(preview(row(lcc, { mine: true }))).toBe("You: When is it due?");
    expect(preview(row(lcc))).toBe("When is it due?");
  });
});

const submission = (over: Partial<Submission>) =>
  ({ workflow: "graded", lateDays: 0, grade: null, ...over }) as Submission;
const cell = (over: Partial<GradebookCell>): GradebookCell => ({
  assignment: lmsRef<"assignment">("a"),
  submission: submission({}),
  grade: 80,
  pending: null,
  proposed: null,
  change: null,
  sent: false,
  asked: null,
  ...over,
});

const gradebookRow = (
  name: string,
  cells: readonly GradebookCell[],
  percent: number | null = null,
): GradebookRow => ({
  student: { ref: lmsRef<"student">(name), school: SCHOOL, course: COURSE, name },
  cells,
  earned: 0,
  possible: 0,
  percent,
  missing: 0,
});

describe("gradebook cells", () => {
  it("names each kind of cell", () => {
    expect(
      cellMarks(cell({ grade: null, submission: submission({ workflow: "submitted" }) })),
    ).toEqual(["ungraded"]);
    expect(
      cellMarks(cell({ grade: null, submission: submission({ workflow: "missing" }) })),
    ).toEqual(["missing"]);
    expect(
      cellMarks(cell({ grade: 70, submission: submission({ workflow: "submitted", grade: 70 }) })),
    ).toEqual(["resubmitted"]);
    expect(cellMarks(cell({ submission: submission({ lateDays: 2 }) }))).toEqual(["late"]);
    expect(cellMarks(cell({}))).toEqual([]);
  });

  it("work the student was asked to resubmit says so, not ungraded or resubmitted (#106)", () => {
    const asked = isoTime("2026-11-14T15:00:00.000Z");
    expect(
      cellMarks(cell({ grade: null, asked, submission: submission({ workflow: "submitted" }) })),
    ).toEqual(["asked"]);
    expect(
      cellMarks(cell({ grade: 70, asked, submission: submission({ workflow: "submitted" }) })),
    ).toEqual(["asked"]);
    expect(
      cellMarks(
        cell({
          grade: null,
          asked,
          submission: submission({ workflow: "submitted", lateDays: 3 }),
        }),
      ),
    ).toEqual(["asked", "late"]);
  });

  it("an ungraded cell with a pending grade shows only the pending grade", () => {
    const drafted = { grade: null, pending: summary({ label: "Ready to send" }), proposed: 74 };
    expect(
      cellMarks(cell({ ...drafted, submission: submission({ workflow: "submitted" }) })),
    ).toEqual([]);
    expect(
      cellMarks(
        cell({ ...drafted, submission: submission({ workflow: "submitted", lateDays: 1 }) }),
      ),
    ).toEqual(["late"]);
    expect(pendingWords(cell(drafted))).toBe("74 ready to send");
  });

  it("a pending change says its grade and its state", () => {
    expect(pendingWords(cell({ pending: summary({ canApprove: true }), proposed: 84 }))).toBe(
      "84 pending approval",
    );
    expect(pendingWords(cell({ pending: summary({ label: "Approved" }), proposed: 84 }))).toBe(
      "84 approved",
    );
    expect(pendingWords(cell({}))).toBeNull();
  });

  it("a click goes to the work, the missing work, the record, or the submission", () => {
    expect(cellTarget(cell({ pending: summary({}) }))).toBe("work");
    expect(
      cellTarget(cell({ grade: null, submission: submission({ workflow: "submitted" }) })),
    ).toBe("work");
    expect(cellTarget(cell({ sent: true }))).toBe("record");
    expect(cellTarget(cell({}))).toBe("view");
    expect(cellTarget(cell({ submission: submission({ workflow: "missing" }) }))).toBe("missing");
    expect(cellTarget(cell({ submission: submission({ workflow: "unsubmitted" }) }))).toBe("none");
    expect(cellTarget(cell({ submission: null }))).toBe("none");
  });
});

describe("gradebook sorting", () => {
  const assignment = { ref: "a" } as Assignment;
  const person = (name: string, grade: number | null, percent: number | null) =>
    gradebookRow(name, [cell({ grade })], percent);
  const rows = [person("Bea", 50, 50), person("Ana", null, null), person("Cal", 90, 90)];
  const names = (sorted: readonly GradebookRow[]) => sorted.map((r) => r.student.name);

  it("sorts by student name", () => {
    expect(names(sortRows(rows, { by: "student", descending: false }, [assignment]))).toEqual([
      "Ana",
      "Bea",
      "Cal",
    ]);
  });

  it("sorts by an assignment and keeps blanks last in both directions", () => {
    expect(names(sortRows(rows, { by: assignment.ref, descending: true }, [assignment]))).toEqual([
      "Cal",
      "Bea",
      "Ana",
    ]);
    expect(names(sortRows(rows, { by: assignment.ref, descending: false }, [assignment]))).toEqual([
      "Bea",
      "Cal",
      "Ana",
    ]);
  });

  it("sorts by total", () => {
    expect(names(sortRows(rows, { by: "total", descending: true }, [assignment]))).toEqual([
      "Cal",
      "Bea",
      "Ana",
    ]);
  });

  it("the second click flips the direction", () => {
    const first = nextSort({ by: "student", descending: false }, "total");
    expect(first).toEqual({ by: "total", descending: true });
    expect(nextSort(first, "total")).toEqual({ by: "total", descending: false });
  });
});

describe("who is behind", () => {
  const student = (name: string, ...cells: Partial<Submission>[]) =>
    gradebookRow(
      name,
      cells.map((over) => cell({ grade: null, submission: submission(over) })),
    );
  const rows = [
    student("Ana", { workflow: "graded" }),
    student("Bea", { workflow: "graded" }, { workflow: "missing" }),
    student("Cal", { workflow: "submitted", lateDays: 2 }),
  ];
  const names = (shown: readonly { student: { name: string } }[]) =>
    shown.map((r) => r.student.name);

  it("the gradebook shows only students with missing or late work", () => {
    expect(names(filterRows(rows, "all"))).toEqual(["Ana", "Bea", "Cal"]);
    expect(names(filterRows(rows, "missing"))).toEqual(["Bea"]);
    expect(names(filterRows(rows, "late"))).toEqual(["Cal"]);
  });

  it("a filter keeps only the assignments that hold what it filters for", () => {
    const first = { ref: "a1" } as Assignment;
    const second = { ref: "a2" } as Assignment;
    const all = [first, second];
    const refs = (filter: RowFilter, columns = all) =>
      filterColumns(filterRows(rows, filter), columns, all, filter).map((a) => a.ref);
    expect(refs("all")).toEqual(["a1", "a2"]);
    expect(refs("missing")).toEqual(["a2"]);
    expect(refs("late")).toEqual(["a1"]);
    expect(refs("missing", [second, first])).toEqual(["a2"]);
  });

  it("the roster puts the most missing work first, then the lowest grade", () => {
    const roster = (name: string, missing: number, percent: number | null) =>
      ({ student: { name }, missing, percent }) as RosterRow;
    expect(
      names(
        behindFirst([
          roster("Ana", 0, 95),
          roster("Dee", 0, null),
          roster("Bea", 2, 70),
          roster("Cal", 0, 55),
          roster("Eli", 1, 88),
        ]),
      ),
    ).toEqual(["Bea", "Eli", "Cal", "Ana", "Dee"]);
  });
});

describe("sync age", () => {
  const at = isoTime("2026-10-30T10:00:00.000Z");
  const start = new Date(at).getTime();

  it("speaks in the largest unit that fits", () => {
    expect(ageWords(at, start + 30_000)).toBe("just now");
    expect(ageWords(at, start + 12 * 60_000)).toBe("12 min ago");
    expect(ageWords(at, start + 3 * 3_600_000)).toBe("3 hours ago");
    expect(ageWords(at, start + 72 * 3_600_000)).toBe("3 days ago");
    expect(ageWords(null, start)).toBe("never");
  });

  it("goes stale after an hour", () => {
    expect(isStale(at, start + 59 * 60_000)).toBe(false);
    expect(isStale(at, start + 61 * 60_000)).toBe(true);
  });

  it("a failed refresh names the LMS in plain words and says the old data is still showing", () => {
    expect(syncFailureWords("unavailable", "Canvas", at, start + 2 * 3_600_000)).toBe(
      "Can't reach Canvas. Check your internet connection. Showing data from 2 hours ago.",
    );
  });
});
