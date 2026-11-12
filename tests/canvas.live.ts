import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";

import { canvasSchoolAt, createCanvasProvider } from "~/main/providers/canvas";
import { newChangeRecord, type GradeContent, type LmsError } from "~/shared/domain/change";
import { ApprovalWitness, fingerprintOf } from "~/shared/domain/approval";
import type { ChangeId, IsoTime, LmsRef, Result } from "~/shared/domain/ids";
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
import { DEFAULT_RETRY_POLICY, createWriteback } from "~/renderer/writeback/writeback";

import { DurableLedger } from "./fixtures/ledger";

/*
 * `npm run contract:live`: every Canvas read against a live school, each answer parsed as the bridge would parse it,
 * then one grade and comment sent through the runner with the comment's response thrown away. It reaches a real host,
 * so it runs only through that script, never in `npm test` or CI.
 */
const {
  CANVAS_HOST: host = "",
  CANVAS_TOKEN: token = "",
  CANVAS_SUBMISSION: sandbox = "",
} = process.env;
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
  /** Set to throw away the answer to the next comment write, after Canvas has applied it. */
  let loseComment = false;
  const provider = createCanvasProvider({
    school,
    lease: {
      use: (work) => work({ kind: "bearer", token: new Secret(token) }),
      replace: () => Promise.reject(new Error("contract:live never replaces the token")),
    },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (
        loseComment &&
        (typeof init.body === "string" ? init.body : "").includes("comment%5Btext_comment%5D")
      ) {
        loseComment = false;
        throw new TypeError("contract:live lost this response on purpose");
      }
      return response;
    },
    now: () => Date.now(),
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

  const [course, assignment, user] = sandbox.split("/");
  const writeTest = [course, assignment, user].every((id) => /^\d+$/.test(id ?? "")) ? it : it.skip;
  writeTest(
    "a grade and comment sent through the runner land once, though the comment's response was lost (set CANVAS_SUBMISSION=<course>/<assignment>/<student> on a sandbox course)",
    async () => {
      const at = new Date().toISOString() as IsoTime;
      const content: GradeContent = {
        kind: "grade",
        target: `${school.id}:submission:${course}:${assignment}:${user}` as LmsRef<"submission">,
        points: 1,
        outOf: 1,
        rubric: null,
        late: null,
        comment: `contract:live ${at}`,
        attachment: null,
        override: null,
        excused: false,
      };
      const remote = unwrap("observe", await provider.observe(content));
      const ledger = new DurableLedger();
      const draft = newChangeRecord({
        id: "ch-live" as ChangeId,
        school: school.id,
        course: `${school.id}:course:${course}` as LmsRef<"course">,
        subject: "contract:live",
        content,
        basis: { readAt: at, remote },
        at,
        by: "you",
      });
      ledger.add(draft);
      const witness = ApprovalWitness.fromClick({ isTrusted: true, type: "click" }, [
        { changeId: draft.id, fingerprint: fingerprintOf(draft) },
      ]);
      if (!witness) throw new Error("no witness");
      expect(ledger.commit(draft.id, { type: "approve", witness, at }).ok).toBe(true);
      const writeback = createWriteback({
        ledger,
        providerFor: () => provider,
        markExpired: () => undefined,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        random: () => Math.random(),
        policy: DEFAULT_RETRY_POLICY,
        locks: null,
      });
      loseComment = true;
      await writeback.send([draft.id]);
      expect(ledger.get(draft.id)?.state.tag).toBe("sent");
      const after = unwrap("observe after", await provider.observe(content));
      if (after.kind !== "grade") throw new Error("observe read no grade");
      expect(after.grade).toBe(1);
      expect(after.comments.filter((comment) => comment.text === content.comment)).toHaveLength(1);
    },
    LIVE_TIMEOUT_MS,
  );
});
