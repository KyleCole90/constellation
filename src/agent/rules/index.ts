import {
  applyPatch,
  finalGrade,
  isAgentContent,
  latePenalty,
  rawScore,
  sameSlot,
  type ChangeContent,
  type ChangePatch,
  type ChangeRecord,
  type GradeContent,
  type RubricScore,
} from "~/domain/change";
import {
  passagesOf,
  type Assignment,
  type Conversation,
  type Course,
  type Submission,
} from "~/domain/lms";

import {
  DRAFT_ANNOUNCEMENT_REQUEST,
  DRAFT_GRADE_REQUEST,
  DRAFT_MESSAGE_REQUEST,
  DRAFT_REPLY_REQUEST,
  OVERALL_RATIONALE,
  SCAN_COURSE_REQUEST,
  type Agent,
  type AgentEffect,
  type AgentInput,
} from "../agent";
import { blankMessage } from "~/domain/blank";
import { workName } from "~/domain/workName";

import {
  ANNOUNCEMENT_DRAFTS,
  GRADE_DRAFTS,
  REPLY_DRAFTS,
  REPLY_SOURCES,
  type GradeDraft,
} from "./drafts";
import { northStarStream } from "./northStar";
import { OUT_OF_SCOPE, asksToAct } from "./refuse";
import { scanCourseStream } from "./scan";

const SETUP_OUT_OF_SCOPE =
  "Starting the copy, approving a fix, and publishing the course all happen with the buttons on the setup screen, so I can't do them from here. I can explain a finding or rewrite a fix you have open.";
const GRADE_CAPABILITIES =
  'I can adjust the draft you have open. Try "thesis should be 20", "lower analysis by 3", "the grade should be 88", "drop the last sentence", "say X instead of Y", "make it shorter", "warmer", "remove the attachment", or "mention the footnote".';
const ANNOUNCEMENT_CAPABILITIES =
  'I can adjust the announcement you have open. Try "make it about the midterm review on Friday", "drop the last sentence", "say X instead of Y", "make it shorter", or "mention the room change".';
const TEXT_CAPABILITIES =
  'I can adjust the draft you have open. Try "drop the last sentence", "say X instead of Y", "make it shorter", "warmer", or "mention the due date".';
/** Names this draft's own criteria, so an example never points at a rubric that isn't open. */
const gradeCapabilities = ({ rubric }: GradeContent): string => {
  const [first, second] = rubric ?? [];
  const examples = [
    ...(first ? [`"${first.name.toLowerCase()} should be ${Math.round(first.outOf * 0.8)}"`] : []),
    ...(second ? [`"lower ${second.name.toLowerCase()} by 3"`] : []),
    '"raise the grade by 3"',
    '"drop the last sentence"',
    '"say X instead of Y"',
    '"make it shorter"',
    '"warmer"',
    'or "remove the attachment"',
  ];
  return `I can adjust the draft you have open. Try ${examples.join(", ")}.`;
};
const capabilitiesFor = (content: ChangeContent): string =>
  content.kind === "grade"
    ? gradeCapabilities(content)
    : content.kind === "announcement"
      ? ANNOUNCEMENT_CAPABILITIES
      : TEXT_CAPABILITIES;
const ANNOUNCEMENT_ABOUT = /^Draft an announcement for this course about (.+)\.$/;
const RETARGET = /^(?:make|change)\s+(?:it|this)\s+(?:to\s+be\s+)?about\s+(.+)$/i;
const WARM_CLOSING =
  "I can see the effort you put into this, and I'm glad to be reading your work.";

const first = (name: string): string => name.split(" ")[0] ?? name;
const last = (name: string): string => name.split(" ").at(-1) ?? name;

const titleOf = (submission: Submission): string =>
  submission.body.kind === "none" ? "" : submission.body.title;

const findBankDraft = (submission: Submission): GradeDraft | null => {
  const opening = passagesOf(submission)[0] ?? "";
  return (
    GRADE_DRAFTS[titleOf(submission)]?.find((draft) => opening.startsWith(draft.opens)) ?? null
  );
};

