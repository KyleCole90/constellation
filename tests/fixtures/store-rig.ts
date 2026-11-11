import type { Agent, AgentScope } from "~/agent/agent";
import type { ChangeId, SchoolId } from "~/domain/ids";
import { QUIET_NOISE, type NoiseConfig } from "~/providers/fake-canvas/faults";
import { FAKE_SCHOOLS } from "~/providers/fake-canvas/provider";
import type { FakeCanvasServer } from "~/providers/fake-canvas/server";
import { Secret, type Capabilities, type Vault } from "~/providers/provider";
import { createMemoryVault } from "~/providers/vault";
import { createWorkspaceStore, fakeCanvasBackend, type WorkspaceStore } from "~/stores/workspace";

import { VirtualClock } from "./clock";
import { memoryStorage, type MemoryStorage } from "./storage";

const SCHOOLS: readonly SchoolId[] = ["lcc" as SchoolId, "rsu" as SchoolId];
export const STORE_TOKEN = "store-rig-token-long-enough";

export interface StoreRigOptions {
  agent?: Agent;
  noKey?: boolean;
  capabilities?: Partial<Capabilities>;
  demoScript?: boolean;
  noise?: NoiseConfig;
  /** Share these to act as a second tab, or as a reload of the first. */
  storage?: MemoryStorage;
  vault?: Vault;
  clock?: VirtualClock;
  subscribeStorage?: (onChange: () => void) => void;
  locks?: Pick<LockManager, "request">;
}

export const makeStoreRig = async (options: StoreRigOptions = {}) => {
  const clock = options.clock ?? new VirtualClock();
  const storage = options.storage ?? memoryStorage();
  const vault = options.vault ?? createMemoryVault();
  let server: FakeCanvasServer | null = null;
  let seq = 0;
  const store: WorkspaceStore = createWorkspaceStore({
    storage,
    vault,
    backend: (now) => {
      const backend = fakeCanvasBackend({
        storage,
        noise: options.noise ?? QUIET_NOISE,
        demoScript: options.demoScript ?? false,
        sleep: clock.sleep,
        random: () => 0.5,
        onServer: (created) => (server = created),
      })(now);
      const descriptor = backend.descriptors["fake-canvas"];
      if (!options.capabilities || !descriptor) return backend;
      const narrowed = (context: Parameters<typeof descriptor.create>[0]) => {
        const provider = descriptor.create(context);
        return { ...provider, capabilities: { ...provider.capabilities, ...options.capabilities } };
      };
      return { ...backend, descriptors: { "fake-canvas": { ...descriptor, create: narrowed } } };
    },
    realNow: clock.now,
    sleep: clock.sleep,
    random: () => (++seq * 0.137) % 1,
    locks: options.locks ?? null,
    aiAlways: !options.noKey,
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.subscribeStorage ? { subscribeStorage: options.subscribeStorage } : {}),
  });

  const state = () => store.getState();

  /** Adds the seeded school at first, as onboarding does, and reconnects it after that. */
  const connect = async (school: SchoolId, token = STORE_TOKEN) => {
    if (state().schools.some((entry) => entry.id === school))
      return clock.run(state().connect(school, new Secret(token)));
    const host = FAKE_SCHOOLS.find((entry) => entry.id === school)?.host;
    if (!host) throw new Error(`No seeded school ${school}.`);
    const added = await clock.run(state().addSchool(host, new Secret(token)));
    return added.ok ? { ok: true as const, value: null } : added;
  };

  return {
    clock,
    storage,
    vault,
    store,
    state,
    get server(): FakeCanvasServer {
      if (!server) throw new Error("No server.");
      return server;
    },
    connect,
    connectAll: async () => {
      for (const school of SCHOOLS) await connect(school);
    },
    /** The scope a thread would give the agent for this change. */
    scopeFor: (id: ChangeId): AgentScope => {
      const record = state().changes[id];
      const cache = record && state().cache[record.school];
      const target = record?.content.target;
      return {
        focus: id,
        changes: Object.values(state().changes),
        submissions: cache?.submissions.filter((s) => s.ref === target) ?? [],
        assignments: cache?.assignments ?? [],
        conversations: cache?.conversations ?? [],
        courses: cache?.courses ?? [],
      };
    },
  };
};
export type StoreRig = Awaited<ReturnType<typeof makeStoreRig>>;
