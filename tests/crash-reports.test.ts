import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Bridge } from "../src/shared/ipc";

import { telemetryMain } from "./fixtures/telemetry-main";

const holder = vi.hoisted(() => ({ bridge: undefined as Bridge | undefined }));

// The UI reads the preload's bridge once, at import, so the bridge below exists before the screens load.
vi.mock("~/renderer/desktop", async (actual) => ({
  ...(await actual<typeof import("~/renderer/desktop")>()),
  get desktopBridge() {
    return holder.bridge;
  },
}));

const checkbox = (html: string) =>
  /data-testid="usage-data"[^]*?<input([^>]*)>/.exec(html)?.[1] ?? "no toggle";

describe("the usage-data and crash-report opt-out", () => {
  it("shows main's choice on the setup page and in Settings, and changing it stops sending in main", async () => {
    const main = telemetryMain();
    holder.bridge = main.bridge;
    const { telemetryChoice, PrivacySection, SetupPrivacy } =
      await import("~/renderer/components/settings/Privacy");
    const screens = () => [
      renderToString(createElement(SetupPrivacy, { title: "Privacy" })),
      renderToString(createElement(PrivacySection)),
    ];

    await telemetryChoice.load();
    for (const html of screens()) {
      expect(checkbox(html)).toContain("checked");
      expect(html).toContain("Send usage data and crash reports");
    }

    await main.bridge.invoke("analytics.track", { event: "onboarding_finished" });
    await telemetryChoice.choose(false);
    expect(main.saved().enabled).toBe(false);
    for (const html of screens()) expect(checkbox(html)).not.toContain("checked");
    await main.bridge.invoke("error.report", { type: "TypeError", stack: "" });
    await main.bridge.invoke("analytics.track", { event: "app_opened" });
    await main.telemetry.flush();
    expect(main.sent).toEqual([]);

    await telemetryChoice.choose(true);
    expect(main.saved().enabled).toBe(true);
    await main.bridge.invoke("error.report", { type: "TypeError", stack: "" });
    expect(main.sent).toHaveLength(1);
    expect(main.sent[0]).toContain('"$exception"');
    expect(main.sent[0]).not.toContain("onboarding_finished");
  });
});
