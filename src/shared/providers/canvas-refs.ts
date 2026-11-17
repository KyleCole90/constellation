import type { ContentItemType } from "~/shared/domain/content";
import type { LmsRef } from "~/shared/domain/ids";

/** Canvas-shaped numeric ids live inside the ref, so `describe` can print a real path without a lookup. */
const ref = <K extends string>(school: string, kind: K, ...ids: readonly (string | number)[]) =>
  [school, kind, ...ids].join(":") as LmsRef<K>;

export const refs = {
  course: (school: string, courseId: number) => ref(school, "course", courseId),
  assignment: (school: string, courseId: number, assignmentId: number) =>
    ref(school, "assignment", courseId, assignmentId),
  student: (school: string, userId: number) => ref(school, "student", userId),
  criterion: (school: string, assignmentId: number, criterion: string) =>
    ref(school, "criterion", assignmentId, criterion),
  submission: (school: string, courseId: number, assignmentId: number, userId: number) =>
    ref(school, "submission", courseId, assignmentId, userId),
  conversation: (school: string, conversationId: number) =>
    ref(school, "conversation", conversationId),
  announcement: (school: string, id: string | number) => ref(school, "announcement", id),
  /** `type` rides in the ref because each Canvas item type has its own path, and a route needs it without a lookup. */
  item: (school: string, courseId: number, type: ContentItemType, id: number) =>
    ref(school, "item", courseId, type, id),
  module: (school: string, courseId: number, id: number) => ref(school, "module", courseId, id),
  tool: (school: string, courseId: number, id: number) => ref(school, "tool", courseId, id),
  migrations: (school: string, courseId: number) => ref(school, "migrations", courseId),
  migration: (school: string, courseId: number, id: number) =>
    ref(school, "migration", courseId, id),
  courseState: (school: string, courseId: number) => ref(school, "course-state", courseId),
};

export const refParts = (value: string): readonly string[] => value.split(":");
