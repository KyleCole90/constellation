import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";

import { isoTime, parseSchoolHost } from "~/shared/domain/ids";
import { VaultKeySchema } from "~/shared/ipc";
import { refs } from "~/shared/providers/canvas-refs";
import { FAKE_SCHOOLS } from "~/shared/providers/fake-canvas/provider";
import {
  FieldOutcomesSchema,
  IsoTimeSchema,
  SchoolIdSchema,
  SchoolSchema,
  lmsRef,
} from "~/shared/providers/schemas";

const school = FAKE_SCHOOLS[0];
const hostOf = (raw: string) => {
  const parsed = parseSchoolHost(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe("brand schemas accept what the mint makes and reject a near miss", () => {
  it("IsoTime", () => {
    expect(v.is(IsoTimeSchema, isoTime("2026-03-07T10:00:00Z"))).toBe(true);
    expect(v.is(IsoTimeSchema, "2026-03-07T10:00:00+05:00")).toBe(false);
    expect(v.is(IsoTimeSchema, "March 7, 2026")).toBe(false);
  });

  it("SchoolId", () => {
    expect(v.is(SchoolIdSchema, school?.id)).toBe(true);
    expect(v.is(SchoolIdSchema, "")).toBe(false);
    expect(v.is(SchoolIdSchema, "lcc:course")).toBe(false);
  });

  it("SchoolHost", () => {
    expect(v.is(SchoolSchema, school)).toBe(true);
    expect(v.is(SchoolSchema, { ...school, host: hostOf("https://Lakeshore.edu/") })).toBe(true);
    expect(v.is(SchoolSchema, { ...school, host: "https://Lakeshore.edu/" })).toBe(false);
    expect(v.is(SchoolSchema, { ...school, host: "lakeshore" })).toBe(false);
  });

  it("LmsRef of one kind", () => {
    const course = refs.course("lcc", 48213);
    expect(v.is(lmsRef("course"), course)).toBe(true);
    expect(v.is(lmsRef("submission"), course)).toBe(false);
    expect(v.is(lmsRef("course"), "lcc:course")).toBe(false);
    expect(v.is(lmsRef("course"), ":course:48213")).toBe(false);
  });

  it("VaultKey", () => {
    expect(v.is(VaultKeySchema, "ai-key")).toBe(true);
    expect(v.is(VaultKeySchema, school?.id)).toBe(true);
    expect(v.is(VaultKeySchema, "")).toBe(false);
    expect(v.is(VaultKeySchema, "lcc:course")).toBe(false);
  });

  it("FieldOutcomes", () => {
    const at = isoTime(0);
    expect(v.is(FieldOutcomesSchema, { grade: { status: "landed", at, via: "response" } })).toBe(
      true,
    );
    expect(v.is(FieldOutcomesSchema, { grade: { status: "pending" } })).toBe(false);
    expect(v.is(FieldOutcomesSchema, { nope: { status: "unknown", since: at } })).toBe(false);
  });
});
