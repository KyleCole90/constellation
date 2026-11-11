import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import * as v from "valibot";

import { VaultKeySchema } from "../shared/ipc";
import type { VaultKey } from "../shared/providers/provider";

/** The part of Electron's `safeStorage` the vault uses. On macOS its key lives in the Keychain. */
export interface Cipher {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plain: string): Promise<Buffer>;
  decryptStringAsync(sealed: Buffer): Promise<{ result: string }>;
}

/** Each key's token, as base64 `safeStorage` ciphertext. */
const Entries = v.record(VaultKeySchema, v.string());
type Entries = v.InferOutput<typeof Entries>;

const STAND_IN = "stand-in:";
/** One-way, so a stand-in tells the fake LMS which token it is without giving the token away. */
const standInFor = (token: string) =>
  `${STAND_IN}${createHash("sha256").update(token).digest("hex")}`;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isMissing = (error: unknown) =>
  error instanceof Error && Reflect.get(error, "code") === "ENOENT";

/**
 * Tokens, encrypted with `safeStorage`, in one file under `userData` (docs/electron-spec.md, step 6).
 * The renderer can enroll, list and forget a token, and get its stand-in, but never read it back.
 * Every read and write of the file runs without an await between them, so two calls can't interleave.
 */
export const createVault = (file: string, cipher: Cipher) => {
  /**
   * A file this vault can't read, damaged or written by something else, reads as empty, so every school shows as
   * needing its token again. It is moved aside to `vault.json.bad` rather than deleted.
   */
  const read = (): Entries => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
    const entries = v.safeParse(Entries, parseJson(text));
    if (entries.success) return entries.output;
    renameSync(file, `${file}.bad`);
    return {};
  };
  const write = (entries: Entries) => {
    // A temp file left by a crash keeps its old mode, so it goes first and the new one is created 0600.
    rmSync(`${file}.tmp`, { force: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
    renameSync(`${file}.tmp`, file);
  };
  /**
   * For each key, the token behind each stand-in handed out for it this session. Replacing a token reads the old
   * one's stand-in first, and puts it back if the new token is refused, so enrolling a stand-in under the key it
   * came from restores that token. A stand-in redeems only under its own key, and forgetting a key voids its stand-ins.
   */
  const issued = new Map<VaultKey, Map<string, string>>();

  return {
    enroll: async (key: VaultKey, token: string) => {
      if (!(await cipher.isAsyncEncryptionAvailable()))
        throw new Error("This Mac can't encrypt the token, so it wasn't saved.");
      const restored = issued.get(key)?.get(token);
      if (restored === undefined && token.startsWith(STAND_IN))
        throw new Error("A stand-in restores only the token it was issued for.");
      const sealed = await cipher.encryptStringAsync(restored ?? token);
      write({ ...read(), [key]: sealed.toString("base64") });
    },
    keys: (): VaultKey[] => Object.keys(read()).filter((key) => v.is(VaultKeySchema, key)),
    forget: (key: VaultKey) => {
      const { [key]: _forgotten, ...rest } = read();
      write(rest);
      issued.delete(key);
    },
    standIn: async (key: VaultKey): Promise<string | null> => {
      const sealed = read()[key];
      if (sealed === undefined) return null;
      const { result: token } = await cipher.decryptStringAsync(Buffer.from(sealed, "base64"));
      const standIn = standInFor(token);
      const forKey = issued.get(key) ?? new Map<string, string>();
      issued.set(key, forKey.set(standIn, token));
      return standIn;
    },
  };
};
