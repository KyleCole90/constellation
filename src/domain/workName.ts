import type { ChangeContent } from "./change";

export type NamedWork =
  | { kind: "grading"; assignment: string }
  | { kind: "grade"; student: string; assignment: string }
  | { kind: "replies"; people: readonly string[] }
  | { kind: "message"; student: string }
  | { kind: "announcement"; title: string; course: string };

export const peopleWords = ([first, ...rest]: readonly string[]): string =>
  rest.length === 0
    ? (first ?? "")
    : `${first} and ${rest.length} ${rest.length === 1 ? "other" : "others"}`;

export const workName = (work: NamedWork): string => {
  switch (work.kind) {
    case "grading":
      return `Grade ${work.assignment}`;
    case "grade":
      return `${work.student}, ${work.assignment}`;
    case "replies":
      return `Reply to ${peopleWords(work.people)}`;
    case "message":
      return `Message ${work.student}`;
    case "announcement":
      return work.title.trim() || `${work.course} announcement`;
  }
};

export const workLine = (content: ChangeContent, course: string): string | null => {
  switch (content.kind) {
    case "grade":
      return null;
    case "reply":
    case "message":
      return `Message in ${course}`;
    case "announcement":
      return content.title.trim() ? `Announcement to ${course}` : null;
    case "course-copy":
    case "item-set":
    case "text-fix":
      return course;
  }
};
