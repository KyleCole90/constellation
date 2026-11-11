import type { ContentItemType } from "~/shared/domain/content";
import type { LmsRef } from "~/shared/domain/ids";

/** Canvas-shaped numeric ids live inside the ref, so `describe` can print a real path without a lookup. */
const ref = <K extends string>(...parts: readonly (string | number)[]) =>
  parts.join(":") as LmsRef<K>;

export const refs = {
  course: (school: string, courseId: number) => ref<"course">(school, "course", courseId),
  assignment: (school: string, courseId: number, assignmentId: number) =>
    ref<"assignment">(school, "assignment", courseId, assignmentId),
  student: (school: string, userId: number) => ref<"student">(school, "student", userId),
  criterion: (school: string, assignmentId: number, criterion: string) =>
    ref<"criterion">(school, "criterion", assignmentId, criterion),
  submission: (school: string, courseId: number, assignmentId: number, userId: number) =>
    ref<"submission">(school, "submission", courseId, assignmentId, userId),
  conversation: (school: string, conversationId: number) =>
    ref<"conversation">(school, "conversation", conversationId),
  announcement: (school: string, id: string | number) =>
    ref<"announcement">(school, "announcement", id),
  /** `type` rides in the ref because each Canvas item type has its own path, and a route needs it without a lookup. */
  item: (school: string, courseId: number, type: ContentItemType, id: number) =>
    ref<"item">(school, "item", courseId, type, id),
  module: (school: string, courseId: number, id: number) =>
    ref<"module">(school, "module", courseId, id),
  tool: (school: string, courseId: number, id: number) => ref<"tool">(school, "tool", courseId, id),
  migrations: (school: string, courseId: number) =>
    ref<"migrations">(school, "migrations", courseId),
  migration: (school: string, courseId: number, id: number) =>
    ref<"migration">(school, "migration", courseId, id),
  courseState: (school: string, courseId: number) =>
    ref<"course-state">(school, "course-state", courseId),
};

export const refParts = (value: string): readonly string[] => value.split(":");

/** Not every seeded assignment has a Canvas id, and a path needs one. */
export const assignmentCanvasId = (
  assignment: { canvasId?: number },
  courseIndex: number,
  assignmentIndex: number,
): number => assignment.canvasId ?? 900000 + courseIndex * 100 + assignmentIndex;