const firstSentence = (text: string): string => text.match(/^[^.?!]+[.?!]?/)?.[0].trim() ?? text;

const genericDraft = (assignment: Assignment, submission: Submission): GradeDraft => {
  const scores = assignment.rubric
    ? Object.fromEntries(assignment.rubric.map((c) => [c.name, Math.round(c.maxPoints * 0.8)]))
    : null;
  const quote = passagesOf(submission)[0];
  const anchors =
    quote && assignment.rubric
      ? Object.fromEntries(
          assignment.rubric.map((c) => [c.name, [{ paragraph: 0, quote: firstSentence(quote) }]]),
        )
      : {};
  return {
    opens: "",
    scores,
    score: scores ? null : Math.round(assignment.pointsPossible * 0.8),
    why: scores
      ? Object.fromEntries(
          Object.keys(scores).map((name) => [
            name,
            "Starting point only. I have no notes on this submission, so check it against the rubric.",
          ]),
        )
      : {},
    anchors,
    comment:
      "{first}, thank you for submitting this. I've read it through, and I'll add specific notes before this goes back to you.",
    attach: false,
  };
};

/** Nothing to read means nothing to score, so the draft is a zero. Rubric criteria fall to 0 below. */
const missingDraft = (assignment: Assignment): GradeDraft => ({
  opens: "",
  scores: null,
  score: assignment.rubric ? null : 0,
  why: Object.fromEntries(
    (assignment.rubric ?? []).map((c) => [
      c.name,
      "Nothing was turned in, so there is nothing to score.",
    ]),
  ),
  anchors: {},
  comment: `{first}, I don't have your ${assignment.shortTitle} yet, so I've recorded a zero. If you turn it in, let me know.`,
  attach: false,
});

async function* draftGrade(input: AgentInput): AsyncGenerator<unknown, void> {
  const { scope } = input;
  const submission = scope.submissions[0];
  const assignment = scope.assignments.find((a) => a.ref === submission?.assignment);
  const course = scope.courses.find((c) => c.ref === submission?.course);
  if (!submission || !assignment || !course) {
    yield { type: "say", text: "I can't find that submission in what this thread has open." };
    return;
  }
  const empty = submission.body.kind === "none";
  const draft = empty
    ? missingDraft(assignment)
    : (findBankDraft(submission) ?? genericDraft(assignment, submission));
  yield {
    type: "work",
    line: empty
      ? "Found nothing turned in"
      : assignment.rubric
        ? "Read the submission and the rubric"
        : "Read the submission",
  };
  const student = submission.studentName;
  const content = {
    kind: "grade",
    target: submission.ref,
    points: draft.score,
    rubric: assignment.rubric?.map((c) => ({
      criterion: c.ref,
      points: draft.scores?.[c.name] ?? 0,
    })),
    comment: draft.comment.replaceAll("{first}", first(student)),
    attachment: draft.attach
      ? {
          name: `${assignment.shortTitle.replace(/\W+/g, "")}_feedback_${last(student)}.pdf`,
          kb: 120 + ((student.length * 53) % 180),
        }
      : null,
  };
  yield {
    type: "propose",
    school: submission.school,
    course: course.ref,
    subject: workName({ kind: "grade", student, assignment: assignment.shortTitle }),
    content,
  };
  const change = scope.changes.find(
    (c) =>
      sameSlot(c.content, { kind: "grade", target: submission.ref }) && c.state.tag === "draft",
  );
  if (!change) return;
  for (const criterion of assignment.rubric ?? []) {
    const why = draft.why[criterion.name];
    if (why)
      yield {
        type: "annotate",
        change: change.id,
        field: criterion.ref,
        why,
        quotes: draft.anchors[criterion.name] ?? [],
      };
  }
  const opening = passagesOf(submission)[0];
  if (!assignment.rubric && draft.score !== null && opening) {
    yield {
      type: "annotate",
      change: change.id,
      field: OVERALL_RATIONALE,
      why: `Scored ${draft.score} of ${assignment.pointsPossible} as a whole, since this assignment has no rubric. Check it against the opening.`,
      quotes: [{ paragraph: 0, quote: firstSentence(opening) }],
    };
  }
}

