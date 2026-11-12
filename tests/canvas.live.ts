import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";

import { canvasSchoolAt, createCanvasProvider } from "~/main/providers/canvas";
import type { LmsError } from "~/shared/domain/change";
import type { Result } from "~/shared/domain/ids";
import {
  AccountInfoSchema,
  AnnouncementSchema,
  AssignmentSchema,
  ConversationSchema,
  CourseSchema,
  StudentSchema,
  SubmissionSchema,
  listOf,
} from "~/shared/providers/schemas";
import { Secret } from "~/shared/providers/provider";

/*
 * The read half of `npm run contract:live`: every Canvas read against a live school, each answer parsed as the bridge
 * would parse it. It reaches a real host, so it runs only through that script, never in `npm test` or CI.
 */
const { CANVAS_HOST: host = "", CANVAS_TOKEN: token = "" } = process.env;
const school = canvasSchoolAt(host);
const LIVE_TIMEOUT_MS = 120_000;

const unwrap = <T>(label: string, result: Result<T, LmsError>): T => {
  if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.value;
};

describe("Canvas reads against a live school", () => {
  if (!school || token === "") {
    it.skip("skipped: set CANVAS_HOST (as school.instructure.com) and CANVAS_TOKEN (a personal access token) to run", () => {});
    return;
  }
  const provider = createCanvasProvider({
    school,
    lease: {
      use: (work) => work({ kind: "bearer", token: new Secret(token) }),
      replace: () => Promise.reject(new Error("contract:live never replaces the token")),
    },
    fetch: (url, init) => fetch(url, init),
  });

  it(
    "verify and the six list reads return whole lists the bridge accepts",
    async () => {
      v.parse(AccountInfoSchema, unwrap("verify", await provider.verify()));
      const courses = v.parse(listOf(CourseSchema), unwrap("courses", await provider.courses()));
      expect(courses.length, "the token's teacher courses").toBeGreaterThan(0);
      v.parse(listOf(ConversationSchema), unwrap("conversations", await provider.conversations()));
      for (const course of courses) {
        const label = (read: string) => `${read} for ${course.code}`;
        v.parse(
          listOf(AssignmentSchema),
          unwrap(label("assignments"), await provider.assignments(course.ref)),
        );
        v.parse(
          listOf(StudentSchema),
          unwrap(label("students"), await provider.students(course.ref)),
        );
        v.parse(
          listOf(SubmissionSchema),
          unwrap(label("submissions"), await provider.submissions(course.ref)),
        );
        v.parse(
          listOf(AnnouncementSchema),
          unwrap(label("announcements"), await provider.announcements(course.ref)),
        );
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
