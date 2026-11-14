import { describe, expect, it } from "vite-plus/test";

import {
  parseSchoolHost,
  type ChangeId,
  type SchoolHost,
  type SchoolId,
  type ThreadId,
} from "~/shared/domain/ids";
import { Secret } from "~/shared/providers/provider";
import { createMemoryVault } from "~/renderer/providers/vault";
import { WORKSPACE_STORAGE_KEY } from "~/renderer/stores/workspace";

import { STORE_TOKEN, makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const LCC = "lcc" as SchoolId;
const RSU = "rsu" as SchoolId;
const LCC_HOST = "lakeshore.instructure.com" as SchoolHost;
const SENTINEL = "SENTINEL-onboarding-token-4c1d9e";

const add = (rig: StoreRig, host: string, token = STORE_TOKEN) =>
  rig.clock.run(rig.state().addSchool(host as SchoolHost, new Secret(token)));

const expectNoTrace = async (rig: StoreRig, school: SchoolId) => {
  expect(rig.state().schools.map((entry) => entry.id)).not.toContain(school);
  expect(rig.state().connections[school]).toBeUndefined();
  expect(rig.state().cache[school]).toBeUndefined();
  expect(await rig.vault.keys()).not.toContain(school);
};

describe("parseSchoolHost", () => {
  it.each([
    ["lakeshore.instructure.com", "lakeshore.instructure.com"],
    ["  Lakeshore.Instructure.com  ", "lakeshore.instructure.com"],
    ["https://lakeshore.instructure.com/courses/12?x=1", "lakeshore.instructure.com"],
    ["http://canvas.school.edu/", "canvas.school.edu"],
    ["canvas.school.edu.", "canvas.school.edu"],
  ])("reads %j as %j", (raw, host) => {
    expect(parseSchoolHost(raw)).toEqual({ ok: true, value: host });
  });

  it.each([
    "",
    "   ",
    "lakeshore",
    "https://",
    "not an address.edu",
    "demo-00000000-0000-4000-8000-000000000000",
  ])("refuses %j without repeating it", (raw) => {
    const result = parseSchoolHost(raw);
    expect(result.ok).toBe(false);
    if (!result.ok && raw.trim() !== "") expect(result.error).not.toContain(raw.trim());
  });
});

describe("a new workspace", () => {
  it("knows no school until one is added, and offers the seeded hosts as a demo", async () => {
    const rig = await makeStoreRig();
    expect(rig.state().schools).toEqual([]);
    expect(rig.state().connections).toEqual({});
    expect(rig.state().demoHosts()).toEqual([
      "lakeshore.instructure.com",
      "riverbend.instructure.com",
    ]);
    const enrollment = rig.state().newSchoolEnrollment();
    expect(enrollment?.kind === "paste-token" && enrollment.tokenPageUrl(LCC_HOST)).toBe(
      "https://lakeshore.instructure.com/profile/settings",
    );
  });
});

describe("addSchool", () => {
  it("adds the school at that address, connected and synced", async () => {
    const rig = await makeStoreRig();
    const stages: string[] = [];
    const result = await rig.clock.run(
      rig.state().addSchool(LCC_HOST, new Secret(STORE_TOKEN), (stage) => stages.push(stage)),
    );
    expect(result).toMatchObject({ ok: true, value: { id: LCC, host: LCC_HOST } });
    expect(stages).toEqual(["saving", "checking", "reading"]);
    expect(rig.state().schools.map((school) => school.id)).toEqual([LCC]);
    expect(rig.state().connections[LCC]?.status).toBe("connected");
    expect(rig.state().cache[LCC]?.courses.length).toBeGreaterThan(0);
  });

  it("names each course as its first read finishes, then drops the progress once the read lands", async () => {
    const rig = await makeStoreRig();
    const seen = ["none"];
    const stop = rig.store.subscribe((state) => {
      const progress = state.courseReads[LCC];
      const step = progress ? `${progress.read.length}/${progress.courses.length}` : "none";
      if (seen.at(-1) !== step) seen.push(step);
    });
    await add(rig, LCC_HOST);
    stop();
    const courses = rig.state().cache[LCC]?.courses.length ?? 0;
    expect(courses).toBeGreaterThan(1);
    expect(seen).toEqual([
      "none",
      ...Array.from({ length: courses + 1 }, (_, read) => `${read}/${courses}`),
      "none",
    ]);
  });

  it("refuses an address with no school and leaves nothing behind", async () => {
    const rig = await makeStoreRig();
    const result = await add(rig, "nowhere.example.edu", SENTINEL);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("nowhere.example.edu") as string,
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(rig.state().schools).toEqual([]);
    expect(await rig.vault.keys()).toEqual([]);
  });

  it("refuses a too short token without echoing it, and leaves nothing behind", async () => {
    const rig = await makeStoreRig();
    const result = await add(rig, LCC_HOST, "SENTINEL-short");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SENTINEL-short");
    await expectNoTrace(rig, LCC);
  });

  it("a token the LMS refuses leaves nothing behind", async () => {
    const rig = await makeStoreRig();
    await add(rig, LCC_HOST);
    await rig.clock.run(rig.state().removeSchool(LCC));
    rig.server.expireToken(LCC);
    const result = await add(rig, LCC_HOST);
    expect(result).toEqual({
      ok: false,
      error: "That token was refused. Generate a new one and try again.",
    });
    await expectNoTrace(rig, LCC);
  });

  it("an LMS that can't be reached leaves nothing behind", async () => {
    const rig = await makeStoreRig();
    rig.server.setNoise({ rate5xx: 1 });
    expect((await add(rig, LCC_HOST)).ok).toBe(false);
    await expectNoTrace(rig, LCC);
  });

  it("adding an address twice reconnects the one school", async () => {
    const rig = await makeStoreRig();
    await add(rig, LCC_HOST);
    const again = await add(rig, LCC_HOST);
    expect(again.ok).toBe(true);
    expect(rig.state().schools.map((school) => school.id)).toEqual([LCC]);
    expect(rig.state().connections[LCC]?.status).toBe("connected");
  });

  it("a reload while an add was checking forgets the token nothing vouched for", async () => {
    const rig = await makeStoreRig();
    await rig.vault.enroll(LCC, { kind: "bearer", token: new Secret(STORE_TOKEN) });
    await rig.clock.run(rig.state().boot());
    expect(await rig.vault.keys()).toEqual([]);
  });
});

describe("removeSchool", () => {
  it("drops the school, its connection, its cache, and its token, and keeps the others", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    await rig.clock.run(rig.state().removeSchool(LCC));
    await expectNoTrace(rig, LCC);
    expect(rig.state().schools.map((school) => school.id)).toEqual([RSU]);
    expect(rig.state().connections[RSU]?.status).toBe("connected");
    expect(await rig.vault.has(RSU)).toBe(true);
  });

  it("refuses a school that has a saved change, so no draft is left pointing at a school that is gone", async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    const ref = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    if (!ref) throw new Error("No submission.");
    const id = (await rig.clock.run(
      rig.state().openSubmission("t-queue" as ThreadId, ref, { fill: "draft" }),
    )) as ChangeId;
    const school = rig.state().changes[id]?.school;
    if (!school) throw new Error("Opening the submission saved no change.");
    expect(await rig.clock.run(rig.state().removeSchool(school))).toBe(false);
    expect(rig.state().schools.map((entry) => entry.id)).toContain(school);
    expect(await rig.vault.has(school)).toBe(true);
  });
});

