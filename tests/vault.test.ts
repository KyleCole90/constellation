import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createBridgeVault } from "~/renderer/providers/vault";
import type { SchoolId } from "~/shared/domain/ids";
import { handle, invoker } from "~/shared/ipc";
import { Secret, revealSecret, type Credential } from "~/shared/providers/provider";

import { createVault, type Cipher } from "../src/main/vault";
import { fakeLmsHandlers } from "./fixtures/bridge";
import { makeStoreRig } from "./fixtures/store-rig";

const LCC = "lcc" as SchoolId;
const RSU = "rsu" as SchoolId;
const TOKEN = "SENTINEL-vault-token-4d1e9b7c";
const APP = "app://constellation/";

/** Stands in for `safeStorage`: reversible, and its ciphertext never contains the plaintext. */
const fakeCipher = (available = true): Cipher => {
  const flip = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (plain) => flip(Buffer.from(plain, "utf8")),
    decryptStringAsync: async (sealed) => ({ result: flip(sealed).toString("utf8") }),
  };
};

const dirs: string[] = [];
const vaultFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-test-"));
  dirs.push(dir);
  return join(dir, "vault.json");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const stored = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

describe("main's vault", () => {
  it("stores a token only encrypted, and lists its key", async () => {
    const file = vaultFile();
    const vault = createVault(file, fakeCipher());
    await vault.enroll(LCC, TOKEN);
    expect(vault.keys()).toEqual([LCC]);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
  });

  it("refuses to store a token when encryption isn't available, and writes nothing", async () => {
    const file = vaultFile();
    const vault = createVault(file, fakeCipher(false));
    await expect(vault.enroll(LCC, TOKEN)).rejects.toThrow("can't encrypt");
    expect(() => readFileSync(file)).toThrow();
    expect(vault.keys()).toEqual([]);
  });

  it("hands out a stand-in that is stable and gives the token away nowhere", async () => {
    const vault = createVault(vaultFile(), fakeCipher());
    await vault.enroll(LCC, TOKEN);
    const standIn = await vault.standIn(LCC);
    expect(standIn).toMatch(/^stand-in:[0-9a-f]{64}$/);
    expect(standIn).not.toContain(TOKEN);
    expect(await vault.standIn(LCC)).toBe(standIn);
    expect(await vault.standIn(RSU)).toBeNull();
  });

  it("forgetting a key deletes its entry from the file and leaves the others", async () => {
    const file = vaultFile();
    const vault = createVault(file, fakeCipher());
    await vault.enroll(LCC, TOKEN);
    await vault.enroll(RSU, "another-token");
    vault.forget(LCC);
    expect(Object.keys(Object(stored(file)))).toEqual([RSU]);
    expect(await vault.standIn(LCC)).toBeNull();
  });

  it("enrolling a stand-in it handed out puts back the token it stands for", async () => {
    const file = vaultFile();
    const vault = createVault(file, fakeCipher());
    await vault.enroll(LCC, TOKEN);
    const previous = await vault.standIn(LCC);
    if (previous === null) throw new Error("no stand-in");
    await vault.enroll(LCC, "a-replacement-token");
    await vault.enroll(LCC, previous);
    expect(await vault.standIn(LCC)).toBe(previous);
    expect(readFileSync(file, "utf8")).not.toContain(previous);
  });

  it("restores a stand-in only under the key it was issued for", async () => {
    const vault = createVault(vaultFile(), fakeCipher());
    await vault.enroll(LCC, TOKEN);
    await vault.enroll(RSU, "rsu-token");
    const lccStandIn = await vault.standIn(LCC);
    const rsuStandIn = await vault.standIn(RSU);
    if (lccStandIn === null) throw new Error("no stand-in");
    await expect(vault.enroll(RSU, lccStandIn)).rejects.toThrow("issued for");
    expect(await vault.standIn(RSU)).toBe(rsuStandIn);
    await expect(vault.enroll("ai-key", lccStandIn)).rejects.toThrow("issued for");
    expect(vault.keys()).toEqual([LCC, RSU]);
  });

  it("forgetting a key voids the stand-ins it handed out", async () => {
    const file = vaultFile();
    const vault = createVault(file, fakeCipher());
    await vault.enroll(LCC, TOKEN);
    const previous = await vault.standIn(LCC);
    if (previous === null) throw new Error("no stand-in");
    vault.forget(LCC);
    await expect(vault.enroll(LCC, previous)).rejects.toThrow("issued for");
    expect(vault.keys()).toEqual([]);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
  });

  it.each([
    ["that something else wrote", JSON.stringify({ lcc: 7 })],
    ["that is damaged", '{"lcc": "abc'],
  ])("reads a file %s as empty, and keeps it aside as vault.json.bad", async (_, text) => {
    const file = vaultFile();
    writeFileSync(file, text);
    const vault = createVault(file, fakeCipher());
    expect(vault.keys()).toEqual([]);
    expect(readFileSync(`${file}.bad`, "utf8")).toBe(text);
    expect(await vault.standIn(LCC)).toBeNull();
    vault.forget(LCC);
    await vault.enroll(LCC, TOKEN);
    expect(vault.keys()).toEqual([LCC]);
  });

  it("replaces a temp file left by a crash rather than writing through it", async () => {
    const file = vaultFile();
    writeFileSync(`${file}.tmp`, "stale", { mode: 0o644 });
    const vault = createVault(file, fakeCipher());
    await vault.enroll(LCC, TOKEN);
    expect(vault.keys()).toEqual([LCC]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

/** The renderer's vault, over the real IPC map, into main's vault on a temp file. */
const bridged = () => {
  const file = vaultFile();
  const main = createVault(file, fakeCipher());
  const listeners = new Map<string, (sender: string | null, input: unknown) => Promise<unknown>>();
  handle(
    (channel, listener) => listeners.set(channel, listener),
    (sender) => sender === APP,
    {
      "error.report": async () => {},
      "vault.enroll": ({ key, token }) => main.enroll(key, token),
      "vault.keys": async () => main.keys(),
      "vault.forget": async ({ key }) => main.forget(key),
      "vault.standIn": ({ key }) => main.standIn(key),
      ...fakeLmsHandlers(),
    },
  );
  const invoke = invoker(async (channel, input) => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`no listener for ${channel}`);
    // Through structured clone, as Electron's IPC does, so nothing but plain data crosses.
    return structuredClone(await listener(APP, structuredClone(input)));
  });
  return { file, vault: createBridgeVault({ invoke }) };
};

const tokenOf = (credential: Credential | null) =>
  credential?.kind === "bearer" ? revealSecret(credential.token, (raw) => raw) : null;

describe("the desktop renderer's vault", () => {
  it("enrolls, checks and forgets through main", async () => {
    const { file, vault } = bridged();
    await vault.enroll(LCC, { kind: "bearer", token: new Secret(TOKEN) });
    expect(await vault.has(LCC)).toBe(true);
    expect(await vault.keys()).toEqual([LCC]);
    await vault.forget(LCC);
    expect(await vault.has(LCC)).toBe(false);
    expect(stored(file)).toEqual({});
  });

  it("never gets the token back, only its stand-in", async () => {
    const { vault } = bridged();
    await vault.enroll(LCC, { kind: "bearer", token: new Secret(TOKEN) });
    const read = await vault.leaseFor(LCC).use(async (credential) => tokenOf(credential));
    expect(read).toMatch(/^stand-in:/);
    expect(read).not.toContain(TOKEN);
  });

  it("refuses an OAuth credential rather than drop part of it", async () => {
    const { vault } = bridged();
    const oauth: Credential = {
      kind: "oauth2",
      access: new Secret(TOKEN),
      refresh: null,
      expiresAt: new Date(0).toISOString() as Extract<Credential, { kind: "oauth2" }>["expiresAt"],
      scopes: [],
    };
    await expect(vault.enroll(LCC, oauth)).rejects.toThrow("personal access tokens only");
    expect(await vault.keys()).toEqual([]);
  });

  it("forgets everything", async () => {
    const { file, vault } = bridged();
    await vault.enroll(LCC, { kind: "bearer", token: new Secret(TOKEN) });
    await vault.enroll("ai-key", { kind: "bearer", token: new Secret("an-ai-key") });
    await vault.forgetAll();
    expect(stored(file)).toEqual({});
  });
});

describe("the workspace over the desktop vault", () => {
  it("connects, keeps the old token when a replacement can't be checked, and removes a school's entry", async () => {
    const { file, vault } = bridged();
    const rig = await makeStoreRig({ vault });
    expect((await rig.connect(LCC, TOKEN)).ok).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
    const before = await vault.leaseFor(LCC).use(async (credential) => tokenOf(credential));

    rig.server.setNoise({ rate5xx: 1 });
    expect((await rig.connect(LCC, "a-replacement-that-cant-be-checked")).ok).toBe(false);
    rig.server.setNoise({ rate5xx: 0 });
    expect(await vault.leaseFor(LCC).use(async (credential) => tokenOf(credential))).toBe(before);
    expect(await rig.clock.run(rig.state().syncSchool(LCC))).toBe(true);
    expect(rig.state().connections[LCC]?.status).toBe("connected");

    await rig.clock.run(rig.state().disconnect(LCC));
    expect(await rig.clock.run(rig.state().removeSchool(LCC))).toBe(true);
    expect(stored(file)).toEqual({});
  });
});
