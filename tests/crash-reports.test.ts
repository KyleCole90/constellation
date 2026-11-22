import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DesktopBridgeProvider } from "~/renderer/desktop";
import {
  PrivacySection,
  SetupPrivacy,
  telemetryChoiceFor,
} from "~/renderer/components/settings/Privacy";

import { telemetryMain } from "./fixtures/telemetry-main";

const checkbox = (html: string) =>
  /data-testid="usage-data"[^]*?<input([^>]*)>/.exec(html)?.[1] ?? "no toggle";

describe("the usage-data and crash-report opt-out", () => {
  it("shows main's choice on the setup page and in Settings, and changing it stops sending in main", async () => {
    const main = telemetryMain();
    const choice = telemetryChoiceFor(main.bridge);
    const render = (node: ReactElement) =>
      renderToString(createElement(DesktopBridgeProvider, { value: main.bridge }, node));
    const screens = () => [
      render(createElement(SetupPrivacy, { title: "Privacy" })),
      render(createElement(PrivacySection)),
    ];

    await choice.load();
    for (const html of screens()) {
      expect(checkbox(html)).toContain("checked");
      expect(html).toContain("Send usage data and crash reports");
    }

    await main.bridge.invoke("analytics.track", { event: "onboarding_finished" });
    await choice.choose(false);
    expect(main.saved().enabled).toBe(false);
    for (const html of screens()) expect(checkbox(html)).not.toContain("checked");
    await main.bridge.invoke("error.report", { type: "TypeError", stack: "" });
    await main.bridge.invoke("analytics.track", { event: "app_opened" });
    await main.telemetry.flush();
    expect(main.sent).toEqual([]);

    await choice.choose(true);
    expect(main.saved().enabled).toBe(true);
    await main.bridge.invoke("error.report", { type: "TypeError", stack: "" });
    expect(main.sent).toHaveLength(1);
    expect(main.sent[0]).toContain('"$exception"');
    expect(main.sent[0]).not.toContain("onboarding_finished");
  });
});