describe("the AI source", () => {
  it("turns AI on for a key or the on-device model, and off for none", async () => {
    const rig = await makeStoreRig({ noKey: true });
    expect(rig.state().aiOn()).toBe(false);
    await rig.state().addAiKey(new Secret(STORE_TOKEN));
    expect([rig.state().aiSource, rig.state().aiOn()]).toEqual(["key", true]);
    await rig.state().chooseOnDeviceModel();
    expect([rig.state().aiSource, rig.state().aiOn()]).toEqual(["on-device", true]);
    expect(await rig.vault.has("ai-key")).toBe(false);
    await rig.state().turnOffAi();
    expect([rig.state().aiSource, rig.state().aiOn()]).toEqual(["none", false]);
  });

  it("a reload with the key gone from the vault turns AI off, and the on-device model survives a reload", async () => {
    const first = await makeStoreRig({ noKey: true });
    await first.state().addAiKey(new Secret(STORE_TOKEN));
    const emptied = await makeStoreRig({
      noKey: true,
      storage: first.storage,
      vault: createMemoryVault(),
      clock: first.clock,
    });
    await emptied.clock.run(emptied.state().boot());
    expect(emptied.state().aiSource).toBe("none");

    await first.state().chooseOnDeviceModel();
    const reloaded = await makeStoreRig({
      noKey: true,
      storage: first.storage,
      vault: first.vault,
      clock: first.clock,
    });
    await reloaded.clock.run(reloaded.state().boot());
    expect(reloaded.state().aiSource).toBe("on-device");
  });
});

