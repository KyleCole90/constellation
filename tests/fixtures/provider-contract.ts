import { describe, expect, it } from "vite-plus/test";

import { ApprovalWitness, fingerprintOf } from "~/domain/approval";
import {
  newChangeRecord,
  transition,
  type ChangeContent,
  type FieldKey,
  type LmsError,
  type RemoteState,
} from "~/domain/change";
import type { ChangeId, IsoTime, SchoolId } from "~/domain/ids";
import { mintSendPermit, type SendPermit } from "~/domain/permit";
import type { LmsProvider } from "~/providers/provider";

const AT = "2026-10-30T12:00:00.000Z" as IsoTime;

export interface ContractHarness {
  provider: LmsProvider;
  school: SchoolId;
  /** A grade with a comment and no attachment. */
  content: ChangeContent;
  failNext(field: "grade" | "comment", error: LmsError): void;
  loseNext(): void;
  throttleNext(ms: number): void;
  expire(): void;
  /** Requests that reached the LMS as writes. */
  writeCount(): number;
}

const COURSE_KEYS = new Set([
  "ref",
  "school",
  "code",
  "title",
  "section",
  "modality",
  "studentCount",
]);
const ASSIGNMENT_KEYS = new Set([
  "ref",
  "school",
  "course",
  "title",
  "shortTitle",
  "dueAt",
  "pointsPossible",
  "rubric",
  "latePointsPerDay",
]);
const SUBMISSION_KEYS = new Set([
  "ref",
  "school",
  "course",
  "assignment",
  "student",
  "studentName",
  "workflow",
  "attempt",
  "lateDays",
  "submittedAt",
  "grade",
  "rubricScores",
  "comments",
  "body",
]);

const expectOnlyKeys = (value: object, allowed: ReadonlySet<string>) =>
  expect(Object.keys(value).filter((key) => !allowed.has(key))).toEqual([]);

export const unwrap = async <T>(
  read: Promise<{ ok: true; value: T } | { ok: false; error: LmsError }>,
): Promise<T> => {
  const result = await read;
  if (!result.ok) throw new Error(`read failed: ${result.error.kind}`);
  return result.value;
};

/** A real permit for a test: the change is observed, approved with a trusted click, and begun, the way the runner would. */
export const permitFor = async (
  provider: LmsProvider,
  content: ChangeContent,
  fields: readonly FieldKey[],
  school: SchoolId,
): Promise<SendPermit> => {
  const remote = await unwrap(provider.observe(content));
  const draft = newChangeRecord({
    id: "ch-contract" as ChangeId,
    school,
    course: "c" as never,
    subject: "contract",
    content,
    basis: { readAt: AT, remote },
    at: AT,
    by: "you",
  });
  const witness = ApprovalWitness.fromClick({ isTrusted: true, type: "click" }, [
    { changeId: draft.id, fingerprint: fingerprintOf(draft) },
  ]);
  if (!witness) throw new Error("no witness");
  const approved = transition(draft, { type: "approve", witness, at: AT });
  if (!approved.ok) throw new Error(approved.error);
  const begun = transition(approved.value, { type: "begin-send", seen: {}, at: AT });
  if (!begun.ok) throw new Error(begun.error);
  const permit = mintSendPermit(begun.value, fields);
  if (!permit) throw new Error("no permit");
  return permit;
};

const gradeOf = (remote: RemoteState) => {
  if (remote.kind !== "grade") throw new Error("expected a grade");
  return remote;
};

