import { desktopBridge } from "~/renderer/desktop";
import { parseIsoTime } from "~/shared/domain/ids";
import type { Bridge } from "~/shared/ipc";
import {
  Secret,
  revealSecret,
  type Credential,
  type CredentialLease,
  type Vault,
  type VaultKey,
} from "~/shared/providers/provider";

const lease = (
  vault: Pick<Vault, "enroll">,
  key: VaultKey,
  read: () => Promise<Credential | null>,
): CredentialLease => ({
  use: async (work) => work(await read()),
  replace: (next) => vault.enroll(key, next),
});

export const createMemoryVault = (): Vault => {
  const entries = new Map<VaultKey, Credential>();
  const vault: Vault = {
    enroll: async (key, credential) => void entries.set(key, credential),
    has: async (key) => entries.has(key),
    keys: async () => [...entries.keys()],
    forget: async (key) => void entries.delete(key),
    forgetAll: async () => entries.clear(),
    leaseFor: (key) => lease(vault, key, async () => entries.get(key) ?? null),
  };
  return vault;
};

const DB_NAME = "lms-app-vault";
const KEYS = "keys";
const SECRETS = "secrets";
const MASTER = "master";

type StoredCredential =
  | { kind: "bearer"; token: string }
  | {
      kind: "oauth2";
      access: string;
      refresh: string | null;
      expiresAt: Extract<Credential, { kind: "oauth2" }>["expiresAt"];
      scopes: readonly string[];
    };

/** The only place plaintext is serialized, immediately before encryption. */
const seal = (credential: Credential): StoredCredential =>
  credential.kind === "bearer"
    ? { kind: "bearer", token: revealSecret(credential.token, (raw) => raw) }
    : {
        kind: "oauth2",
        access: revealSecret(credential.access, (raw) => raw),
        refresh: credential.refresh && revealSecret(credential.refresh, (raw) => raw),
        expiresAt: credential.expiresAt,
        scopes: credential.scopes,
      };

/** Null for anything `seal` didn't write, so a damaged entry reads as no credential rather than a broken one. */
const unseal = (stored: unknown): Credential | null => {
  if (typeof stored !== "object" || stored === null) return null;
  const field = (key: string): unknown => Reflect.get(stored, key);
  const kind = field("kind");
  const text = (key: string): string | null => {
    const value = field(key);
    return typeof value === "string" ? value : null;
  };
  if (kind === "bearer") {
    const token = text("token");
    return token === null ? null : { kind: "bearer", token: new Secret(token) };
  }
  if (kind !== "oauth2") return null;
  const access = text("access");
  const refresh = field("refresh");
  const expires = text("expiresAt");
  const expiresAt = expires === null ? null : parseIsoTime(expires);
  const scopes = field("scopes");
  if (
    access === null ||
    (refresh !== null && typeof refresh !== "string") ||
    expiresAt === null ||
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === "string")
  )
    return null;
  return {
    kind: "oauth2",
    access: new Secret(access),
    refresh: refresh === null ? null : new Secret(refresh),
    expiresAt,
    scopes,
  };
};

const isCryptoKey = (value: unknown): value is CryptoKey => value instanceof CryptoKey;

/** A stored secret: the IV and the ciphertext `enroll` wrote. */
const sealedRow = (value: unknown): { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | null => {
  if (typeof value !== "object" || value === null) return null;
  const iv: unknown = Reflect.get(value, "iv");
  const data: unknown = Reflect.get(value, "data");
  return iv instanceof Uint8Array && data instanceof ArrayBuffer
    ? { iv: new Uint8Array(iv), data }
    : null;
};

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("vault storage failed"));
  });

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(KEYS);
      open.result.createObjectStore(SECRETS);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(new Error("vault storage failed"));
  });

/** Non-extractable, so script can ask this key to decrypt but can never copy it out of the browser. */
const masterKey = async (db: IDBDatabase): Promise<CryptoKey> => {
  const existing = await request<unknown>(db.transaction(KEYS).objectStore(KEYS).get(MASTER));
  if (isCryptoKey(existing)) return existing;
  const created = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  // Two tabs can race here, so the first stored key wins and everyone reads that one back.
  const tx = db.transaction(KEYS, "readwrite");
  const store = tx.objectStore(KEYS);
  const raced = await request<unknown>(store.get(MASTER));
  if (isCryptoKey(raced)) return raced;
  await request(store.put(created, MASTER));
  return created;
};

const createBrowserVault = (): Vault => {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => (opened ??= openDb());

  const read = async (key: VaultKey): Promise<Credential | null> => {
    const database = await db();
    const row = sealedRow(
      await request<unknown>(database.transaction(SECRETS).objectStore(SECRETS).get(key)),
    );
    if (!row) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: row.iv },
      await masterKey(database),
      row.data,
    );
    const stored: unknown = JSON.parse(new TextDecoder().decode(plain));
    return unseal(stored);
  };

  const vault: Vault = {
    enroll: async (key, credential) => {
      // crypto.subtle exists only in a secure context. Failing here beats storing a token unencrypted.
      if (!globalThis.crypto?.subtle) throw new Error("Secure storage needs HTTPS or localhost.");
      const database = await db();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await masterKey(database),
        new TextEncoder().encode(JSON.stringify(seal(credential))),
      );
      await request(
        database.transaction(SECRETS, "readwrite").objectStore(SECRETS).put({ iv, data }, key),
      );
    },
    has: async (key) =>
      (await request((await db()).transaction(SECRETS).objectStore(SECRETS).getKey(key))) !==
      undefined,
    keys: async () =>
      (await request(
        (await db()).transaction(SECRETS).objectStore(SECRETS).getAllKeys(),
      )) as VaultKey[],
    forget: async (key) =>
      void (await request(
        (await db()).transaction(SECRETS, "readwrite").objectStore(SECRETS).delete(key),
      )),
    forgetAll: async () =>
      void (await request(
        (await db()).transaction(SECRETS, "readwrite").objectStore(SECRETS).clear(),
      )),
    leaseFor: (key) => lease(vault, key, () => read(key)),
  };
  return vault;
};

/**
 * The desktop app's vault. Main keeps each token, encrypted with `safeStorage`, and never sends one back.
 * A lease gets a stand-in, which the fake LMS checks the way it would check the token.
 */
export const createBridgeVault = (bridge: Bridge): Vault => {
  const keys = () => bridge.invoke("vault.keys", undefined);
  const forget = (key: VaultKey) => bridge.invoke("vault.forget", { key });
  const vault: Vault = {
    enroll: async (key, credential) => {
      if (credential.kind !== "bearer")
        throw new Error("The desktop app saves personal access tokens only.");
      const token = revealSecret(credential.token, (raw) => raw);
      await bridge.invoke("vault.enroll", { key, token }).catch(() => {
        throw new Error("The token could not be saved to the Keychain.");
      });
    },
    has: async (key) => (await keys()).includes(key),
    keys,
    forget,
    forgetAll: async () => {
      for (const key of await keys()) await forget(key);
    },
    leaseFor: (key) =>
      lease(vault, key, async () => {
        const standIn = await bridge.invoke("vault.standIn", { key });
        return standIn === null ? null : { kind: "bearer", token: new Secret(standIn) };
      }),
  };
  return vault;
};

/** The desktop app keeps tokens in main. The web demo has no main process, so it keeps them in IndexedDB. */
export const createAppVault = (): Vault =>
  desktopBridge ? createBridgeVault(desktopBridge) : createBrowserVault();
