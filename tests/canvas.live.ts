import { readFile } from "node:fs/promises";

import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";

import { canvasSchoolAt, createCanvasProvider } from "~/main/providers/canvas";
import {
  fieldText,
  newChangeRecord,
  type ChangeContent,
  type GradeContent,
  type LmsError,
  type SetContent,
} from "~/shared/domain/change";
import type { Migration } from "~/shared/domain/content";
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
import { PACKAGES } from "~/shared/providers/fake-canvas/seed-term";
import { Secret } from "~/shared/providers/provider";
import { DEFAULT_RETRY_POLICY, createWriteback } from "~/renderer/writeback/writeback";

import { DurableLedger } from "./fixtures/ledger";
import { cartridgeContent, copyContent } from "./fixtures/term";

/*
 * `npm run contract:live`: every Canvas read against a live school, each answer parsed as the bridge would parse it,
 * then one grade and comment sent through the runner with the comment's response thrown away, and, given a sandbox
 * shell and source, a course copied and published. It reaches a real host,
 * so it runs only through that script, never in `npm test` or CI.
 */
const {
  CANVAS_HOST: host = "",
  CANVAS_TOKEN: token = "",
  CANVAS_SUBMISSION: sandbox = "",
  CANVAS_TERM_SHELL: termShell = "",
  CANVAS_TERM_SOURCE: termSource = "",
  CANVAS_IMSCC_SHELL: imsccShell = "",
} = process.env;
/** The fixture package `contract:live` imports, with the term its dates came from. */
const LIVE_PACKAGE = PACKAGES.find(
  (pkg) => pkg.name === "eng210-northgate-spring2026-export.imscc",
);
const school = canvasSchoolAt(host);
const LIVE_TIMEOUT_MS = 120_000;
const COPY_TIMEOUT_MS = 300_000;

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
    packageFile: async (name) =>
      name === LIVE_PACKAGE?.name
        ? new Blob([await readFile(new URL(`../fixtures/imscc/${name}`, import.meta.url))])
        : null,
  });

  /** Polls a course's jobs until the one named `signature` finishes. */
  const finished = async (course: LmsRef<"course">, signature: string) => {
    const setup = provider.termSetup;
    if (!setup) throw new Error("Canvas offers no term setup");
    let job: Migration | undefined;
    for (const started = Date.now(); Date.now() - started < COPY_TIMEOUT_MS;) {
      job = unwrap("migrations", await setup.migrations(course)).findLast(
        (entry) => entry.signature === signature,
      );
      if (job?.state === "completed" || job?.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return job;
  };

  /** One change read, approved with a trusted click and sent through the runner, as the app sends it. */
  const runnerFor = async (content: ChangeContent, course: LmsRef<"course">) => {
    const at = new Date().toISOString() as IsoTime;
    const remote = unwrap("observe", await provider.observe(content));
    const ledger = new DurableLedger();
    const draft = newChangeRecord({
      id: `ch-live-${content.kind}` as ChangeId,
      school: school.id,
      course,
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
    return async () => {
      await writeback.send([draft.id]);
      return ledger.get(draft.id)?.state.tag;
    };
  };

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
      const send = await runnerFor(content, `${school.id}:course:${course}` as LmsRef<"course">);
      loseComment = true;
      expect(await send()).toBe("sent");
      const after = unwrap("observe after", await provider.observe(content));
      if (after.kind !== "grade") throw new Error("observe read no grade");
      expect(after.grade).toBe(1);
      expect(after.comments.filter((comment) => comment.text === content.comment)).toHaveLength(1);
    },
    LIVE_TIMEOUT_MS,
  );

  const termTest = [termShell, termSource].every((id) => /^\d+$/.test(id)) ? it : it.skip;
  termTest(
    "a sandbox course goes from copy to published (set CANVAS_TERM_SHELL=<an empty unpublished course starting later> and CANVAS_TERM_SOURCE=<a dated course to copy from>)",
    async () => {
      const setup = provider.termSetup;
      if (!setup) throw new Error("Canvas offers no term setup");
      const shell = unwrap("newCourses", await setup.newCourses()).find(
        (entry) => entry.ref === `${school.id}:course:${termShell}`,
      );
      const source = unwrap("copySources", await setup.copySources()).find(
        (entry) => entry.ref === `${school.id}:course:${termSource}`,
      );
      if (!shell)
        throw new Error("CANVAS_TERM_SHELL isn't an unpublished course that starts later");
      if (!source) throw new Error("CANVAS_TERM_SOURCE isn't a dated course this teacher taught");
      const copy = copyContent(shell, source);
      expect(await (await runnerFor(copy, shell.ref))()).toBe("sent");
      const job = await finished(shell.ref, fieldText(copy, "copy"));
      expect(job?.state, job?.message ?? "the copy never finished").toBe("completed");
      const content = unwrap("courseContent", await setup.courseContent(shell.ref));
      expect(content.items.length, "what the copy brought").toBeGreaterThan(0);
      const publish: SetContent = {
        kind: "item-set",
        target: shell.stateTarget,
        where: shell.code,
        intent: { set: "course-published" },
      };
      expect(await (await runnerFor(publish, shell.ref))()).toBe("sent");
      expect(unwrap("courses", await provider.courses()).map((entry) => entry.ref)).toContain(
        shell.ref,
      );
    },
    COPY_TIMEOUT_MS + LIVE_TIMEOUT_MS,
  );
  const imsccTest = /^\d+$/.test(imsccShell) ? it : it.skip;
  imsccTest(
    "a fixture .imscc imports into a sandbox course (set CANVAS_IMSCC_SHELL=<an empty unpublished course starting later>)",
    async () => {
      const setup = provider.termSetup;
      const hint = LIVE_PACKAGE?.hint;
      if (!setup || !LIVE_PACKAGE || !hint) throw new Error("no term setup or package");
      const shell = unwrap("newCourses", await setup.newCourses()).find(
        (entry) => entry.ref === `${school.id}:course:${imsccShell}`,
      );
      if (!shell)
        throw new Error("CANVAS_IMSCC_SHELL isn't an unpublished course that starts later");
      const content = cartridgeContent(shell, LIVE_PACKAGE.name, hint);
      expect(await (await runnerFor(content, shell.ref))()).toBe("sent");
      const job = await finished(shell.ref, fieldText(content, "copy"));
      expect(job?.state, job?.message ?? "the import never finished").toBe("completed");
    },
    COPY_TIMEOUT_MS + LIVE_TIMEOUT_MS,
  );
});