/** Every provider, real or fake, passes this before the runner can trust it. */
export const runProviderContract = (
  name: string,
  makeHarness: () => Promise<ContractHarness>,
): void => {
  describe(`provider contract: ${name}`, () => {
    it("reads return domain types with no vendor fields", async () => {
      const { provider } = await makeHarness();
      const courses = await unwrap(provider.courses());
      expect(courses.length).toBeGreaterThan(0);
      for (const course of courses) {
        expectOnlyKeys(course, COURSE_KEYS);
        for (const assignment of await unwrap(provider.assignments(course.ref)))
          expectOnlyKeys(assignment, ASSIGNMENT_KEYS);
        for (const submission of await unwrap(provider.submissions(course.ref)))
          expectOnlyKeys(submission, SUBMISSION_KEYS);
      }
    });

    it("a provider without messaging returns no conversations", async () => {
      const { provider } = await makeHarness();
      const conversations = await unwrap(provider.conversations());
      if (!provider.capabilities.messaging) expect(conversations).toEqual([]);
    });

    it("observe is read-only and repeatable", async () => {
      const { provider, content, writeCount } = await makeHarness();
      const before = writeCount();
      const first = await unwrap(provider.observe(content));
      const second = await unwrap(provider.observe(content));
      expect(second).toEqual(first);
      expect(writeCount()).toBe(before);
    });

    it("apply refuses a plain object or a JSON copy of a permit and writes nothing", async () => {
      const { provider, content, school, writeCount } = await makeHarness();
      const genuine = await permitFor(provider, content, ["grade", "comment"], school);
      const forgeries = [
        { changeId: "ch-contract", content, fields: ["grade", "comment"] },
        JSON.parse(JSON.stringify(genuine)),
      ] as unknown as SendPermit[];
      const before = await unwrap(provider.observe(content));
      const writes = writeCount();
      for (const forged of forgeries) expect(await provider.apply(forged)).toEqual({});
      expect(writeCount()).toBe(writes);
      expect(await unwrap(provider.observe(content))).toEqual(before);
    });

    it("apply writes exactly the permitted fields", async () => {
      const { provider, content, school } = await makeHarness();
      const before = gradeOf(await unwrap(provider.observe(content)));
      const outcomes = await provider.apply(
        await permitFor(provider, content, ["comment"], school),
      );
      expect(Object.keys(outcomes)).toEqual(["comment"]);
      expect(outcomes.comment?.status).toBe("landed");
      const after = gradeOf(await unwrap(provider.observe(content)));
      expect(after.grade).toBe(before.grade);
      expect(after.comments.at(-1)?.text).toBe(content.kind === "grade" ? content.comment : "");
    });

    it("a failed field reports per field and does not land, while an earlier field does", async () => {
      const { provider, content, school, failNext } = await makeHarness();
      failNext("comment", { kind: "unavailable", status: 500 });
      const before = gradeOf(await unwrap(provider.observe(content)));
      const outcomes = await provider.apply(
        await permitFor(provider, content, ["grade", "comment"], school),
      );
      expect(outcomes.grade?.status).toBe("landed");
      expect(outcomes.comment?.status).toBe("failed");
      const after = gradeOf(await unwrap(provider.observe(content)));
      expect(after.grade).not.toBe(before.grade);
      expect(after.comments).toEqual(before.comments);
    });

    it("observe reflects a write whose response was lost", async () => {
      const { provider, content, school, loseNext } = await makeHarness();
      const permit = await permitFor(provider, content, ["comment"], school);
      loseNext();
      const outcomes = await provider.apply(permit);
      expect(outcomes.comment?.status).toBe("unknown");
      expect(gradeOf(await unwrap(provider.observe(content))).comments.at(-1)?.text).toBe(
        content.kind === "grade" ? content.comment : "",
      );
    });

    it("a 429 comes back as a field failure carrying retryAfterMs, without sleeping or throwing", async () => {
      const { provider, content, school, throttleNext } = await makeHarness();
      const permit = await permitFor(provider, content, ["grade"], school);
      throttleNext(1500);
      const outcomes = await provider.apply(permit);
      expect(outcomes.grade).toEqual({
        status: "failed",
        error: { kind: "rate_limited", retryAfterMs: 1500 },
      });
    });

    it("an expired token reads as auth_expired on reads and writes", async () => {
      const { provider, content, school, expire } = await makeHarness();
      const permit = await permitFor(provider, content, ["grade"], school);
      expire();
      expect(await provider.observe(content)).toEqual({
        ok: false,
        error: { kind: "auth_expired" },
      });
      expect((await provider.apply(permit)).grade).toEqual({
        status: "failed",
        error: { kind: "auth_expired" },
      });
    });

    it("an LMS that takes an excuse reports it on observe, with no grade left", async () => {
      const { provider, content, school } = await makeHarness();
      if (!provider.capabilities.excuse || content.kind !== "grade") return;
      const excused = { ...content, points: null, rubric: null, excused: true };
      const outcomes = await provider.apply(await permitFor(provider, excused, ["excuse"], school));
      expect(outcomes.excuse?.status).toBe("landed");
      expect(gradeOf(await unwrap(provider.observe(excused)))).toMatchObject({
        excused: true,
        grade: null,
      });
    });

    it("says whether a new comment adds to earlier feedback or replaces it", async () => {
      const { provider } = await makeHarness();
      expect(["append", "replace"]).toContain(provider.capabilities.commentEffect);
    });
  });
};