function* draftReply(conversation: Conversation | undefined): Generator<unknown, void> {
  if (!conversation) {
    yield { type: "say", text: "I can't find that conversation in what this thread has open." };
    return;
  }
  const body =
    REPLY_DRAFTS[conversation.subject] ??
    `Hi ${first(conversation.from)}, thanks for writing. I've read your message and I'll follow up shortly.`;
  yield { type: "work", line: `Read the conversation with ${conversation.from}` };
  yield {
    type: "work",
    line: REPLY_SOURCES[conversation.subject] ?? "Checked the course due dates",
  };
  yield {
    type: "propose",
    school: conversation.school,
    course: conversation.course,
    subject: workName({ kind: "replies", people: [conversation.from] }),
    content: { kind: "reply", target: conversation.ref, body },
  };
  yield {
    type: "say",
    text: `Here's a reply to ${first(conversation.from)}. Edit anything, then review it to approve and send.`,
  };
}

function* draftMessage({
  submissions,
  assignments,
}: AgentInput["scope"]): Generator<unknown, void> {
  const submission = submissions[0];
  const assignment = assignments.find((a) => a.ref === submission?.assignment);
  if (!submission || !assignment) {
    yield { type: "say", text: "I can't find that student in what this thread has open." };
    return;
  }
  const name = first(submission.studentName);
  yield { type: "work", line: `Checked what ${name} has turned in` };
  yield {
    type: "propose",
    ...blankMessage(
      submission,
      assignment,
      `Hi ${name}, I don't have your ${assignment.shortTitle} yet. Can you turn it in, or let me know if something is getting in the way?`,
    ),
  };
  yield {
    type: "say",
    text: `Here's a message to ${name}. Nothing is graded. Edit anything, then review it to approve and send.`,
  };
}

/** A draft about what the person named. The rule agent knows no details beyond their words, so it adds none. */
const announcementAbout = (code: string, topic: string) => {
  const subject = topic.replace(/^(the|a|an|our|your)\s+/i, "");
  return {
    title: `${subject.charAt(0).toUpperCase()}${subject.slice(1)}`,
    body: `Hello, ${code}. A quick note about ${topic}.`,
  };
};

function* draftAnnouncement(
  course: Course | undefined,
  topic: string | undefined,
): Generator<unknown, void> {
  if (!course) {
    yield { type: "say", text: "I can't find that course in what this thread has open." };
    return;
  }
  if (topic !== undefined) {
    const draft = announcementAbout(course.code, topic);
    yield {
      type: "propose",
      school: course.school,
      course: course.ref,
      subject: workName({ kind: "announcement", title: draft.title, course: course.code }),
      content: { kind: "announcement", target: course.ref, ...draft },
    };
    yield {
      type: "say",
      text: `Here's a draft about ${topic}. Add the details before you send it.`,
    };
    return;
  }
  const draft = ANNOUNCEMENT_DRAFTS[course.code] ?? {
    title: `This week in ${course.code}`,
    body: `Hello, ${course.code}. Here's what's coming up this week.`,
  };
  const from = draft.from ?? "upcoming due dates and the course calendar";
  yield { type: "work", line: `Read ${from}` };
  yield {
    type: "propose",
    school: course.school,
    course: course.ref,
    subject: workName({ kind: "announcement", title: draft.title, course: course.code }),
    content: { kind: "announcement", target: course.ref, title: draft.title, body: draft.body },
  };
  yield {
    type: "say",
    text: draft.say ?? `Here's a draft built from ${from}. Review it before sending.`,
  };
}

