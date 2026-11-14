import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SchoolId } from "~/shared/domain/ids";
import { LMS_STORAGE_KEY } from "~/shared/providers/fake-canvas/server";
import { Secret, revealSecret } from "~/shared/providers/provider";
import { createMemoryVault } from "~/renderer/providers/vault";
import { WORKSPACE_STORAGE_KEY } from "~/renderer/stores/workspace";

import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const LCC = "lcc" as SchoolId;
const SENTINEL = "SENTINEL-do-not-leak-7f3a9c1e5b";
const SHORT_SENTINEL = "SENTINEL-short";

const logged: string[] = [];
beforeEach(() => {
  logged.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const expectNoLeak = (rig: StoreRig, sentinel: string, extra: unknown = null) => {
  expect(JSON.stringify(rig.state())).not.toContain(sentinel);
  expect(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "").not.toContain(sentinel);
  expect(rig.storage.getItem(LMS_STORAGE_KEY) ?? "").not.toContain(sentinel);
  expect(logged.join("\n")).not.toContain(sentinel);
  expect(JSON.stringify(extra)).not.toContain(sentinel);
};

describe("a token passing through connect", () => {
  it("on success stays out of state, both storage keys, and the console", async () => {
    const rig = await makeStoreRig();
    const result = await rig.connect(LCC, SENTINEL);
    expect(result.ok).toBe(true);
    expect(rig.state().connections[LCC]?.status).toBe("connected");
    expect(rig.storage.getItem(WORKSPACE_STORAGE_KEY)).not.toBeNull();
    expect(rig.storage.getItem(LMS_STORAGE_KEY)).not.toBeNull();
    expectNoLeak(rig, SENTINEL, result);
  });

  it("when too short is refused, without echoing it in the message", async () => {
    const rig = await makeStoreRig();
    const result = await rig.connect(LCC, SHORT_SENTINEL);
    expect(result.ok).toBe(false);
    expect(rig.state().schools).toEqual([]);
    expect(await rig.vault.has(LCC)).toBe(false);
    expectNoLeak(rig, SHORT_SENTINEL, result);
  });

  it("when revoked by the LMS is refused, forgotten, and not echoed", async () => {
    const rig = await makeStoreRig();
    await rig.connect(LCC, SENTINEL);
    rig.server.expireToken(LCC);
    const result = await rig.connect(LCC, SENTINEL);
    expect(result.ok).toBe(false);
    expect(await rig.vault.has(LCC)).toBe(false);
    expectNoLeak(rig, SENTINEL, result);
  });

  it("when the LMS is down is refused, forgotten, and not echoed", async () => {
    const rig = await makeStoreRig();
    rig.server.setNoise({ rate5xx: 1 });
    const result = await rig.connect(LCC, SENTINEL);
    expect(result.ok).toBe(false);
    expect(await rig.vault.has(LCC)).toBe(false);
    expectNoLeak(rig, SENTINEL, result);
  });

  it("when the vault fails reports it without echoing the token", async () => {
    const vault = createMemoryVault();
    vault.enroll = async () => {
      throw new Error("Secure storage needs HTTPS or localhost.");
    };
    const rig = await makeStoreRig({ vault });
    const result = await rig.connect(LCC, SENTINEL);
    expect(result).toEqual({
      ok: false,
      error: { message: "Secure storage needs HTTPS or localhost.", wrongSecret: false },
    });
    expectNoLeak(rig, SENTINEL, result);
  });

  it("on a whole send still never appears", async () => {
    const rig = await makeStoreRig();
    await rig.connect(LCC, SENTINEL);
    const ref = rig.state().cache[LCC]?.submissions.find((s) => s.workflow === "submitted")?.ref;
    if (!ref) throw new Error("Nothing to grade.");
    await rig.clock.run(rig.state().openSubmission("t-queue" as never, ref, { fill: "draft" }));
    expectNoLeak(rig, SENTINEL);
  });
});

describe("the AI key", () => {
  it("is held by the vault and appears only as its source", async () => {
    const rig = await makeStoreRig();
    await rig.state().addAiKey(new Secret(SENTINEL));
    expect(rig.state().aiSource).toBe("key");
    expect(await rig.vault.has("ai-key")).toBe(true);
    expectNoLeak(rig, SENTINEL);
  });
});

describe("a Secret", () => {
  const secret = new Secret(SENTINEL);

  it("does not print through JSON, template strings, or object inspection", () => {
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret]"}');
    expect(`${secret}`).toBe("[secret]");
    expect(Object.values(secret).join()).not.toContain(SENTINEL);
    expect(JSON.stringify(structuredClone({ value: String(secret) }))).not.toContain(SENTINEL);
  });

  it("gives up its value only inside revealSecret", () => {
    expect(revealSecret(secret, (raw) => raw)).toBe(SENTINEL);
  });
});

describe("the fake LMS", () => {
  it("keeps a hash of an accepted token, and the hash is not the token", async () => {
    const rig = await makeStoreRig();
    await rig.connect(LCC, SENTINEL);
    const stored = JSON.parse(rig.storage.getItem(LMS_STORAGE_KEY) ?? "{}") as {
      tokens: Record<string, { accepted: string[] }>;
    };
    const accepted = stored.tokens["lcc"]?.accepted ?? [];
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).not.toBe(SENTINEL);
  });
});

describe("the memory vault", () => {
  it("hands a credential only to a lease", async () => {
    const vault = createMemoryVault();
    await vault.enroll(LCC, { kind: "bearer", token: new Secret(SENTINEL) });
    expect(Object.keys(vault).sort()).toEqual([
      "enroll",
      "forget",
      "forgetAll",
      "has",
      "keys",
      "leaseFor",
    ]);
    const seen = await vault
      .leaseFor(LCC)
      .use(async (credential) =>
        credential?.kind === "bearer" ? revealSecret(credential.token, (raw) => raw) : null,
      );
    expect(seen).toBe(SENTINEL);
  });

  it("gives a lease nothing once forgotten", async () => {
    const vault = createMemoryVault();
    await vault.enroll(LCC, { kind: "bearer", token: new Secret(SENTINEL) });
    await vault.forget(LCC);
    expect(await vault.leaseFor(LCC).use(async (credential) => credential)).toBeNull();
  });
});
