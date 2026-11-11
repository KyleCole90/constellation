import type { Assignment, Conversation, Course, Submission } from "./lms";
import type { ChangeContent, ChangeRecord, LatePenalty, RubricScore } from "./change";
import { workName } from "./workName";

export type Proposal = Pick<ChangeRecord, "school" | "course" | "subject" | "content">;

export const lateOf = (submission: Submission, assignment: Assignment): LatePenalty | null =>
  submission.lateDays > 0 && assignment.latePointsPerDay
    ? { days: submission.lateDays, pointsPerDay: assignment.latePointsPerDay, waived: false }
    : null;

export const blankGrade = (submission: Submission, assignment: Assignment): Proposal => {
  const rubric =
    assignment.rubric?.map((criterion): RubricScore => ({
      criterion: criterion.ref,
      name: criterion.name,
      points: null,
      outOf: criterion.maxPoints,
    })) ?? [];
  return {
    school: submission.school,
    course: submission.course,
    subject: workName({
      kind: "grade",
      student: submission.studentName,
      assignment: assignment.shortTitle,
    }),
    content: {
      kind: "grade",
      target: submission.ref,
      points: null,
      outOf: assignment.pointsPossible,
      rubric: rubric.length > 0 ? rubric : null,
      late: lateOf(submission, assignment),
      comment: null,
      attachment: null,
      override: null,
      excused: false,
    },
  };
};

export const blankReply = (conversation: Conversation): Proposal => ({
  school: conversation.school,
  course: conversation.course,
  subject: workName({ kind: "replies", people: [conversation.from] }),
  content: { kind: "reply", target: conversation.ref, body: "" },
});

/** The subject names the assignment, so the conversation reads on its own in the student's inbox. */
export const blankMessage = (
  submission: Submission,
  assignment: Assignment,
  body = "",
): Proposal => ({
  school: submission.school,
  course: submission.course,
  subject: workName({ kind: "message", student: submission.studentName }),
  content: {
    kind: "message",
    target: submission.ref,
    subject: assignment.title,
    body,
  },
});

export const blankAnnouncement = (course: Course): Proposal => ({
  school: course.school,
  course: course.ref,
  subject: workName({ kind: "announcement", title: "", course: course.code }),
  content: { kind: "announcement", target: course.ref, title: "", body: "" },
});

export const isBlank = (content: ChangeContent): boolean => {
  switch (content.kind) {
    case "grade":
      return (
        !content.excused &&
        content.points === null &&
        (content.rubric ?? []).every((score) => score.points === null) &&
        content.comment === null &&
        content.attachment === null
      );
    case "reply":
    case "message":
      return !content.body.trim();
    case "announcement":
      return !content.title.trim() && !content.body.trim();
    case "course-copy":
    case "text-fix":
    case "item-set":
      return false;
  }
};