/** A draft's rewritable text and the patch that replaces it. Null when the draft has no text to rewrite. */
const textField = (
  content: ChangeContent,
): { text: string; patch: (text: string) => ChangePatch } | null => {
  if (!isAgentContent(content)) return null;
  switch (content.kind) {
    case "grade":
      return content.comment === null
        ? null
        : { text: content.comment, patch: (comment) => ({ kind: "grade", comment }) };
    case "reply":
    case "message":
    case "announcement":
      return { text: content.body, patch: (body) => ({ kind: content.kind, body }) };
    case "text-fix":
      return { text: content.splice.after, patch: (after) => ({ kind: "text-fix", after }) };
  }
};
const sentencesOf = (text: string): readonly string[] =>
  text.match(/[^.?!]+[.?!]+(\s|$)/g)?.map((s) => s.trim()) ?? [text];

const findCriterion = (rubric: readonly RubricScore[], phrase: string): RubricScore | undefined => {
  const needle = phrase.toLowerCase().trim();
  return (
    rubric.find((r) => r.name.toLowerCase().includes(needle)) ??
    rubric.find((r) => needle.includes(r.name.toLowerCase()))
  );
};

const say = (text: string): AgentEffect => ({ type: "say", text });
const decline = (text: string): AgentEffect => ({ type: "decline", text });
const edit = (change: ChangeRecord, patch: ChangePatch, why: string): Edit => ({
  type: "edit",
  change: change.id,
  patch,
  why,
});
type Edit = Extract<AgentEffect, { type: "edit" }>;

const setCriterion = (change: ChangeRecord, criterion: RubricScore, value: number): AgentEffect => {
  if (value < 0 || value > criterion.outOf)
    return decline(
      `${criterion.name} goes from 0 to ${criterion.outOf}, so I can't set it to ${value}.`,
    );
  return edit(
    change,
    { kind: "grade", rubricPoints: { [criterion.criterion]: value } },
    `Set ${criterion.name} to ${value} of ${criterion.outOf}.`,
  );
};

/** Reaches a target total by spreading the difference over criteria in order, within each one's range. */
const spread = (rubric: readonly RubricScore[], delta: number): Record<string, number> | null => {
  const points: Record<string, number> = {};
  let left = delta;
  for (const score of rubric) {
    if (score.points === null) return null;
    const room = left > 0 ? score.outOf - score.points : -score.points;
    const step = left > 0 ? Math.min(left, room) : Math.max(left, room);
    points[score.criterion] = score.points + step;
    left -= step;
  }
  return left === 0 ? points : null;
};

const setGrade = (change: ChangeRecord, content: GradeContent, final: number): AgentEffect => {
  // Rescoring would drop the teacher's total and move rubric scores the student sees.
  if (content.override != null)
    return decline(
      `You set this total to ${content.override} yourself. Change it on the form, or choose Use the scores.`,
    );
  const raw = final + latePenalty(content);
  const penaltyNote = latePenalty(content)
    ? ` That's ${raw} before the ${latePenalty(content)}-point late penalty.`
    : "";
  if (raw < 0 || raw > content.outOf)
    return decline(
      `The grade has to work out between 0 and ${content.outOf} before the late penalty, so I can't make it ${final}.`,
    );
  if (!content.rubric)
    return edit(
      change,
      { kind: "grade", points: raw },
      `Set the grade to ${final} of ${content.outOf}.${penaltyNote}`,
    );
  const total = rawScore(content);
  if (total === null) return say("Some scores are still blank, so I can't work to a total.");
  const points = spread(content.rubric, raw - total);
  if (!points) return say(`The rubric can't total ${raw}.`);
  return edit(
    change,
    { kind: "grade", rubricPoints: points },
    `Adjusted the rubric to total ${raw}, so the grade is ${final} of ${content.outOf}.${penaltyNote}`,
  );
};

const normalized = (request: string): string =>
  request
    .trim()
    .replace(/[.!]+$/, "")
    .replace(/^(?:please|can you|could you)\s+/i, "")
    .replace(/\s+please$/i, "")
    .replace(/(\d)\s*(?:points?|pts)\b/gi, "$1");

