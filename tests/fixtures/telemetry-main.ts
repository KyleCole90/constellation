import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonFile } from "../../src/main/json-file";
import { TelemetrySavedSchema, createTelemetry } from "../../src/main/telemetry";
import { handle, invoker, type Bridge } from "../../src/shared/ipc";

import { fakeLmsHandlers } from "./bridge";

type Listener = (sender: string | null, input: unknown) => Promise<unknown>;
const APP = "app://constellation/";

/**
 * Main as the app builds it: telemetry over `telemetry.json` in a fresh `userData`, behind the real IPC map. `post`
 * answers each POST with a status; every body is kept, whatever the answer.
 */
export const telemetryMain = (post: () => Promise<number> = async () => 200) => {
  const file = join(mkdtempSync(join(tmpdir(), "telemetry-main-")), "telemetry.json");
  const saved = jsonFile(file, TelemetrySavedSchema, { enabled: true });
  const sent: string[] = [];
  const telemetry = createTelemetry({
    key: "phc_test",
    host: "https://us.i.posthog.com",
    appRoot: "/nowhere",
    env: undefined,
    offline: false,
    saved,
    appVersion: "0.0.1",
    os: "darwin arm64",
    osVersion: "15.1",
    flushMs: 60_000,
    send: async (_url, body) => {
      sent.push(body);
      return post();
    },
  });
  const listeners = new Map<string, Listener>();
  handle(
    (channel, listener) => listeners.set(channel, listener),
    (sender) => sender === APP,
    {
      "analytics.track": async (event) => telemetry.track(event),
      "error.report": (report) => telemetry.report(report, "renderer"),
      "telemetry.status": async () => telemetry.status(),
      "telemetry.choose": async ({ enabled }) => telemetry.choose(enabled),
      "vault.enroll": async () => {},
      "vault.keys": async () => [],
      "vault.forget": async () => {},
      "vault.standIn": async () => null,
      "agent.source": async () => {},
      "claudeCode.status": async () => ({ installed: false, weekly: null }),
      "agent.run": async () => ({ ok: false, reason: "no agent in this rig" }),
      ...fakeLmsHandlers(),
    },
  );
  /** What the renderer's raw `ipcRenderer.invoke` would hand main, unchecked by any type. */
  const call = async (channel: string, input: unknown) => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`no listener for ${channel}`);
    return structuredClone(await listener(APP, structuredClone(input)));
  };
  const bridge: Bridge = { fakes: true, invoke: invoker(call) };
  return { bridge, call, telemetry, sent, saved: () => saved.read() };
};
