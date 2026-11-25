import type { Agent, AgentScope } from "~/shared/agent/agent";
import type { ChangeRecord } from "~/shared/domain/change";
import type { ChangeId, SchoolId } from "~/shared/domain/ids";
import { QUIET_NOISE, type NoiseConfig } from "~/shared/providers/fake-canvas/faults";
import { FAKE_SCHOOLS, createFakeCanvasDescriptor } from "~/shared/providers/fake-canvas/provider";
import { FakeCanvasServer } from "~/shared/providers/fake-canvas/server";
import {
  Secret,
  type Capabilities,
  type LmsProvider,
  type Vault,
} from "~/shared/providers/provider";
import { createMemoryVault } from "~/renderer/providers/vault";
import {
  createWorkspaceStore,
  fakeBackend,
  type WorkspaceDeps,
  type WorkspaceStore,
} from "~/renderer/stores/workspace";

import { VirtualClock } from "./clock";
import { BrowserLocks } from "./locks";
import { LCC, RSU } from "./rig";
import { memoryStorage, type MemoryStorage } from "./storage";

const SCHOOLS: readonly SchoolId[] = [LCC, RSU];
export const STORE_TOKEN = "store-rig-token-long-enough";

export interface StoreRigOptions {
  agent?: Agent;
  noKey?: boolean;
  capabilities?: Partial<Capabilities>;
  verify?: LmsProvider["verify"];
  demoScript?: boolean;
  noise?: NoiseConfig;
  storage?: MemoryStorage;
  vault?: Vault;
  clock?: VirtualClock;
  subscribeStorage?: (onChange: () => void) => void;
  subscribeFocus?: (onFocus: () => void) => void;
  locks?: BrowserLocks;
  connectivity?: { online(): boolean; subscribe(onChange: () => void): void };
  realSchools?: readonly SchoolId[];
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
      const created = new FakeCanvasServer({
        storage,
        now,
        sleep: clock.sleep,
        random: () => 0.5,
        noise: options.noise ?? QUIET_NOISE,
        demoScript: options.demoScript ?? false,
      });
      server = created;
      const backend = fakeBackend(createFakeCanvasDescriptor(created, now), () => created.reset());
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
    change: (id: ChangeId): ChangeRecord => {
      const record = state().changes[id];
      if (!record) throw new Error(`No change ${id}.`);
      return record;
    },
    connect,
    connectAll: async () => {
      for (const school of SCHOOLS) await connect(school);
    },
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
