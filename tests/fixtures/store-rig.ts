import type { Agent, AgentScope } from "~/shared/agent/agent";
import type { ChangeId, SchoolId } from "~/shared/domain/ids";
import { QUIET_NOISE, type NoiseConfig } from "~/shared/providers/fake-canvas/faults";
import { FAKE_SCHOOLS } from "~/shared/providers/fake-canvas/provider";
import type { FakeCanvasServer } from "~/shared/providers/fake-canvas/server";
import {
  Secret,
  type Capabilities,
  type LmsProvider,
  type Vault,
} from "~/shared/providers/provider";
import { createMemoryVault } from "~/renderer/providers/vault";
import {
  createWorkspaceStore,
  fakeCanvasBackend,
  type WorkspaceDeps,
  type WorkspaceStore,
} from "~/renderer/stores/workspace";

import { VirtualClock } from "./clock";
import { BrowserLocks } from "./locks";
import { memoryStorage, type MemoryStorage } from "./storage";

const SCHOOLS: readonly SchoolId[] = ["lcc" as SchoolId, "rsu" as SchoolId];
export const STORE_TOKEN = "store-rig-token-long-enough";

export interface StoreRigOptions {
  agent?: Agent;
  noKey?: boolean;
  capabilities?: Partial<Capabilities>;
  /** What the LMS answers when a token is checked, in place of the fake's own account read. */
  verify?: LmsProvider["verify"];
  demoScript?: boolean;
  noise?: NoiseConfig;
  /** Share these to act as a second tab, or as a reload of the first. */
  storage?: MemoryStorage;
  vault?: Vault;
  clock?: VirtualClock;
  subscribeStorage?: (onChange: () => void) => void;
  subscribeFocus?: (onFocus: () => void) => void;
  /** Share another rig's to act as a second tab of the same browser. */
  locks?: BrowserLocks;
  connectivity?: { online(): boolean; subscribe(onChange: () => void): void };
  /** These seeded schools join as real Canvas, served by the same fake. */
  realSchools?: readonly SchoolId[];
  /** Runs as the teacher's desktop app, whose backend has no demo. */
  noDemo?: boolean;
  timer?: (run: () => void, ms: number) => () => void;
  agentMain?: WorkspaceDeps["agentMain"];
  track?: WorkspaceDeps["track"];
}

export const makeStoreRig = async (options: StoreRigOptions = {}) => {
  const clock = options.clock ?? new VirtualClock();
  const storage = options.storage ?? memoryStorage();
  const vault = options.vault ?? createMemoryVault();
  const locks = options.locks ?? new BrowserLocks();
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
      if (!descriptor) return backend;
      const narrowed = { ...descriptor };
      const { capabilities, verify } = options;
      if (capabilities || verify) {
        narrowed.create = (context) => {
          const provider = descriptor.create(context);
          return {
            ...provider,
            capabilities: { ...provider.capabilities, ...capabilities },
            ...(verify ? { verify } : {}),
          };
        };
      }
      const real = options.realSchools ?? [];
      return {
        ...backend,
        demo: options.noDemo ? null : backend.demo,
        schoolAt: async (host) => {
          const school = await backend.schoolAt(host);
          return school && real.includes(school.id) ? { ...school, provider: "canvas" } : school;
        },
        descriptors: { "fake-canvas": narrowed, canvas: narrowed },
      };
    },
    realNow: clock.now,
    sleep: clock.sleep,
    random: () => (++seq * 0.137) % 1,
    locks,
    aiAlways: !options.noKey,
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.subscribeStorage ? { subscribeStorage: options.subscribeStorage } : {}),
    ...(options.subscribeFocus ? { subscribeFocus: options.subscribeFocus } : {}),
    ...(options.connectivity ? { connectivity: options.connectivity } : {}),
    ...(options.timer ? { timer: options.timer } : {}),
    ...(options.agentMain ? { agentMain: options.agentMain } : {}),
    ...(options.track ? { track: options.track } : {}),
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
    locks,
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
