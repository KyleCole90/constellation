import { type LmsRef, type SchoolHost, type SchoolId } from "~/shared/domain/ids";
import type { Assignment, Conversation, Course, School, Submission } from "~/shared/domain/lms";
import type { WorkRow } from "~/renderer/components/thread/queue.logic";
import type { DueItem, InboxRow } from "~/renderer/stores/selectors";

import { AT, COURSE, SCHOOL, SUBMISSION } from "./changes";

export const school = (id = "lcc", patch: Partial<School> = {}): School => ({
  id: id as SchoolId,
  abbr: id.toUpperCase(),
  name: id,
  host: `${id}.test` as SchoolHost,
  provider: "fake-canvas",
  ...patch,
});

export const course = (patch: Partial<Course> = {}): Course => ({
  ref: COURSE,
  school: SCHOOL,
  code: "HUM 150",
  title: "Humanities",
  section: null,
  modality: null,
  studentCount: 20,
  ...patch,
});

export const assignment = (patch: Partial<Assignment> = {}): Assignment => ({
  ref: "lcc:assignment:2" as LmsRef<"assignment">,
  school: SCHOOL,
  course: COURSE,
  title: "Essay 2",
  shortTitle: "Essay 2",
  dueAt: null,
  pointsPossible: 100,
  rubric: null,
  latePointsPerDay: null,
  ...patch,
});

/** Text turned in on time, not graded yet. */
export const submission = (patch: Partial<Submission> = {}): Submission => ({
  ref: SUBMISSION,
  school: SCHOOL,
  course: COURSE,
  assignment: "lcc:assignment:2" as LmsRef<"assignment">,
  student: "lcc:student:3" as LmsRef<"student">,
  studentName: "Maya Ortiz",
  workflow: "submitted",
  attempt: 1,
  lateDays: 0,
  submittedAt: AT,
  grade: null,
  rubricScores: null,
  comments: [],
  body: { kind: "text", title: "Essay 2", wordCount: 2, paragraphs: ["My essay."] },
  page: null,
  ...patch,
});

export const conversation = (patch: Partial<Conversation> = {}): Conversation => ({
  ref: "lcc:conversation:1" as LmsRef<"conversation">,
  school: SCHOOL,
  course: COURSE,
  subject: "A question",
  from: "Maya Ortiz",
  students: [],
  unread: false,
  messages: [],
  ...patch,
});

type SubmissionRow = Extract<WorkRow, { kind: "submission" }>;
type ConversationRow = Extract<WorkRow, { kind: "conversation" }>;

const rowDefaults = {
  title: "",
  detail: "Essay 2",
  assignment: "a-essay" as LmsRef<"assignment">,
  school: school(),
  course: course(),
  dueAt: null,
  lateDays: 0,
  resubmitted: false,
  change: null,
  summary: null,
  open: true,
  asked: null,
  missing: false,
  draftable: true,
} satisfies Omit<WorkRow, "key" | "kind">;

/** A queue row for a submission, titled by its key, with nothing drafted yet. */
export const submissionRow = (
  key: string,
  patch: Partial<Omit<SubmissionRow, "kind" | "key">> = {},
): WorkRow => ({
  ...rowDefaults,
  title: key,
  ...patch,
  key: key as LmsRef<"submission">,
  kind: "submission",
});

/** A queue row for a conversation, titled by its key, with nothing drafted yet. */
export const conversationRow = (
  key: string,
  patch: Partial<Omit<ConversationRow, "kind" | "key">> = {},
): WorkRow => ({
  ...rowDefaults,
  title: key,
  ...patch,
  key: key as LmsRef<"conversation">,
  kind: "conversation",
});

/** An assignment with nothing turned in, and no due date. */
export const dueItem = (patch: Partial<DueItem> = {}): DueItem => ({
  assignment: assignment(),
  course: course(),
  school: school(),
  toGrade: 0,
  late: 0,
  submitted: 0,
  graded: 0,
  missing: 0,
  total: 0,
  days: null,
  ...patch,
});

/** A conversation no one has written in, with no reply under way. */
export const inboxRow = (patch: Partial<InboxRow> = {}): InboxRow => ({
  conversation: conversation(),
  course: course(),
  school: school(),
  last: null,
  change: null,
  summary: null,
  ...patch,
});
