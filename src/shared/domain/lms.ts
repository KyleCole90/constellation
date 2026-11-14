import type { IsoTime, LmsRef, SchoolHost, SchoolId } from "./ids";

type ProviderKind = "fake-canvas" | "canvas";

export interface School {
  id: SchoolId;
  abbr: string;
  name: string;
  host: SchoolHost;
  provider: ProviderKind;
}

/** A demo school runs on the fake LMS. A new provider has to pick a side here. */
const DEMO_PROVIDER: Readonly<Record<ProviderKind, boolean>> = {
  "fake-canvas": true,
  canvas: false,
};

export const isDemoSchool = (school: School): boolean => DEMO_PROVIDER[school.provider];

/** The one order schools take in every list and filter: by name. */
export const bySchoolName = (a: School, b: School): number => a.name.localeCompare(b.name);

export interface Student {
  ref: LmsRef<"student">;
  school: SchoolId;
  course: LmsRef<"course">;
  name: string;
}

export interface Course {
  ref: LmsRef<"course">;
  school: SchoolId;
  code: string;
  title: string;
  section: string | null;
  modality: string | null;
  studentCount: number;
}

interface RubricCriterion {
  ref: LmsRef<"criterion">;
  name: string;
  maxPoints: number;
}

export interface Assignment {
  ref: LmsRef<"assignment">;
  school: SchoolId;
  course: LmsRef<"course">;
  title: string;
  shortTitle: string;
  dueAt: IsoTime | null;
  pointsPossible: number;
  rubric: readonly RubricCriterion[] | null;
  latePointsPerDay: number | null;
}

export type SubmissionBody =
  | { kind: "text"; title: string; wordCount: number; paragraphs: readonly string[] }
  | { kind: "media"; title: string; durationLabel: string; transcript: readonly string[] }
  | { kind: "none" };

export interface SubmissionComment {
  id: string;
  mine: boolean;
  text: string;
  at: IsoTime;
}

export interface Submission {
  ref: LmsRef<"submission">;
  school: SchoolId;
  course: LmsRef<"course">;
  assignment: LmsRef<"assignment">;
  student: LmsRef<"student">;
  studentName: string;
  /** Mirrors the LMS, so a resubmission reads as submitted with its prior grade still present. */
  workflow: "unsubmitted" | "missing" | "submitted" | "graded" | "excused";
  attempt: number;
  lateDays: number;
  submittedAt: IsoTime | null;
  grade: number | null;
  rubricScores: Readonly<Record<string, number>> | null;
  comments: readonly SubmissionComment[];
  body: SubmissionBody;
}

/** The text a rationale can anchor to: paragraphs of writing, or the transcript of a recording. */
export const passagesOf = (submission: Submission): readonly string[] => {
  switch (submission.body.kind) {
    case "text":
      return submission.body.paragraphs;
    case "media":
      return submission.body.transcript;
    case "none":
      return [];
  }
};

const wordsIn = (paragraphs: readonly string[]): number =>
  paragraphs.join(" ").split(/\s+/).filter(Boolean).length;

export const excerptNote = (body: SubmissionBody): string | null => {
  switch (body.kind) {
    case "text":
      return wordsIn(body.paragraphs) < body.wordCount ? "Excerpts" : null;
    case "media":
      return "Auto transcript, excerpts";
    case "none":
      return null;
  }
};

export interface ConversationMessage {
  id: string;
  mine: boolean;
  author: string;
  text: string;
  at: IsoTime;
}

export interface Conversation {
  ref: LmsRef<"conversation">;
  school: SchoolId;
  course: LmsRef<"course">;
  subject: string;
  from: string;
  unread: boolean;
  messages: readonly ConversationMessage[];
}

/** Unread and the last word isn't mine. A reply isn't reused the way a sent grade is, so opening an answered one would draft another. */
export const awaitsReply = (conversation: Conversation): boolean =>
  conversation.unread && conversation.messages.at(-1)?.mine !== true;

export interface Announcement {
  ref: LmsRef<"announcement">;
  school: SchoolId;
  course: LmsRef<"course">;
  title: string;
  body: string;
  postedAt: IsoTime;
}
