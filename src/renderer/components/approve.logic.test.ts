import { describe, expect, it } from "vite-plus/test";

import type { CopySource } from "~/shared/domain/content";
import { newChangeRecord, type ChangeRecord, type RemoteState } from "~/shared/domain/change";
import { isoTime } from "~/shared/domain/ids";
import { termName } from "~/shared/domain/term";

import { riskPrompt } from "./approve.logic";
import { changeId, isoDate, lmsRef, schoolId } from "../../../tests/fixtures/ids";

const AT = isoTime("2026-10-30T12:00:00.000Z");
const PLAN = {
  oldTerm: {
    name: termName("Fall 2026"),
    start: isoDate("2026-08-24"),
    end: isoDate("2026-12-11"),
    days: [2, 4] as const,
  },
  newTerm: {
    name: termName("Spring 2027"),
    start: isoDate("2027-01-19"),
    end: isoDate("2027-05-07"),
    days: [2, 4] as const,
  },
  breaks: [],
};

const FALL_COURSE: CopySource = {
  kind: "course",
  ref: lmsRef<"course">("rsu:course:12190"),
  label: "HUM 150 Film & Society",
  termName: "Fall 2026",
};

const copyInto = (
  students: number,
  items: number,
  source: CopySource = FALL_COURSE,
): ChangeRecord => {
  const remote: RemoteState = {
    kind: "course-copy",
    targetVersion: `students:${students}|items:${items}`,
    students,
    items,
    migrations: [],
  };
  return newChangeRecord({
    id: changeId("ch-1"),
    school: schoolId("rsu"),
    course: lmsRef<"course">("rsu:course:12103"),
    subject: "Copy into HUM 150",
    content: {
      kind: "course-copy",
      target: lmsRef<"migrations">("rsu:migrations:12103"),
      into: { code: "HUM 150", title: "Introduction to Humanities" },
      source,
      plan: PLAN,
      shift: {
        oldStart: PLAN.oldTerm.start,
        oldEnd: PLAN.oldTerm.end,
        newStart: PLAN.newTerm.start,
        newEnd: PLAN.newTerm.end,
        substitutions: {},
      },
    },
    basis: { readAt: AT, remote },
    at: AT,
    by: "you",
  });
};

describe("riskPrompt", () => {
  it("names the student and item counts and asks for the course code", () => {
    const prompt = riskPrompt(copyInto(14, 3));
    expect(prompt).not.toBeNull();
    expect(prompt?.title).toBe("HUM 150 already has 14 students and 3 items");
    expect(prompt?.body).toContain("Type HUM 150 to confirm");
    expect(prompt?.code).toBe("HUM 150");
  });
  it("names where the content comes from, not the course being filled (#128)", () => {
    expect(riskPrompt(copyInto(0, 1))?.body).toContain(
      "The copy adds the content from HUM 150 Film & Society (Fall 2026) to HUM 150, on top of what is there now.",
    );
    const fromPackage = copyInto(0, 1, {
      kind: "cartridge",
      name: "source-export.imscc",
      kb: 120,
      hint: null,
    });
    expect(riskPrompt(fromPackage)?.body).toContain(
      "The copy adds the content from source-export.imscc to HUM 150, on top of what is there now.",
    );
  });
  it("names a source course with no term without an empty parenthesis (#136)", () => {
    const noTerm = copyInto(0, 1, { ...FALL_COURSE, label: "Music Theory", termName: "" });
    expect(riskPrompt(noTerm)?.body).toContain(
      "The copy adds the content from Music Theory to HUM 150,",
    );
  });
  it("drops the part that is zero and singularizes one", () => {
    expect(riskPrompt(copyInto(1, 0))?.title).toBe("HUM 150 already has 1 student");
    expect(riskPrompt(copyInto(0, 2))?.title).toBe("HUM 150 already has 2 items");
  });
  it("is null for an empty destination, so the plain button mints", () => {
    expect(riskPrompt(copyInto(0, 0))).toBeNull();
  });
});
