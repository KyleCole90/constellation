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

/**
 * The desktop app's vault. Main keeps each token, encrypted with `safeStorage`, and never sends one back.
 * A lease gets a stand-in, which the fake LMS checks the way it would check the token.
 */
export const createBridgeVault = (bridge: Pick<Bridge, "invoke">): Vault => {
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
