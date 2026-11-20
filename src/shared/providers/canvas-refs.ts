import type { ContentItemType } from "~/shared/domain/content";
import type { LmsRef, SchoolId } from "~/shared/domain/ids";

const ref = <K extends string>(school: SchoolId, kind: K, ...ids: readonly (string | number)[]) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mint: the provider that parses refs writes them here
  [school, kind, ...ids].join(":") as LmsRef<K>;

type In<Ids extends string, Id = number> = { school: SchoolId } & Readonly<Record<Ids, Id>>;

export const refs = {
  course: ({ school, course }: In<"course">) => ref(school, "course", course),
  assignment: ({ school, course, assignment }: In<"course" | "assignment">) =>
    ref(school, "assignment", course, assignment),
  student: ({ school, user }: In<"user">) => ref(school, "student", user),
  criterion: ({ school, assignment, criterion }: In<"assignment"> & { criterion: string }) =>
    ref(school, "criterion", assignment, criterion),
  submission: ({ school, course, assignment, user }: In<"course" | "assignment" | "user">) =>
    ref(school, "submission", course, assignment, user),
  conversation: ({ school, conversation }: In<"conversation">) =>
    ref(school, "conversation", conversation),
  announcement: ({ school, announcement }: In<"announcement", string | number>) =>
    ref(school, "announcement", announcement),
  item: ({ school, course, type, item }: In<"course" | "item"> & { type: ContentItemType }) =>
    ref(school, "item", course, type, item),
  module: ({ school, course, module }: In<"course" | "module">) =>
    ref(school, "module", course, module),
  tool: ({ school, course, tool }: In<"course" | "tool">) => ref(school, "tool", course, tool),
  migrations: ({ school, course }: In<"course">) => ref(school, "migrations", course),
  migration: ({ school, course, migration }: In<"course" | "migration">) =>
    ref(school, "migration", course, migration),
  courseState: ({ school, course }: In<"course">) => ref(school, "course-state", course),
};

export const refParts = (value: string): readonly string[] => value.split(":");