describe("a workspace saved by version 2", () => {
  /** What version 2 wrote: the same state with the key status and a per-school step. */
  const asVersion2 = (
    rig: StoreRig,
    patch: { onboarding: string; aiKeyStatus: "none" | "saved" },
  ): string => {
    const stored = JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as {
      version: number;
      state: Record<string, unknown>;
    };
    const { aiSource: _aiSource, ...state } = stored.state;
    return JSON.stringify({ version: 2, state: { ...state, ...patch } });
  };

  const savedRig = async () => {
    const rig = await makeStoreRig();
    await rig.connectAll();
    await rig.state().addAiKey(new Secret(STORE_TOKEN));
    const ref = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    if (!ref) throw new Error("No submission.");
    const id = await rig.clock.run(
      rig.state().openSubmission("t-queue" as ThreadId, ref, { fill: "draft" }),
    );
    return { rig, id: id as ChangeId };
  };

  it("keeps every school, connection, change, and thread, and a finished run stays finished", async () => {
    const { rig, id } = await savedRig();
    const before = rig.state();
    rig.storage.setItem(
      WORKSPACE_STORAGE_KEY,
      asVersion2(rig, { onboarding: "done", aiKeyStatus: "saved" }),
    );
    const next = await makeStoreRig({ storage: rig.storage, vault: rig.vault, clock: rig.clock });
    await next.clock.run(next.state().boot());
    expect(next.state().notice).toBeNull();
    expect(next.state().schools).toEqual(before.schools);
    expect(next.state().connections[LCC]?.status).toBe("connected");
    expect(next.state().connections[RSU]?.status).toBe("connected");
    expect(next.state().changes[id]).toEqual(before.changes[id]);
    expect(Object.keys(next.state().threads).sort()).toEqual(Object.keys(before.threads).sort());
    expect(next.state().onboarding).toBe("done");
    expect(next.state().aiSource).toBe("key");
    expect(JSON.parse(next.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}").version).toBe(3);
  });

  it.each([
    ["school:rsu", "none", "setup", "none"],
    ["ai-key", "none", "setup", "none"],
    ["ready", "saved", "setup", "key"],
    ["welcome", "none", "welcome", "none"],
  ] as const)(
    "a run stopped at %s with key %s resumes at %s with AI %s",
    async (step, key, onboarding, aiSource) => {
      const { rig } = await savedRig();
      rig.storage.setItem(
        WORKSPACE_STORAGE_KEY,
        asVersion2(rig, { onboarding: step, aiKeyStatus: key }),
      );
      const next = await makeStoreRig({ storage: rig.storage, vault: rig.vault, clock: rig.clock });
      expect(next.state().onboarding).toBe(onboarding);
      expect(next.state().aiSource).toBe(aiSource);
      expect(next.state().schools).toHaveLength(2);
    },
  );
});
