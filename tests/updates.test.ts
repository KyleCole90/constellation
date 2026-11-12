import { EventEmitter } from "node:events";

import { describe, expect, it } from "vite-plus/test";

import { startUpdates } from "../src/main/updates";

/** Stands in for electron-updater's `autoUpdater`: an emitter whose check resolves or rejects as the test says. */
const fakeUpdater = (check: () => Promise<unknown> = async () => null) => {
  const emitter = new EventEmitter();
  const calls = { checks: 0, installs: 0 };
  const updater = Object.assign(emitter, {
    checkForUpdates: () => {
      calls.checks += 1;
      return check();
    },
    quitAndInstall: () => {
      calls.installs += 1;
    },
  });
  return { updater, calls };
};

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("updates", () => {
  it("check once at launch", () => {
    const { updater, calls } = fakeUpdater();
    startUpdates(updater, async () => false);
    expect(calls.checks).toBe(1);
  });

  it("tell the teacher which version is ready, and restart only when they ask", async () => {
    const asked: string[] = [];
    const later = fakeUpdater();
    startUpdates(later.updater, async (version) => (asked.push(version), false));
    later.updater.emit("update-downloaded", { version: "0.0.1-alpha.2" });
    await settle();
    expect(asked).toEqual(["0.0.1-alpha.2"]);
    expect(later.calls.installs).toBe(0);

    const now = fakeUpdater();
    startUpdates(now.updater, async () => true);
    now.updater.emit("update-downloaded", { version: "0.0.1-alpha.2" });
    await settle();
    expect(now.calls.installs).toBe(1);
  });

  it("survive a failed check, offline or before any release", async () => {
    const { updater } = fakeUpdater(async () => {
      throw new Error("net::ERR_INTERNET_DISCONNECTED");
    });
    startUpdates(updater, async () => false);
    // An emitter with no `error` listener throws; electron-updater emits one for each failure.
    expect(() => updater.emit("error", new Error("No published versions on GitHub"))).not.toThrow();
    await settle();
  });
});
