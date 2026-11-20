import type { Assignment, Conversation, Course, School, Submission } from "~/shared/domain/lms";
import type { WorkRow } from "~/renderer/components/thread/queue.logic";
import type { DueItem, InboxRow } from "~/renderer/stores/selectors";

import { AT, COURSE, SCHOOL, SUBMISSION } from "./changes";
import { lmsRef, schoolHost, schoolId } from "./ids";

export const school = (id = "lcc", patch: Partial<School> = {}): School => ({
  id: schoolId(id),
  abbr: id.toUpperCase(),
  name: id,
  host: schoolHost(`${id}.test`),
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
  ref: lmsRef<"assignment">("lcc:assignment:2"),
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

export const submission = (patch: Partial<Submission> = {}): Submission => ({
  ref: SUBMISSION,
  school: SCHOOL,
  course: COURSE,
  assignment: lmsRef<"assignment">("lcc:assignment:2"),
  student: lmsRef<"student">("lcc:student:3"),
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
  ref: lmsRef<"conversation">("lcc:conversation:1"),
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
  assignment: lmsRef<"assignment">("a-essay"),
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

export const submissionRow = (
  key: string,
  patch: Partial<Omit<SubmissionRow, "kind" | "key">> = {},
): WorkRow => ({
  ...rowDefaults,
  title: key,
  ...patch,
  key: lmsRef<"submission">(key),
  kind: "submission",
});

export const conversationRow = (
  key: string,
  patch: Partial<Omit<ConversationRow, "kind" | "key">> = {},
): WorkRow => ({
  ...rowDefaults,
  title: key,
  ...patch,
  key: lmsRef<"conversation">(key),
  kind: "conversation",
});

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

export const inboxRow = (patch: Partial<InboxRow> = {}): InboxRow => ({
  conversation: conversation(),
  course: course(),
  school: school(),
  last: null,
  change: null,
  summary: null,
  ...patch,
});
