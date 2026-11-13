import { describe, expect, it } from "vite-plus/test";

import type { SchoolId } from "~/shared/domain/ids";

import { nextSyncDelay, SYNC_EVERY_MS } from "~/renderer/stores/autoSync";

import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const LCC = "lcc" as SchoolId;
const RSU = "rsu" as SchoolId;
const MINUTE = 60_000;

/** A timer the test fires by hand, so the app's interval never races the assertions. */
const handTimer = () => {
  const armed: { run: () => void; ms: number; live: boolean }[] = [];
  return {
    timer: (run: () => void, ms: number) => {
      const entry = { run, ms, live: true };
      armed.push(entry);
      return () => {
        entry.live = false;
      };
    },
    live: () => armed.filter((entry) => entry.live),
    fire: () => {
      const next = armed.find((entry) => entry.live);
      if (!next) throw new Error("No timer armed.");
      next.live = false;
      next.run();
    },
  };
};

const shellCodes = (rig: StoreRig, school = LCC) =>
  (rig.state().newCourses[school] ?? []).map((shell) => shell.code);

const courseReads = (rig: StoreRig, school: SchoolId) =>
  rig.server.log.filter((entry) => entry.school === school && entry.label === "GET /api/v1/courses")
    .length;

const relaunch = async (first: StoreRig, options: Parameters<typeof makeStoreRig>[0] = {}) => {
  const second = await makeStoreRig({
    storage: first.storage,
    vault: first.vault,
    clock: first.clock,
    ...options,
  });
  await second.state().boot();
  await second.clock.flush();
  return second;
};

describe("automatic sync", () => {
  it("launch syncs every connected school, so a course added since the last run shows up", async () => {
    const first = await makeStoreRig();
    await first.connectAll();
    first.server.createShell(LCC, "BIO 105", "Biology");
    expect(shellCodes(first)).not.toContain("BIO 105");

    const second = await relaunch(first);
    expect(shellCodes(second)).toContain("BIO 105");
    expect(courseReads(second, RSU)).toBe(1);
  });

  it("a Sync failed from the last run clears once the launch sync succeeds", async () => {
    const first = await makeStoreRig();
    await first.connectAll();
    for (let i = 0; i < 4; i++) first.server.throttleNext(500);
    expect(await first.clock.run(first.state().syncSchool(LCC))).toBe(false);
    expect(first.state().connections[LCC]?.syncError).toBe("rate_limited");

    const second = await relaunch(first);
    expect(second.state().connections[LCC]?.syncError).toBeNull();
  });

  it("the timer syncs every 15 minutes while the app is open", async () => {
    const hand = handTimer();
    const first = await makeStoreRig();
    await first.connectAll();
    const second = await relaunch(first, { timer: hand.timer });
    expect(hand.live().map((entry) => entry.ms)).toEqual([SYNC_EVERY_MS]);

    second.server.createShell(LCC, "BIO 105", "Biology");
    hand.fire();
    await second.clock.flush();
    expect(shellCodes(second)).toContain("BIO 105");
    expect(hand.live().map((entry) => entry.ms)).toEqual([SYNC_EVERY_MS]);
  });

  it("after a failure it retries sooner, backing off, and returns to the interval once a sync succeeds", async () => {
    const hand = handTimer();
    const first = await makeStoreRig();
    await first.connectAll();
    const second = await makeStoreRig({
      storage: first.storage,
      vault: first.vault,
      clock: first.clock,
      timer: hand.timer,
    });
    second.server.setNoise({ rate5xx: 1 });
    await second.state().boot();
    await second.clock.flush();
    expect(second.state().connections[LCC]?.syncError).toBe("unavailable");
    expect(hand.live().map((entry) => entry.ms)).toEqual([MINUTE]);

    hand.fire();
    await second.clock.flush();
    expect(hand.live().map((entry) => entry.ms)).toEqual([2 * MINUTE]);

    second.server.resetNoise();
    hand.fire();
    await second.clock.flush();
    expect(second.state().connections[LCC]?.syncError).toBeNull();
    expect(hand.live().map((entry) => entry.ms)).toEqual([SYNC_EVERY_MS]);
  });

  it("backs off 1, 2, 4, 8 minutes and never waits longer than the interval", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(nextSyncDelay)).toEqual([
      SYNC_EVERY_MS,
      MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
      SYNC_EVERY_MS,
      SYNC_EVERY_MS,
    ]);
  });

  it("coming back online syncs, and joins a sync already running instead of starting another", async () => {
    let online = false;
    let change = () => {};
    const first = await makeStoreRig();
    await first.connectAll();
    const second = await relaunch(first, {
      connectivity: { online: () => online, subscribe: (onChange) => (change = onChange) },
    });
    expect(courseReads(second, LCC)).toBe(0);

    second.server.createShell(LCC, "BIO 105", "Biology");
    const manual = second.state().syncSchool(LCC);
    online = true;
    change();
    await second.clock.run(manual);
    await second.clock.flush();
    expect(shellCodes(second)).toContain("BIO 105");
    expect(courseReads(second, LCC)).toBe(1);
    expect(courseReads(second, RSU)).toBe(1);
  });
});
