import { lmsHandlers } from "~/main/lms";
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

/** Main's `lms.*` handlers over a quiet fake LMS on `clock`, with tokens from `vault`. */
export const fakeLmsHandlers = (
  options: {
    clock?: VirtualClock;
    vault?: Vault;
    packaged?: boolean;
    onServer?: (server: FakeCanvasServer) => void;
  } = {},
) => {
  const clock = options.clock ?? new VirtualClock();
  const vault = options.vault ?? createMemoryVault();
  const storage = memoryStorage();
  return lmsHandlers({
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
    realNow: () => Date.now(),
    leaseFor: (key) => vault.leaseFor(key),
    packaged: options.packaged ?? false,
  });
};

/**
 * The desktop app's LMS in one process: the renderer's bridge client, the real IPC map with structured clone on
 * both edges, and main's handlers over a quiet fake LMS. Main's vault is a memory vault here.
 */
export const bridgedLms = (options: { packaged?: boolean } = {}) => {
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
      "vault.enroll": record,
      "vault.keys": async () => [],
      "vault.forget": record,
      "vault.standIn": async () => null,
      ...fakeLmsHandlers({
        clock,
        vault,
        ...(options.packaged === undefined ? {} : { packaged: options.packaged }),
        onServer: (server) => servers.push(server),
      }),
    },
  );
  /** What main's listener for `channel` answers, as the preload would get it. */
  const call = async (channel: string, input: unknown, sender: string | null = APP) => {
    const listen = listeners.get(channel);
    if (!listen) throw new Error(`no listener for ${channel}`);
    return structuredClone(await listen(sender, structuredClone(input)));
  };
  const bridge: Bridge = {
    invoke: invoker((channel, input) => call(channel, input)),
  };
  const fake = bridgeFakeLms(bridge, FAKE_CANVAS, FAKE_CANVAS_FACE, clock.now);
  /** Main's live fake: the renderer reloads it on start, as a page load does. */
  const server = () => {
    const live = servers.at(-1);
    if (!live) throw new Error("main made no server");
    return live;
  };

  const provider = (id: SchoolId) => {
    const school = FAKE_SCHOOLS.find((entry) => entry.id === id);
    if (!school) throw new Error(`No school ${id}`);
    return fake.descriptor.create({ school, lease: vault.leaseFor(id) });
  };
  /** Saves a token in main's vault, then checks it through the bridge. */
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
    lab: fake.lab,
    provider,
    connect,
    call,
    handled,
    listeners,
  };
};