/** Each clause is read against the draft as the clauses before it left it, so two text edits stack instead of the second undoing the first. */
const correct = (
  request: string,
  change: ChangeRecord,
  submission: Submission | undefined,
  course: Course | undefined,
): readonly unknown[] => {
  const text = normalized(request);
  const clauses = text.split(/\s+and\s+(?:then\s+)?/i);
  if (clauses.length > 1) {
    const edits: Edit[] = [];
    let content = change.content;
    for (const clause of clauses) {
      const effect = correctOne(clause, { ...change, content }, submission, course);
      if (effect.type !== "edit") break;
      edits.push(effect);
      content = applyPatch(content, effect.patch) ?? content;
    }
    if (edits.length === clauses.length) return edits;
  }
  return [correctOne(text, change, submission, course)];
};

const correctOne = (
  text: string,
  change: ChangeRecord,
  submission: Submission | undefined,
  course: Course | undefined,
): AgentEffect => {
  const { content } = change;

  const retarget = content.kind === "announcement" ? RETARGET.exec(text) : null;
  if (retarget && course) {
    const topic = retarget[1] ?? "";
    return edit(
      change,
      { kind: "announcement", ...announcementAbout(course.code, topic) },
      `Rewrote it to be about ${topic}.`,
    );
  }

  if (content.kind === "grade") {
    const grade = text.match(
      /^(?:make |set |change )?(?:the )?(?:final |overall )?grade (?:(?:should be|to|=|is) )?(\d+(?:\.\d+)?)/i,
    );
    if (grade) return setGrade(change, content, Number(grade[1]));
    const gradeDelta = text.match(
      /^(lower|reduce|drop|raise|increase|bump)\s+(?:the\s+)?(?:final\s+|overall\s+)?grade\s+by\s+(\d+(?:\.\d+)?)$/i,
    );
    if (gradeDelta) {
      const now = finalGrade(content);
      if (now === null) return say("Some scores are still blank, so I can't work to a total.");
      const direction = /lower|reduce|drop/i.test(gradeDelta[1] ?? "") ? -1 : 1;
      return setGrade(change, content, now + direction * Number(gradeDelta[2]));
    }
    const delta = text.match(
      /^(lower|reduce|drop|raise|increase|bump)\s+(.+?)\s+by\s+(\d+(?:\.\d+)?)/i,
    );
    if (delta) {
      const criterion = findCriterion(content.rubric ?? [], delta[2] ?? "");
      if (criterion) {
        if (criterion.points === null) return say(`${criterion.name} has no score yet.`);
        const direction = /lower|reduce|drop/i.test(delta[1] ?? "") ? -1 : 1;
        return setCriterion(change, criterion, criterion.points + direction * Number(delta[3]));
      }
    }
    const absolute = text.match(
      /^(?:make |set |change )?(?:the )?(.+?)\s+(?:should be|to|=|is)\s+(\d+(?:\.\d+)?)/i,
    );
    const bare = text.match(/^(?:(?:make|set|give)\s+)?(?:the\s+)?(.+?)\s+(\d+(?:\.\d+)?)$/i);
    for (const match of [absolute, bare]) {
      const criterion = match && findCriterion(content.rubric ?? [], match[1] ?? "");
      if (criterion) return setCriterion(change, criterion, Number(match[2]));
    }
    if (/\b(remove|drop|delete)\b.*\battachment\b/i.test(text)) {
      if (!content.attachment) return say("There's no attachment on this draft.");
      return edit(
        change,
        { kind: "grade", attachment: null },
        `Removed ${content.attachment.name}.`,
      );
    }
  }

  const field = textField(content);
  if (field === null) return say("This draft has no comment yet, so there's nothing to rewrite.");
  const current = field.text;

  if (/\b(drop|remove|delete|cut)\b.*\blast sentence\b/i.test(text)) {
    const sentences = sentencesOf(current);
    if (sentences.length < 2) return say("That would leave nothing. Only one sentence is left.");
    return edit(
      change,
      field.patch(sentences.slice(0, -1).join(" ")),
      "Dropped the last sentence.",
    );
  }
  const swap = text.match(/^say\s+(.+?)\s+instead of\s+(.+)$/i);
  if (swap) {
    const [, next = "", previous = ""] = swap;
    const clean = (phrase: string) => phrase.replace(/^["']|["']$/g, "");
    if (!current.includes(clean(previous)))
      return say(`I can't find "${clean(previous)}" in the draft.`);
    return edit(
      change,
      field.patch(current.replace(clean(previous), clean(next))),
      `Changed "${clean(previous)}" to "${clean(next)}".`,
    );
  }
  if (/\bshorter\b/i.test(text)) {
    const sentences = sentencesOf(current);
    if (sentences.length < 3)
      return say("It's already about as short as it can be and still make its point.");
    return edit(
      change,
      field.patch(`${sentences[0]} ${sentences.at(-1)}`),
      "Cut it down to the opening and the closing.",
    );
  }
  if (/\bwarmer\b/i.test(text)) {
    if (current.includes(WARM_CLOSING))
      return say(
        "I've already added the warmer closing. Tell me what else to say in your own words.",
      );
    return edit(change, field.patch(`${current} ${WARM_CLOSING}`), "Added a warmer closing.");
  }
  const mention = text.match(/^(?:also\s+)?mention\s+(.+)$/i);
  if (mention) {
    const topic = mention[1] ?? "";
    const bare = topic.replace(/^(the|a|an|your)\s+/i, "");
    const inWork = submission
      ? passagesOf(submission).some((p) => p.toLowerCase().includes(bare.toLowerCase()))
      : false;
    const sentence = inWork
      ? `I also noticed what you wrote about ${topic}.`
      : `Also, please keep ${topic} in mind.`;
    return edit(change, field.patch(`${current} ${sentence}`), `Added a sentence about ${topic}.`);
  }
  return say(capabilitiesFor(content));
};

/** Yields raw objects on purpose: this agent goes through the same parser a real model would. */
export const createRuleAgent = (): Agent => ({
  label: "Rule-based drafts",
  async *run(input) {
    const { request, scope } = input;
    if (scope.northStar) return yield* northStarStream(input, scope.northStar);
    if (request === DRAFT_GRADE_REQUEST) return yield* draftGrade(input);
    if (request === DRAFT_REPLY_REQUEST) return yield* draftReply(scope.conversations[0]);
    if (request === DRAFT_MESSAGE_REQUEST) return yield* draftMessage(scope);
    const about = ANNOUNCEMENT_ABOUT.exec(request)?.[1];
    if (request === DRAFT_ANNOUNCEMENT_REQUEST || about !== undefined)
      return yield* draftAnnouncement(scope.courses[0], about);
    if (request === SCAN_COURSE_REQUEST) return yield* scanCourseStream(scope);

    if (scope.scan && /\b(approve|publish|copy|send|post|submit|start)\b/i.test(request)) {
      yield decline(SETUP_OUT_OF_SCOPE);
      return;
    }
    if (asksToAct(request)) {
      yield decline(OUT_OF_SCOPE);
      return;
    }
    const change = scope.changes.find((c) => c.id === scope.focus);
    const [only, ...others] = scope.conversations;
    const onOneConversation = only && others.length === 0 && scope.submissions.length === 0;
    if (!change && onOneConversation && /\b(draft|write|reply)\b/i.test(request))
      return yield* draftReply(only);
    if (!change) {
      yield say(
        `Open a submission, a message, or an announcement first, and I'll draft it. ${GRADE_CAPABILITIES}`,
      );
      return;
    }
    const target = change.content.target;
    yield* correct(
      request,
      change,
      scope.submissions.find((s) => s.ref === target),
      scope.courses.find((c) => c.ref === change.course),
    );
  },
});
