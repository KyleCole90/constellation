import { lmsHandlers } from "~/main/lms";
import type { Fetch } from "~/main/providers/canvas";
import type { SchoolId } from "~/shared/domain/ids";
import { handle, invoker, type Bridge } from "~/shared/ipc";
import { QUIET_NOISE } from "~/shared/providers/fake-canvas/faults";
import {
  FAKE_CANVAS,
  FAKE_CANVAS_FACE,
  FAKE_SCHOOLS,
} from "~/shared/providers/fake-canvas/provider";
import { FakeCanvasServer } from "~/shared/providers/fake-canvas/server";
import { Secret, type Vault } from "~/shared/providers/provider";
import { bridgeFakeLms } from "~/renderer/providers/lms";
import { createMemoryVault } from "~/renderer/providers/vault";

import { VirtualClock } from "./clock";
import { memoryStorage } from "./storage";

type Listener = (sender: string | null, input: unknown) => Promise<unknown>;

const APP = "app://constellation/";
const TOKEN = "fake-token-with-enough-length";

export const fakeLmsHandlers = (
  options: {
    clock?: VirtualClock;
    vault?: Vault;
    fetch?: Fetch;
    pressedAt?: () => number;
    choosePackage?: () => Promise<string | null>;
    onServer?: (server: FakeCanvasServer) => void;
  } = {},
) => {
  const clock = options.clock ?? new VirtualClock();
  const vault = options.vault ?? createMemoryVault();
  const storage = memoryStorage();
  return lmsHandlers({
    lms: options.fetch
      ? { kind: "canvas", fetch: options.fetch }
      : {
          kind: "fake",
          makeServer: (now) => {
            const server = new FakeCanvasServer({
              storage,
              now,
              sleep: clock.sleep,
              random: () => 0.5,
              noise: QUIET_NOISE,
              demoScript: false,
            });
            options.onServer?.(server);
            return server;
          },
        },
    realNow: () => Date.now(),
    leaseFor: (key) => vault.leaseFor(key),
    pressedAt: options.pressedAt ?? (() => Date.now()),
    choosePackage: options.choosePackage ?? (async () => null),
  });
};

export const bridgedLms = (
  options: {
    fetch?: Fetch;
    pressedAt?: () => number;
    choosePackage?: () => Promise<string | null>;
  } = {},
) => {
  const clock = new VirtualClock();
  const vault = createMemoryVault();
  const servers: FakeCanvasServer[] = [];
  const listeners = new Map<string, Listener>();
  const handled: unknown[] = [];
  const record = async (input: unknown) => void handled.push(input);
  handle(
    (channel, listen) => listeners.set(channel, listen),
    (sender) => sender === APP,
    {
      "error.report": record,
      "telemetry.status": async () => ({ enabled: true, available: false }),
      "analytics.track": async () => {},
      "telemetry.choose": async () => {},
      "vault.enroll": record,
      "vault.keys": async () => [],
      "vault.forget": record,
      "vault.standIn": async () => null,
      "agent.source": async () => {},
      "claudeCode.status": async () => ({ installed: false, weekly: null }),
      "agent.run": async () => ({ ok: false, reason: "no agent in this rig" }),
      ...fakeLmsHandlers({
        clock,
        vault,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.pressedAt === undefined ? {} : { pressedAt: options.pressedAt }),
        ...(options.choosePackage === undefined ? {} : { choosePackage: options.choosePackage }),
        onServer: (server) => servers.push(server),
      }),
    },
  );
  const call = async (channel: string, input: unknown, sender: string | null = APP) => {
    const listen = listeners.get(channel);
    if (!listen) throw new Error(`no listener for ${channel}`);
    return structuredClone(await listen(sender, structuredClone(input)));
  };
  const bridge: Bridge = {
    fakes: options.fetch === undefined,
    invoke: invoker((channel, input) => call(channel, input)),
  };
  const fake =
    options.fetch === undefined
      ? bridgeFakeLms(bridge, FAKE_CANVAS, FAKE_CANVAS_FACE, clock.now)
      : null;
  const theFake = () => {
    if (!fake) throw new Error("this rig runs real Canvas, with no fake");
    return fake;
  };
  const server = () => {
    const live = servers.at(-1);
    if (!live) throw new Error("main made no server");
    return live;
  };

  const provider = (id: SchoolId) => {
    const school = FAKE_SCHOOLS.find((entry) => entry.id === id);
    if (!school) throw new Error(`No school ${id}`);
    return theFake().descriptor.create({ school, lease: vault.leaseFor(id) });
  };
  const connect = async (id: SchoolId) => {
    await vault.enroll(id, { kind: "bearer", token: new Secret(TOKEN) });
    const result = await provider(id).verify();
    if (!result.ok) throw new Error(`verify failed: ${result.error.kind}`);
  };
  return {
    clock,
    get server() {
      return server();
    },
    get lab() {
      return theFake().lab;
    },
    bridge,
    vault,
    provider,
    connect,
    call,
    handled,
    listeners,
  };
};
