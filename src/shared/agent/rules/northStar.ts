import { summarize, type ChangeRecord } from "~/shared/domain/change";
import { awaitsReply, type Assignment, type Conversation, type Course } from "~/shared/domain/lms";

import type {
  AgentEffect,
  AgentInput,
  AgentScope,
  AnswerLine,
  HandoffWork,
  NextWork,
} from "../agent";
import { OUT_OF_SCOPE, asksToAct } from "./refuse";

type NorthStarScope = NonNullable<AgentScope["northStar"]>;

interface Ask {
  request: string;
  scope: AgentScope;
  northStar: NorthStarScope;
  history: AgentInput["thread"]["history"];
}

interface Intent {
  matches(ask: Ask): boolean;
  run(ask: Ask): Generator<AgentEffect, void>;
}

const DAY = 86_400_000;
const DUE_DAYS = 7;
const DUE_SHOWN = 8;
const FIND_SHOWN = 8;
const BUSIEST_SHOWN = 3;
const NEXT_SHOWN = 3;
const SENDERS_SHOWN = 3;
const WHICH_COURSE = "Which course should get the announcement?";
const WHICH_ASSIGNMENT = "Which assignment? These have the most to grade.";
const WHICH_MISSING = "Which assignment? These have the most missing work.";
const MISSING_ASK =
  /\b(?:who|which\s+students?|anyone|anybody)\b.*(?:\bmissing\b|(?:\bnot|n['’]?t|\bnever|\byet\s+to)\s+(?:yet\s+)?(?:submit|turn|hand))/i;
const BEHIND_ASK = /\bbehind\b|\bstruggling\b|\bat[\s-]risk\b|\bfailing\b/i;
const DESTRUCTIVE_ASK = /\b(delete|remove|erase|wipe)\b/i;
const CANT_DELETE =
  "I can't delete anything in your courses. Every change I make is a draft you approve before students see it.";
const GRADING_ASK = /\b(start|begin|open)\s+(the\s+)?grading\b|^\s*grade\b/i;
const ALL_DUE: AnswerLine = { source: { kind: "due" }, title: "All of what's due" };
const WHATS_POSSIBLE = [
  "What's due this week?",
  "What needs grading?",
  "Find anything about the late policy",
];
const WAITING_ON_YOU: AnswerLine = {
  source: { kind: "due" },
  title: "What's due",
  detail: "Everything waiting on you",
};
const ALL_COURSES = "All my courses";
const BACK_REFERENCE = /\b(she|he|they|her|him|them|his|hers|their|it|that|this)\b/i;
const CHANGE_ASK =
  /\b(make|change|rewrite|reword|edit|tweak|shorten|soften)\b|\b(friendlier|warmer|nicer|kinder|softer|shorter|longer|firmer|clearer|simpler)\b/i;
const SAME_FOR = /\bthe\s+same\s+(?:thing\s+)?(?:for|to|with)\s+([^,;.!?]+)/i;
const REPLY_TO = /\b(?:reply|respond|write\s+back)\s+to\s+(.+)$/i;
const FACETS: ReadonlySet<string> = new Set(["rubric", "late", "policy", "penalty"]);
const LEFT_OUT_SHOWN = 100;
const ANNOUNCEMENT_ASK = /\b(draft|write|start|prepare|make|create)\b.*\bannouncements?\b/i;
const ABOUT = /\babout\s+([^,;.!?]+)/i;
const FILLER: ReadonlySet<string> = new Set(
  "a about an and any anything are at can do does find for from have i in is it look me my of on or s search show that the there this to up what where which with you".split(
    " ",
  ),
);

type Say = Extract<AgentEffect, { type: "say" }>;
const say = (text: string, lines?: readonly AnswerLine[]): Say => ({
  type: "say",
  text,
  ...(lines ? { lines } : {}),
});
const question = (text: string, answers: readonly string[]): Say => ({
  type: "say",
  text,
  replies: answers,
});
const work = (line: string): AgentEffect => ({ type: "work", line });
type Handoff = Extract<AgentEffect, { type: "handoff" }>;
const handoff = (
  course: Course,
  handed: HandoffWork,
  brief: string,
  request: string,
  left?: string,
): Handoff => ({
  type: "handoff",
  school: course.school,
  course: course.ref,
  work: handed,
  brief,
  request,
  ...(left === undefined ? {} : { left }),
});

const plural = (count: number, one: string, many = `${one}s`): string => (count === 1 ? one : many);
const dayWords = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const sentenceList = (items: readonly string[]): string =>
  items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
const boldCodes = (courses: readonly Course[]): string =>
  sentenceList(courses.map((course) => `**${course.code}**`));
const codeOf = (scope: AgentScope, ref: Course["ref"]): string =>
  scope.courses.find((course) => course.ref === ref)?.code ?? "";

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (request: string, phrase: string): boolean =>
  new RegExp(`(^|\\W)${escaped(phrase).replace(/\s+/g, "\\s*")}($|\\W)`, "i").test(request);
const wordsOf = (text: string): readonly string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

const specificCourses = ({ request, scope, northStar }: Ask): readonly Course[] => {
  const schools = northStar.schools.filter(
    (school) =>
      mentions(request, school.abbr) ||
      mentions(request, school.name) ||
      mentions(request, school.name.split(" ")[0] ?? school.name),
  );
  return scope.courses.filter(
    (course) =>
      mentions(request, course.code) || schools.some((school) => school.id === course.school),
  );
};

const namedCourses = (ask: Ask): readonly Course[] => {
  const specific = specificCourses(ask);
  if (specific.length > 0) return specific;
  return /\b(all|every)\b/i.test(ask.request) ? ask.scope.courses : [];
};

/** What looks like a course code but isn't one of theirs, so a typo gets said out loud instead of dropped. */
const unknownCodeNote = ({ request, scope }: Ask): string => {
  const unknown = (request.match(/\b[A-Z]{2,5} ?\d{3}\b/g) ?? []).filter(
    (code) => !scope.courses.some((course) => mentions(code, course.code)),
  );
  return unknown.length > 0 ? `I can't find ${sentenceList(unknown)} in your courses. ` : "";
};

const ASK_WORDS: ReadonlySet<string> = new Set([
  ..."draft write start open prepare make create announcement announcements reply replies response responses respond message messages unread week weeks weekly next new please all every course courses".split(
    " ",
  ),
  ...FILLER,
]);
const isAskWord = (token: string): boolean => wordsOf(token).every((word) => ASK_WORDS.has(word));
const WHEN_WORDS: ReadonlySet<string> = new Set(
  "today tonight tomorrow morning afternoon evening night noon midnight am pm monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec".split(
    " ",
  ),
);
/** "Thursday at 7pm" says when, not what, so it can't be what an announcement is about. */
const saysOnlyWhen = (tokens: readonly string[]): boolean =>
  tokens.every((token) =>
    wordsOf(token).every(
      (word) =>
        ASK_WORDS.has(word) || WHEN_WORDS.has(word) || /^\d+(am|pm|st|nd|rd|th)?$/.test(word),
    ),
  );

const withoutNames = (text: string, names: readonly string[]): string =>
  [...names]
    .sort((a, b) => b.length - a.length)
    .reduce(
      (rest, name) =>
        rest.replace(
          new RegExp(`(?<!\\w)${escaped(name).replace(/\s+/g, "\\s*")}(?!\\w)`, "gi"),
          " ",
        ),
      text,
    );

const withoutCourses = ({ scope, northStar }: Ask, text: string): string =>
  withoutNames(text, [
    ...scope.courses.map((course) => course.code),
    ...northStar.schools.flatMap((school) => [
      school.name,
      school.abbr,
      school.name.split(" ")[0] ?? school.name,
    ]),
  ]).replace(/\b[A-Z]{2,5} ?\d{3}\b/g, " ");

const saidIn = (ask: Ask, asked: string): string =>
  asked === ask.request ? asked : `${asked}, ${ask.request}`;

/** What an announcement ask says it's about, articles kept, so the draft can say it in their words. */
const topicIn = (ask: Ask, said: string): string | undefined => {
  const tokens = (ABOUT.exec(withoutCourses(ask, said))?.[1] ?? "").trim().split(/\s+/);
  return saysOnlyWhen(tokens)
    ? undefined
    : tokens.slice(0, tokens.findLastIndex((token) => !isAskWord(token)) + 1).join(" ");
};

const leftOut = (ask: Ask, said: string): string | undefined => {
  const clauses = withoutCourses(ask, said)
    .split(/[,;.!?]|\band\b/i)
    .map((clause) => {
      const tokens = clause.trim().split(/\s+/);
      const first = tokens.findIndex((token) => !isAskWord(token));
      if (first < 0) return "";
      const last = tokens.findLastIndex((token) => !isAskWord(token));
      return tokens.slice(first, last + 1).join(" ");
    })
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return undefined;
  const all = clauses.join(", ");
  return `"${all.length <= LEFT_OUT_SHOWN ? all : `${all.slice(0, all.lastIndexOf(" ", LEFT_OUT_SHOWN))}…`}"`;
};
const leftOutLine = (left: string | undefined): string =>
  left ? `I left out ${left}, so add that when you review. ` : "";

const startedLine = (courses: readonly Course[], what: string): string =>
  courses.length === 0
    ? ""
    : `Started ${what} in your ${boldCodes(courses)} ${plural(courses.length, "thread")}. `;
const staysPrivate = (drafts: number): string =>
  `Students see nothing until you approve ${plural(drafts, "it", "them")}.`;

const hasOpenChange = (scope: AgentScope, target: string): boolean =>
  scope.changes.some(
    (change) =>
      change.content.kind !== "message" &&
      change.content.target === target &&
      change.state.tag !== "sent" &&
      change.state.tag !== "discarded",
  );

const toGrade = (scope: AgentScope, assignment: Assignment): number =>
  scope.submissions.filter((s) => s.assignment === assignment.ref && s.workflow === "submitted")
    .length;

const lastAgentText = (ask: Ask): string | undefined =>
  ask.history.findLast((message) => message.role === "agent")?.text;

const askedForAnnouncement = ({ request, history }: Ask): string =>
  ANNOUNCEMENT_ASK.test(request)
    ? request
    : (history.findLast((message) => message.role === "user" && ANNOUNCEMENT_ASK.test(message.text))
        ?.text ?? request);

function* announcements(ask: Ask): Generator<AgentEffect, void> {
  const courses = namedCourses(ask);
  const missing = unknownCodeNote(ask);
  if (courses.length === 0) {
    yield question(`${missing}${WHICH_COURSE}`, [
      ...ask.scope.courses.map((course) => course.code),
      ALL_COURSES,
    ]);
    return;
  }
  const asked = askedForAnnouncement(ask);
  const said = saidIn(ask, asked);
  const topic = topicIn(ask, said);
  const fresh = courses.filter((course) => !hasOpenChange(ask.scope, course.ref));
  const drafted = courses.filter((course) => hasOpenChange(ask.scope, course.ref));
  const leftAll = leftOut(ask, said);
  const leftBesideTopic = topic === undefined ? leftAll : leftOut(ask, said.replace(ABOUT, " "));
  const left = fresh.length > 0 ? leftBesideTopic : leftAll;
  if (fresh.length > 0)
    yield work(`Read what's coming up in ${sentenceList(fresh.map((course) => course.code))}`);
  for (const course of courses)
    yield handoff(
      course,
      topic === undefined ? { kind: "announcement" } : { kind: "announcement", topic },
      !fresh.includes(course)
        ? "Already drafted. Open it to review."
        : topic === undefined
          ? `Draft this week's announcement for ${course.code}.`
          : `Draft an announcement for ${course.code} about ${topic}.`,
      asked,
      fresh.includes(course) ? leftBesideTopic : leftAll,
    );
  const already =
    drafted.length === 0
      ? ""
      : `${boldCodes(drafted)} ${drafted.length === 1 ? "already has a draft, so I didn't start another" : "already have drafts, so I didn't start new ones"}. `;
  yield say(
    `${missing}${startedLine(fresh, plural(fresh.length, "a draft announcement", "draft announcements"))}${already}${leftOutLine(left)}${staysPrivate(courses.length)}`,
  );
}

const addressee = (ask: Ask): string | undefined => {
  const to = REPLY_TO.exec(ask.request)?.[1];
  if (!to) return undefined;
  const tokens = (withoutCourses(ask, to).split(/[,;.!?]/)[0] ?? "").trim().split(/\s+/);
  const end = tokens.findIndex((token) => isAskWord(token));
  const name = tokens.slice(0, end < 0 ? undefined : end).join(" ");
  return name.length > 0 ? name : undefined;
};

/** Every word they gave has to be in the sender's name, so a typo asks instead of guessing. */
const sendersFor = (
  { request }: Ask,
  conversations: readonly Conversation[],
  to: string | undefined,
): readonly string[] => {
  const people = [...new Set(conversations.map((c) => c.from))];
  if (to === undefined) return people.filter((person) => mentions(request, person));
  const asked = wordsOf(to);
  return people.filter((person) => asked.every((word) => wordsOf(person).includes(word)));
};

function* replyTo(ask: Ask, conversations: readonly Conversation[]): Generator<AgentEffect, void> {
  const people = [...new Set(conversations.map((c) => c.from))];
  const unnamed = withoutNames(
    ask.request,
    people.flatMap((person) => [person, ...person.split(/\s+/)]),
  );
  const left = leftOut({ ...ask, request: unnamed }, unnamed);
  const fresh = conversations.filter((c) => !hasOpenChange(ask.scope, c.ref));
  const bold = (list: readonly { from: string }[]) =>
    sentenceList([...new Set(list.map((c) => `**${c.from}**`))]);
  if (fresh.length > 0) yield work(`Read your messages from ${sentenceList(people)}`);
  for (const conversation of conversations) {
    const course = ask.scope.courses.find((c) => c.ref === conversation.course);
    if (!course) continue;
    yield handoff(
      course,
      { kind: "reply", conversation: conversation.ref },
      fresh.includes(conversation)
        ? `Draft a reply to ${conversation.from}.`
        : "Reply already drafted. Open it to review.",
      ask.request,
      left,
    );
  }
  const drafted = conversations.filter((c) => !fresh.includes(c));
  const freshCourses = ask.scope.courses.filter((course) =>
    fresh.some((c) => c.course === course.ref),
  );
  const already =
    drafted.length === 0
      ? ""
      : `${bold(drafted)} already ${drafted.length === 1 ? "has a reply" : "have replies"} drafted, so I didn't start another. `;
  yield say(
    `${startedLine(freshCourses, `${plural(fresh.length, "a draft reply", "draft replies")} to ${bold(fresh)}`)}${already}${leftOutLine(left)}${staysPrivate(conversations.length)}`,
  );
}

function* replies(ask: Ask): Generator<AgentEffect, void> {
  const courses = specificCourses(ask);
  const inScope = ask.scope.conversations.filter(
    (c) => courses.length === 0 || courses.some((course) => course.ref === c.course),
  );
  const to = addressee(ask);
  const people = sendersFor(ask, inScope, to);
  if (people.length === 1 || (to === undefined && people.length > 0))
    return yield* replyTo(
      ask,
      inScope.filter((c) => people.includes(c.from)),
    );
  if (to !== undefined) {
    const waiting = inScope.filter(awaitsReply).map((c) => c.from);
    yield question(
      people.length === 0
        ? `I can't find a message from ${to}. Who should I reply to?`
        : `Which ${to} should I reply to?`,
      [...new Set(people.length === 0 ? waiting : people)]
        .slice(0, SENDERS_SHOWN)
        .map((person) => `Reply to ${person}`),
    );
    return;
  }
  const named = namedCourses(ask);
  const waiting = (named.length > 0 ? named : ask.scope.courses).flatMap((course) => {
    const unread = ask.scope.conversations.filter((c) => c.course === course.ref && awaitsReply(c));
    return unread.length > 0
      ? [
          {
            course,
            unread: unread.length,
            undrafted: unread.filter((c) => !hasOpenChange(ask.scope, c.ref)).length,
          },
        ]
      : [];
  });
  if (waiting.length === 0) {
    yield say("No unread message is waiting on a reply, so there's nothing to start.");
    return;
  }
  const left = leftOut(ask, ask.request);
  const fresh = waiting.filter((entry) => entry.undrafted > 0).map((entry) => entry.course);
  const drafted = waiting.filter((entry) => entry.undrafted === 0).map((entry) => entry.course);
  if (fresh.length > 0) yield work("Read your unread messages");
  for (const { course, undrafted } of waiting)
    yield handoff(
      course,
      { kind: "replies" },
      undrafted > 0
        ? `Draft ${plural(undrafted, "a reply", "replies")} to ${undrafted} unread ${plural(undrafted, "message")} in ${course.code}.`
        : "Replies already drafted. Open them to review.",
      ask.request,
      left,
    );
  const already =
    drafted.length === 0
      ? ""
      : `${boldCodes(drafted)} ${drafted.length === 1 ? "already has its replies drafted" : "already have their replies drafted"}, so I didn't start more. `;
  const started = waiting.reduce((sum, entry) => sum + entry.undrafted, 0);
  const total = waiting.reduce((sum, entry) => sum + entry.unread, 0);
  yield say(
    `${startedLine(fresh, plural(started, "a draft reply", "draft replies"))}${already}${leftOutLine(left)}${staysPrivate(total)}`,
  );
}

const titledAssignments = (ask: Ask): readonly Assignment[] => {
  const courses = specificCourses(ask);
  const titled = ask.scope.assignments.filter(
    (a) =>
      (courses.length === 0 || courses.some((course) => course.ref === a.course)) &&
      (mentions(ask.request, a.shortTitle) || mentions(ask.request, a.title)),
  );
  // "Essay 3 Outline" also says "Essay 3". The longest title is the one they meant.
  const longest = Math.max(0, ...titled.map((a) => a.shortTitle.length));
  return titled.filter((a) => a.shortTitle.length === longest);
};

function* startGrading(ask: Ask): Generator<AgentEffect, void> {
  const { scope, request } = ask;
  const hits = titledAssignments(ask);
  if (hits.length === 0) {
    const busiest = [...scope.assignments]
      .sort((a, b) => toGrade(scope, b) - toGrade(scope, a))
      .map((a) => `Start grading ${a.shortTitle}`);
    yield question(WHICH_ASSIGNMENT, [...new Set(busiest)].slice(0, BUSIEST_SHOWN));
    return;
  }
  const handed: Course[] = [];
  for (const assignment of hits) {
    const course = scope.courses.find((c) => c.ref === assignment.course);
    if (!course) continue;
    handed.push(course);
    const open = toGrade(scope, assignment);
    yield handoff(
      course,
      { kind: "grading", assignment: assignment.ref },
      `Start grading ${assignment.shortTitle}. ${open} ${plural(open, "submission")} to grade.`,
      GRADING_ASK.test(request) ? request : `Start grading ${assignment.shortTitle}`,
    );
  }
  yield say(
    `The grading list for **${hits[0]?.shortTitle ?? ""}** in ${boldCodes(handed)} is ready. To start, choose Open, then open a submission and I'll draft it.`,
  );
}

const missingFrom = (scope: AgentScope, assignment: Assignment) =>
  scope.submissions.filter((s) => s.assignment === assignment.ref && s.workflow === "missing");

function* missingWork(ask: Ask): Generator<AgentEffect, void> {
  const { scope, northStar } = ask;
  const hits = titledAssignments(ask);
  if (hits.length === 0) {
    const courses = specificCourses(ask);
    const most = scope.assignments
      .filter((a) => courses.length === 0 || courses.some((course) => course.ref === a.course))
      .map((assignment) => ({ assignment, missing: missingFrom(scope, assignment).length }))
      .filter((entry) => entry.missing > 0)
      .sort((a, b) => b.missing - a.missing)
      .map(({ assignment }) => `Who hasn't submitted ${assignment.shortTitle}?`);
    if (most.length === 0) yield say("No one has missing work right now.", [ALL_DUE]);
    else yield question(WHICH_MISSING, [...new Set(most)].slice(0, BUSIEST_SHOWN));
    return;
  }
  const title = hits[0]?.shortTitle ?? "";
  const courses = scope.courses.filter((course) => hits.some((a) => a.course === course.ref));
  const where = `**${title}** in ${boldCodes(courses)}`;
  yield work(`Checked who turned in ${title}`);
  const missing = hits
    .flatMap((assignment) => missingFrom(scope, assignment))
    .sort((a, b) => a.studentName.localeCompare(b.studentName));
  if (missing.length === 0) {
    const due = hits.find((a) => a.dueAt !== null && a.dueAt > northStar.now)?.dueAt;
    yield say(
      `Nothing is missing for ${where}.${due ? ` It's due ${dayWords(due)}.` : ""}`,
      hits.map((assignment): AnswerLine => ({
        source: { kind: "assignment", ref: assignment.ref },
        title: assignment.shortTitle,
        detail: codeOf(scope, assignment.course),
      })),
    );
    return;
  }
  yield say(
    `${missing.length} ${plural(missing.length, "student hasn't", "students haven't")} turned in ${where}.`,
    missing.map((submission): AnswerLine => ({
      source: { kind: "submission", ref: submission.ref },
      title: submission.studentName,
      detail: `${codeOf(scope, submission.course)}, missing`,
    })),
  );
}

function* whatsDue({ scope, northStar }: Ask): Generator<AgentEffect, void> {
  const startOfDay = (iso: string): number => new Date(iso).setHours(0, 0, 0, 0);
  const today = startOfDay(northStar.now);
  const now = new Date(northStar.now).getTime();
  const coming = scope.assignments
    .flatMap((assignment) => {
      if (!assignment.dueAt) return [];
      // Rounded, because a day that crosses a clock change isn't 24 hours long.
      const days = Math.round((startOfDay(assignment.dueAt) - today) / DAY);
      return new Date(assignment.dueAt).getTime() > now && days <= DUE_DAYS
        ? [{ assignment, due: assignment.dueAt }]
        : [];
    })
    .sort((a, b) => a.due.localeCompare(b.due));
  yield work(`Read due dates in ${scope.courses.length} ${plural(scope.courses.length, "course")}`);
  if (coming.length === 0) {
    yield say(`Nothing is due in the next ${DUE_DAYS} days.`, [ALL_DUE]);
    return;
  }
  const next = coming.slice(0, DUE_SHOWN);
  const lead =
    coming.length > next.length
      ? `Showing ${next.length} of ${coming.length} due in the next ${DUE_DAYS} days.`
      : `${coming.length} ${plural(coming.length, "assignment is", "assignments are")} due in the next ${DUE_DAYS} days.`;
  yield say(lead, [
    ...next.map(({ assignment, due }): AnswerLine => ({
      source: { kind: "assignment", ref: assignment.ref },
      title: assignment.shortTitle,
      detail: `${codeOf(scope, assignment.course)}, ${dayWords(due)}`,
    })),
    ALL_DUE,
  ]);
}

function* gradingSummary({ scope }: Ask): Generator<AgentEffect, void> {
  const counts = scope.courses
    .map((course) => ({
      course,
      open: scope.submissions.filter((s) => s.course === course.ref && s.workflow === "submitted")
        .length,
    }))
    .filter((entry) => entry.open > 0);
  const total = counts.reduce((sum, entry) => sum + entry.open, 0);
  if (total === 0) {
    yield say("Nothing needs a grade right now.", [ALL_DUE]);
    return;
  }
  yield say(`${total} ${plural(total, "submission needs", "submissions need")} a grade.`, [
    ...counts.map(({ course, open }): AnswerLine => ({
      source: { kind: "course", ref: course.ref },
      title: course.code,
      detail: `${open} to grade`,
    })),
    ALL_DUE,
  ]);
}

/** Behind is what the roster calls Watch or At risk, or any missing work, from the same gradebook totals. */
function* behind(ask: Ask): Generator<AgentEffect, void> {
  const { scope, northStar } = ask;
  const named = specificCourses(ask);
  const books = northStar.grades.filter(
    (book) => named.length === 0 || named.some((course) => course.ref === book.course),
  );
  const where = named.length > 0 ? ` in ${boldCodes(named)}` : "";
  yield work("Checked the gradebook");
  const rows = books
    .flatMap((book) =>
      book.students
        .filter((s) => s.standing === "Watch" || s.standing === "At risk" || s.missing > 0)
        .map((student) => ({ course: book.course, ...student })),
    )
    .sort((a, b) => b.missing - a.missing || (a.percent ?? 101) - (b.percent ?? 101));
  if (rows.length === 0) {
    yield say(
      `No one is behind${where}. Every graded student is at 80% or above, with nothing missing.`,
    );
    return;
  }
  yield say(
    `${rows.length} ${plural(rows.length, "student is", "students are")} behind${where}: under 80% or missing work.`,
    rows.map((row): AnswerLine => ({
      source: { kind: "course", ref: row.course },
      title: row.name,
      detail: [
        codeOf(scope, row.course),
        row.percent === null ? "no grades yet" : `${row.percent}%`,
        ...(row.missing > 0 ? [`${row.missing} missing`] : []),
      ].join(", "),
    })),
  );
}

interface Found {
  isAssignment: boolean;
  words: ReadonlySet<string>;
  line: AnswerLine;
}

const assignmentDetail = (
  scope: AgentScope,
  assignment: Assignment,
  facets: readonly string[],
): string => {
  const name = `${codeOf(scope, assignment.course)}.`;
  const rubric = !assignment.rubric
    ? "It has no rubric."
    : `Its rubric has ${assignment.rubric.length} ${plural(assignment.rubric.length, "criterion", "criteria")}: ${assignment.rubric.map((c) => `${c.name} (${c.maxPoints})`).join(", ")}.`;
  const late =
    assignment.latePointsPerDay === null
      ? "It has no late penalty set."
      : `It takes off ${assignment.latePointsPerDay} ${plural(assignment.latePointsPerDay, "point")} a day when late.`;
  const facts = [
    facets.includes("rubric") ? rubric : null,
    facets.some((facet) => facet !== "rubric") ? late : null,
  ].filter((fact) => fact !== null);
  return [name, ...(facts.length > 0 ? facts : [`${assignment.pointsPossible} points.`])].join(" ");
};

const searchable = ({ scope, northStar }: Ask, facets: readonly string[]): readonly Found[] => [
  ...scope.assignments.map((assignment): Found => ({
    isAssignment: true,
    words: new Set(
      wordsOf(
        [
          assignment.title,
          assignment.shortTitle,
          codeOf(scope, assignment.course),
          ...(assignment.rubric ? ["rubric", ...assignment.rubric.map((c) => c.name)] : []),
          ...(assignment.latePointsPerDay === null ? [] : ["late policy penalty"]),
        ].join(" "),
      ),
    ),
    line: {
      source: { kind: "assignment", ref: assignment.ref },
      title: assignment.shortTitle,
      detail: assignmentDetail(scope, assignment, facets),
    },
  })),
  ...northStar.announcements.map((post): Found => ({
    isAssignment: false,
    words: new Set(wordsOf(`${post.title} ${post.body} ${codeOf(scope, post.course)}`)),
    line: {
      source: { kind: "announcement", ref: post.ref },
      title: post.title,
      detail: `${codeOf(scope, post.course)} announcement. ${post.body}`,
    },
  })),
  ...scope.conversations.map((conversation): Found => ({
    isAssignment: false,
    words: new Set(
      wordsOf(`${conversation.subject} ${conversation.from} ${codeOf(scope, conversation.course)}`),
    ),
    line: {
      source: { kind: "conversation", ref: conversation.ref },
      title: conversation.subject,
      detail: `Message from ${conversation.from} in ${codeOf(scope, conversation.course)}.`,
    },
  })),
  ...scope.submissions
    .filter((first, index, all) => all.findIndex((s) => s.student === first.student) === index)
    .map(({ student, studentName, course }): Found => {
      const waiting = scope.submissions.find(
        (s) => s.student === student && s.workflow === "submitted",
      );
      const code = codeOf(scope, course);
      return {
        isAssignment: false,
        words: new Set(wordsOf(`${studentName} ${code}`)),
        line: waiting
          ? {
              source: { kind: "submission", ref: waiting.ref },
              title: studentName,
              detail: `${code}, to grade`,
            }
          : { source: { kind: "course", ref: course }, title: studentName, detail: code },
      };
    }),
];

function* find(ask: Ask): Generator<AgentEffect, void> {
  const typed = (ask.request.match(/[a-z0-9]+/gi) ?? []).filter(
    (word) => !FILLER.has(word.toLowerCase()),
  );
  const terms = [...new Set(typed.map((word) => word.toLowerCase()))];
  const facets = terms.filter((term) => FACETS.has(term));
  const subject = terms.filter((term) => !FACETS.has(term));
  const hits = searchable(ask, facets).filter((doc) => {
    const hasFacet = facets.some((facet) => doc.words.has(facet));
    if (subject.length === 0) return hasFacet;
    return (
      subject.every((term) => doc.words.has(term)) &&
      (doc.isAssignment || facets.length === 0 || hasFacet)
    );
  });
  yield work("Searched assignments, rubrics, late policies, announcements, messages and students");
  if (terms.length === 0 || hits.length === 0) {
    yield say(
      terms.length === 0
        ? "What should I look for? Name an assignment, a rubric, a policy or a topic."
        : `I can't find anything about ${typed.join(" ")} in your assignments, rubrics, late policies, announcements, message subjects or students.`,
    );
    return;
  }
  const shown = hits.slice(0, FIND_SHOWN);
  const lead =
    hits.length > shown.length
      ? `Showing ${shown.length} of ${hits.length} results. Name a course to narrow it.`
      : `${hits.length} ${plural(hits.length, "result")}.`;
  yield say(
    lead,
    shown.map((hit) => hit.line),
  );
}

/** Work that already has its draft gets no pill. The answer links the draft, and asking again would only hand off a second card for it. */
const askFor = (scope: AgentScope, { course, work: next }: NextWork): string | null => {
  const code = codeOf(scope, course);
  switch (next.kind) {
    case "grading": {
      const assignment = scope.assignments.find((a) => a.ref === next.assignment);
      return assignment ? `Start grading ${assignment.shortTitle} in ${code}` : null;
    }
    case "announcement":
      return hasOpenChange(scope, course) ? null : `Open the draft announcement for ${code}`;
    case "replies":
      return scope.conversations.some(
        (c) => c.course === course && awaitsReply(c) && !hasOpenChange(scope, c.ref),
      )
        ? `Draft replies in ${code}`
        : null;
    case "reply": {
      const conversation = scope.conversations.find((c) => c.ref === next.conversation);
      return conversation && !hasOpenChange(scope, conversation.ref)
        ? `Reply to ${conversation.from}`
        : null;
    }
  }
};

const draftLine = (scope: AgentScope, change: ChangeRecord): AnswerLine => {
  const code = codeOf(scope, change.course);
  return {
    source: { kind: "change", ref: change.id },
    title: change.subject,
    ...(change.subject.includes(code) ? {} : { detail: code }),
  };
};

function* refuse({ scope }: Ask, text: string): Generator<AgentEffect, void> {
  const reviewable = scope.changes.filter((change) => {
    const { canApprove, canSend } = summarize(change);
    return canApprove || canSend;
  });
  yield {
    type: "decline",
    text,
    lines: [
      ...reviewable.slice(0, NEXT_SHOWN).map((change) => draftLine(scope, change)),
      WAITING_ON_YOU,
    ],
  };
}

/** The handoff card isn't in the history the agent reads, so this replays their earlier asks, newest first, for the last work this chat started. */
const latestHandoff = (ask: Ask): NextWork | undefined => {
  for (let at = ask.history.length - 1; at >= 0; at -= 1) {
    const said = ask.history[at];
    if (said?.role !== "user") continue;
    const earlier: Ask = { ...ask, request: said.text, history: ask.history.slice(0, at) };
    const intent = INTENTS.find((candidate) => candidate.matches(earlier));
    if (!intent || intent === FOLLOW_UP || intent === FALLBACK) continue;
    const handed = [...intent.run(earlier)].findLast((effect) => effect.type === "handoff");
    if (handed) return handed;
  }
  return undefined;
};

/** A grading handoff opens a list and drafts nothing, so it has no draft to link. */
const DRAFT_KIND: Readonly<Record<HandoffWork["kind"], ChangeRecord["content"]["kind"] | null>> = {
  reply: "reply",
  replies: "reply",
  announcement: "announcement",
  grading: null,
};

const draftsFrom = (scope: AgentScope, { course, work: handed }: NextWork): AnswerLine[] =>
  scope.changes
    .filter(
      (change) =>
        change.course === course &&
        change.content.kind === DRAFT_KIND[handed.kind] &&
        (handed.kind !== "reply" || change.content.target === handed.conversation) &&
        change.state.tag !== "sent" &&
        change.state.tag !== "discarded",
    )
    .slice(0, NEXT_SHOWN)
    .map((change) => draftLine(scope, change));

function* followUp(ask: Ask): Generator<AgentEffect, void> {
  const { scope, request } = ask;
  const latest = latestHandoff(ask);
  if (!latest) return yield* fallback(ask);
  const code = codeOf(scope, latest.course);
  const drafts = draftsFrom(scope, latest);
  const where =
    drafts.length > 0
      ? drafts
      : [{ source: { kind: "course", ref: latest.course }, title: code } satisfies AnswerLine];
  const chip = askFor(scope, latest);
  const replies = chip ? [chip] : [];
  if (CHANGE_ASK.test(request)) {
    yield {
      ...say(
        `I can't change a draft from this chat. Open it in your **${code}** thread and say what to change there.`,
        where,
      ),
      replies,
    };
    return;
  }
  const { work: handed } = latest;
  const conversation =
    handed.kind === "reply"
      ? scope.conversations.find((c) => c.ref === handed.conversation)
      : undefined;
  if (!conversation) {
    yield { ...say(`The last work I started here is in your **${code}** thread.`, where), replies };
    return;
  }
  const asked = conversation.messages.findLast((message) => !message.mine);
  const message: AnswerLine = {
    source: { kind: "conversation", ref: conversation.ref },
    title: conversation.subject,
    ...(asked ? { detail: asked.text } : {}),
  };
  yield {
    ...say(`**${conversation.from}** wrote to you: **${conversation.subject}**.`, [
      message,
      ...drafts,
    ]),
    replies,
  };
}

function* fallback(ask: Ask): Generator<AgentEffect, void> {
  const { scope, northStar } = ask;
  const latest = latestHandoff(ask);
  const next = [
    ...new Set(
      [...(latest ? [latest] : []), ...northStar.next].flatMap((item) => askFor(scope, item) ?? []),
    ),
  ].slice(0, NEXT_SHOWN);
  yield question(
    "I didn't catch that. I can tell you what's due, find things in your courses, and start work in them.",
    next.length > 0 ? next : WHATS_POSSIBLE,
  );
}

/** "Do the same for Owen" repeats the chat's last reply for the student they name. */
function* sameFor(ask: Ask): Generator<AgentEffect, void> {
  const name = SAME_FOR.exec(ask.request)?.[1]?.trim();
  if (!name || latestHandoff(ask)?.work.kind !== "reply") return yield* fallback(ask);
  yield* replies({ ...ask, request: `Reply to ${name}` });
}

const SAME: Intent = { matches: ({ request }) => SAME_FOR.test(request), run: sameFor };

/** "What did she ask about?" or "make it friendlier" points back at the work this chat last started. */
const FOLLOW_UP: Intent = {
  matches: ({ request }) => BACK_REFERENCE.test(request),
  run: followUp,
};

const FALLBACK: Intent = { matches: () => true, run: fallback };

/** First match wins, so the order is the meaning: a refusal beats everything, and a search beats the words it searches for. */
const INTENTS: readonly Intent[] = [
  { matches: ({ request }) => asksToAct(request), run: (ask) => refuse(ask, OUT_OF_SCOPE) },
  {
    matches: ({ request }) => DESTRUCTIVE_ASK.test(request),
    run: (ask) => refuse(ask, CANT_DELETE),
  },
  {
    matches: ({ request }) => /\b(find|where|search|look\s+(up|for)|locate)\b/i.test(request),
    run: find,
  },
  {
    matches: (ask) =>
      GRADING_ASK.test(ask.request) ||
      (lastAgentText(ask) === WHICH_ASSIGNMENT && titledAssignments(ask).length > 0),
    run: startGrading,
  },
  {
    matches: (ask) =>
      ANNOUNCEMENT_ASK.test(ask.request) ||
      (Boolean(lastAgentText(ask)?.endsWith(WHICH_COURSE)) &&
        (namedCourses(ask).length > 0 || unknownCodeNote(ask) !== "")),
    run: announcements,
  },
  {
    matches: ({ request }) =>
      /\b(draft|write|start|prepare)\b.*\b(repl(y|ies)|responses?)\b|\b(reply|respond)\s+to\b/i.test(
        request,
      ),
    run: replies,
  },
  {
    matches: (ask) =>
      MISSING_ASK.test(ask.request) ||
      (lastAgentText(ask) === WHICH_MISSING && titledAssignments(ask).length > 0),
    run: missingWork,
  },
  { matches: ({ request }) => BEHIND_ASK.test(request), run: behind },
  {
    matches: ({ request }) => /\b(due|deadlines?|coming\s+up|upcoming)\b/i.test(request),
    run: whatsDue,
  },
  {
    matches: ({ request }) =>
      /\b(needs?|left|waiting)\b.*\bgrad(e|ing)\b|\bto\s+grade\b|\bungraded\b|\bhow\s+(much|many)\b.*\bgrad/i.test(
        request,
      ),
    run: gradingSummary,
  },
  SAME,
  FOLLOW_UP,
  FALLBACK,
];

export function* northStarStream(
  input: AgentInput,
  northStar: NorthStarScope,
): Generator<AgentEffect, void> {
  const ask: Ask = {
    request: input.request,
    scope: input.scope,
    northStar,
    history: input.thread.history,
  };
  const intent = INTENTS.find((candidate) => candidate.matches(ask));
  if (intent) yield* intent.run(ask);
}
