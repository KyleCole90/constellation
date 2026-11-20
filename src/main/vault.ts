import { createHash } from "node:crypto";

import * as v from "valibot";

import { VaultKeySchema } from "../shared/ipc";
import { Secret, type CredentialLease, type VaultKey } from "../shared/providers/provider";

import { jsonFile } from "./json-file";

export interface Cipher {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plain: string): Promise<Buffer>;
  decryptStringAsync(sealed: Buffer): Promise<{ result: string }>;
}

const Entries = v.record(VaultKeySchema, v.string());
type Entries = v.InferOutput<typeof Entries>;

const STAND_IN = "stand-in:";
const standInFor = (token: string) =>
  `${STAND_IN}${createHash("sha256").update(token).digest("hex")}`;

export const createVault = (file: string, cipher: Cipher) => {
  const { read, write } = jsonFile<Entries>(file, Entries, {});
  const issued = new Map<VaultKey, Map<string, string>>();
  const tokenOf = async (key: VaultKey): Promise<string | null> => {
    const sealed = read()[key];
    if (sealed === undefined) return null;
    return (await cipher.decryptStringAsync(Buffer.from(sealed, "base64"))).result;
  };

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
      const saved = await tokenOf(key);
      if (saved === null) return null;
      const standIn = standInFor(saved);
      const forKey = issued.get(key) ?? new Map<string, string>();
      issued.set(key, forKey.set(standIn, saved));
      return standIn;
    },
    lease: (key: VaultKey): CredentialLease => ({
      use: async (work) => {
        const saved = await tokenOf(key);
        return work(saved === null ? null : { kind: "bearer", token: new Secret(saved) });
      },
      replace: () =>
        Promise.reject(new Error("Main's vault takes a token only over vault.enroll.")),
    }),
  };
};
