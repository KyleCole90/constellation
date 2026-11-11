import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

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

/** One-way, so a stand-in tells the fake LMS which token it is without giving the token away. */
const standInFor = (token: string) =>
  `stand-in:${createHash("sha256").update(token).digest("hex")}`;

const isMissing = (error: unknown) =>
  error instanceof Error && Reflect.get(error, "code") === "ENOENT";

/**
 * Tokens, encrypted with `safeStorage`, in one file under `userData` (docs/electron-spec.md, step 6).
 * The renderer can enroll, list and forget a token, and get its stand-in, but never read it back.
 * Every read and write of the file runs without an await between them, so two calls can't interleave.
 */
export const createVault = (file: string, cipher: Cipher) => {
  const read = (): Entries => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
    const data: unknown = JSON.parse(text);
    return v.parse(Entries, data);
  };
  const write = (entries: Entries) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(entries), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  /**
   * The token behind each stand-in handed out this session. Replacing a token reads the old one's stand-in first,
   * and puts it back if the new token is refused, so enrolling a stand-in restores the token it stands for.
   */
  const issued = new Map<string, string>();

  return {
    enroll: async (key: VaultKey, token: string) => {
      if (!(await cipher.isAsyncEncryptionAvailable()))
        throw new Error("This Mac can't encrypt the token, so it wasn't saved.");
      const sealed = await cipher.encryptStringAsync(issued.get(token) ?? token);
      write({ ...read(), [key]: sealed.toString("base64") });
    },
    keys: (): VaultKey[] => Object.keys(read()).filter((key) => v.is(VaultKeySchema, key)),
    forget: (key: VaultKey) => {
      const { [key]: _forgotten, ...rest } = read();
      write(rest);
    },
    standIn: async (key: VaultKey): Promise<string | null> => {
      const sealed = read()[key];
      if (sealed === undefined) return null;
      const { result: token } = await cipher.decryptStringAsync(Buffer.from(sealed, "base64"));
      const standIn = standInFor(token);
      issued.set(standIn, token);
      return standIn;
    },
  };
};
