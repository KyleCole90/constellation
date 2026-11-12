import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import * as v from "valibot";

import { jsonFile } from "../src/main/json-file";
import { createTelemetry } from "../src/main/telemetry";
import { handle, invoker, type Bridge } from "../src/shared/ipc";

import { fakeLmsHandlers } from "./fixtures/bridge";

const holder = vi.hoisted(() => ({ bridge: undefined as Bridge | undefined }));

// The UI reads the preload's bridge once, at import, so the bridge below exists before the screens load.
vi.mock("~/renderer/desktop", async (actual) => ({
  ...(await actual<typeof import("~/renderer/desktop")>()),
  get desktopBridge() {
    return holder.bridge;
  },
}));

type Listener = (sender: string | null, input: unknown) => Promise<unknown>;
const APP = "app://constellation/";

/** Main as the app builds it: telemetry over a choice file in `userData`, behind the real IPC map. */
const desktop = () => {
  const file = join(mkdtempSync(join(tmpdir(), "crash-reports-")), "telemetry.json");
  const choice = jsonFile(file, v.strictObject({ enabled: v.boolean() }), { enabled: true });
  const sent: string[] = [];
  const telemetry = createTelemetry({
    key: "phc_test",
    appRoot: "/nowhere",
    host: "https://us.i.posthog.com",
    env: undefined,
    offline: false,
    choice: { read: () => choice.read().enabled, write: (enabled) => choice.write({ enabled }) },
    appVersion: "0.0.1",
    os: "darwin arm64",
    osVersion: "15.1",
    send: async (_url, body) => void sent.push(body),
  });
  const listeners = new Map<string, Listener>();
  handle(
    (channel, listener) => listeners.set(channel, listener),
    (sender) => sender === APP,
    {
      "error.report": ({ type, stack }) => telemetry.report(type, stack, "renderer"),
      "telemetry.status": async () => telemetry.status(),
      "telemetry.choose": async ({ enabled }) => telemetry.choose(enabled),
      "vault.enroll": async () => {},
      "vault.keys": async () => [],
      "vault.forget": async () => {},
      "vault.standIn": async () => null,
      "agent.run": async () => ({ ok: false, reason: "no agent in this rig" }),
      ...fakeLmsHandlers(),
    },
  );
  const bridge: Bridge = {
    agent: "rules",
    invoke: invoker(async (channel, input) => {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`no listener for ${channel}`);
      return structuredClone(await listener(APP, structuredClone(input)));
    }),
  };
  return { bridge, sent, saved: () => choice.read().enabled };
};

const checkbox = (html: string) =>
  /data-testid="crash-reports"[^]*?<input([^>]*)>/.exec(html)?.[1] ?? "no toggle";

describe("the crash-report opt-out", () => {
  it("shows main's choice on the setup page and in Settings, and changing it stops reports in main", async () => {
    const main = desktop();
    holder.bridge = main.bridge;
    const { crashReports, PrivacySection, SetupPrivacy } =
      await import("~/renderer/components/settings/Privacy");
    const screens = () => [
      renderToString(createElement(SetupPrivacy, { title: "Privacy" })),
      renderToString(createElement(PrivacySection)),
    ];

    await crashReports.load();
    for (const html of screens()) expect(checkbox(html)).toContain("checked");

    await crashReports.choose(false);
    expect(main.saved()).toBe(false);
    for (const html of screens()) expect(checkbox(html)).not.toContain("checked");
    await main.bridge.invoke("error.report", { type: "TypeError", stack: "" });
    expect(main.sent).toEqual([]);

    await crashReports.choose(true);
    expect(main.saved()).toBe(true);
    await main.bridge.invoke("error.report", { type: "TypeError", stack: "" });
    expect(main.sent).toHaveLength(1);
  });
});
