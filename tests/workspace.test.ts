import { describe, expect, it, vi } from "vite-plus/test";

import { DRAFT_GRADE_REQUEST } from "~/shared/agent/agent";
import { ApprovalWitness } from "~/shared/domain/approval";
import { summarize, zeroPatch, type ChangePatch } from "~/shared/domain/change";
import type { ChangeId, IsoTime, LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import { previewOf } from "~/shared/domain/preview";
import { DEMO_CONFLICT, DEMO_PARTIAL, QUIET_NOISE } from "~/shared/providers/fake-canvas/faults";
import { FakeCanvasServer, LMS_STORAGE_KEY } from "~/shared/providers/fake-canvas/server";
import { SEED } from "~/shared/providers/fake-canvas/seed";
import { Secret } from "~/shared/providers/provider";
import { createMemoryVault } from "~/renderer/providers/vault";
import {
  selectCalendar,
  selectCourseOverview,
  selectGradebook,
  selectInboxRows,
  selectCourseWaiting,
  selectQueueRows,
  selectSchoolCoverage,
  selectSchoolWaiting,
  selectThreadStatus,
  selectWhatsDue,
  summarizeFor,
} from "~/renderer/stores/selectors";
import { connectionStatus } from "~/renderer/components/settings/connection.logic";
import { OFFLINE_SEND_REASON } from "~/renderer/desktop";
import type { ConnectionRecord } from "~/renderer/stores/types";
import { WORKSPACE_STORAGE_KEY } from "~/renderer/stores/workspace";

import { clickWitness } from "./fixtures/changes";
import { VirtualClock } from "./fixtures/clock";
import { memoryStorage } from "./fixtures/storage";
import { STORE_TOKEN, makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const LCC = "lcc" as SchoolId;
const RSU = "rsu" as SchoolId;
const QUEUE = "t-queue" as ThreadId;

const stateTag = (rig: StoreRig, id: ChangeId) => rig.state().changes[id]?.state.tag;

const approve = (rig: StoreRig, id: ChangeId) => {
  const record = rig.state().changes[id];
  if (!record) throw new Error("No change.");
  const result = rig
    .state()
    .dispatchUser(id, { type: "approve", witness: clickWitness(record), at: record.basis.readAt });
  if (!result.ok) throw new Error(result.error);
};

const openFor = async (
  rig: StoreRig,
  student: string,
  assignment = "Essay 2",
): Promise<ChangeId> => {
  const ref = rig.server.findSubmission(student, assignment);
  if (!ref) throw new Error(`No submission for ${student}.`);
  const id = await rig.clock.run(rig.state().openSubmission(QUEUE, ref, { fill: "draft" }));
  if (!id) throw new Error("Nothing was drafted.");
  return id;
};

const connected = async (options: Parameters<typeof makeStoreRig>[0] = {}) => {
  const rig = await makeStoreRig(options);
  await rig.connectAll();
  return rig;
};

describe("persistence", () => {
  it("a change committed by the ledger is in storage by the time the action returns", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    const stored = JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as {
      version: number;
      state: { changes: Record<string, unknown> };
    };
    expect(stored.version).toBe(3);
    expect(stored.state.changes[id]).toBeDefined();
  });

  it("a reload restores threads and changes and stays connected", async () => {
    const first = await connected();
    const id = await openFor(first, "Maya Ortiz");
    const second = await makeStoreRig({
      storage: first.storage,
      vault: first.vault,
      clock: first.clock,
    });
    await second.state().boot();
    expect(second.state().changes[id]?.state.tag).toBe("draft");
    expect(second.state().connections[LCC]?.status).toBe("connected");
    expect(second.state().notice).toBeNull();
    expect(await second.state().syncSchool(LCC)).toBe(true);
  });

  it("a reload with the vault emptied says the token is gone and marks it disconnected", async () => {
    const first = await connected();
    const second = await makeStoreRig({
      storage: first.storage,
      vault: createMemoryVault(),
      clock: first.clock,
    });
    await second.state().boot();
    expect(second.state().connections[LCC]?.status).toBe("disconnected");
    expect(second.state().notice).toContain("Connect again");
  });

  it.each([
    ["not JSON", "{{{"],
    ["JSON of the wrong shape", '{"version":1,"state":{"threads":"nope"}}'],
    ["an old version", '{"version":0,"state":{"changes":{}}}'],
    ["a newer version", '{"version":4,"state":{}}'],
    ["a version 2 blob of the wrong shape", '{"version":2,"state":{}}'],
    [
      "a change missing its state",
      '{"version":1,"state":{"schools":[],"connections":{},"cache":{},"changes":{"a":{}},"threads":{},"prefs":{},"onboarding":"schools","resetAt":0}}',
    ],
  ])("%s resets to a clean workspace with a notice, and logs nothing", async (_name, blob) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = memoryStorage();
    storage.setItem(WORKSPACE_STORAGE_KEY, blob);
    const rig = await makeStoreRig({ storage });
    expect(rig.state().notice).toContain("reset");
    expect(Object.keys(rig.state().threads).length).toBeGreaterThan(1);
    expect(JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}").version).toBe(3);
    expect(rig.storage.getItem(`${WORKSPACE_STORAGE_KEY}.unreadable`)).toBe(blob);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  type Saved = { state: Record<string, unknown> };
  const firstOf = (record: unknown): Record<string, unknown> =>
    Object.values(record as Record<string, Record<string, unknown>>)[0] ?? {};
  const threadOfKind = (saved: Saved, kind: string): Record<string, unknown> => {
    const threads = Object.values(saved.state.threads as Record<string, Record<string, unknown>>);
    const found = threads.find((thread) => thread["kind"] === kind);
    if (!found) throw new Error(`The seed has no ${kind} thread.`);
    return found;
  };
  it.each<[string, (saved: Saved) => void]>([
    ["setups that isn't a record", (saved) => (saved.state.setups = "nope")],
    ["handoffs that isn't a record", (saved) => (saved.state.handoffs = [])],
    [
      "a change of an unknown kind",
      (saved) => (firstOf(saved.state.changes).content = { kind: "poem" }),
    ],
    [
      "a change in an unknown state",
      (saved) => (firstOf(saved.state.changes).state = { tag: "lost" }),
    ],
    ["a thread of an unknown kind", (saved) => (firstOf(saved.state.threads).kind = "diary")],
    [
      "a cache missing its conversations",
      (saved) => delete firstOf(saved.state.cache).conversations,
    ],
    [
      "a grading thread with no assignment",
      (saved) => delete threadOfKind(saved, "grading").assignment,
    ],
    [
      "an announcement thread with no course",
      (saved) => (threadOfKind(saved, "announcement").course = null),
    ],
  ])("a saved workspace with %s resets and keeps a backup", async (_name, corrupt) => {
    const first = await connected();
    await openFor(first, "Maya Ortiz");
    const saved = JSON.parse(first.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as Saved;
    corrupt(saved);
    const blob = JSON.stringify(saved);
    first.storage.setItem(WORKSPACE_STORAGE_KEY, blob);
    const second = await makeStoreRig({
      storage: first.storage,
      vault: first.vault,
      clock: first.clock,
    });
    expect(second.state().notice).toContain("reset");
    expect(second.storage.getItem(`${WORKSPACE_STORAGE_KEY}.unreadable`)).toBe(blob);
  });

  it("a save from before setups, new courses and handoffs existed still loads", async () => {
    const first = await connected();
    const id = await openFor(first, "Maya Ortiz");
    const saved = JSON.parse(first.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as Saved;
    delete saved.state.setups;
    delete saved.state.newCourses;
    delete saved.state.handoffs;
    first.storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(saved));
    const second = await makeStoreRig({
      storage: first.storage,
      vault: first.vault,
      clock: first.clock,
    });
    expect(second.state().notice ?? "").not.toContain("reset");
    expect(second.state().changes[id]).toBeDefined();
  });

  it.each([1, 4])(
    "a well-formed blob from version %i also resets, because its shape cannot be trusted",
    async (version) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const first = await connected();
      const id = await openFor(first, "Maya Ortiz");
      const stored = JSON.parse(first.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as {
        version: number;
      };
      first.storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ ...stored, version }));
      const second = await makeStoreRig({
        storage: first.storage,
        vault: first.vault,
        clock: first.clock,
      });
      expect(second.state().notice).toContain("reset");
      expect(second.state().changes[id]).toBeUndefined();
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    },
  );

  it("the transient working flag is not persisted", async () => {
    const rig = await connected();
    await openFor(rig, "Maya Ortiz");
    expect(
      JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}").state.working,
    ).toBeUndefined();
  });
});

describe("resetDemoData", () => {
  it("wipes both storage keys, the vault, and the LMS's own changes", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    await rig.state().addAiKey(new Secret(STORE_TOKEN));

    await rig.state().resetDemoData();

    expect(await rig.vault.has(LCC)).toBe(false);
    expect(await rig.vault.has("ai-key")).toBe(false);
    expect(rig.storage.getItem(LMS_STORAGE_KEY)).toBeNull();
    expect(rig.state().changes).toEqual({});
    expect(rig.state().cache).toEqual({});
    expect(rig.state().schools).toEqual([]);
    expect(rig.state().connections).toEqual({});
    expect(rig.state().onboarding).toBe("welcome");
    expect(rig.state().aiSource).toBe("none");
    expect(rig.state().notice).toContain("reset");
    const persisted = JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as {
      state: { changes: object };
    };
    expect(persisted.state.changes).toEqual({});
  });

  it("after a reset the seeded LMS comes back, ungraded", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    const before = selectQueueRows(rig.state()).filter((row) => row.open).length;
    await rig.state().resetDemoData();
    await rig.connectAll();
    expect(selectQueueRows(rig.state()).filter((row) => row.open).length).toBe(before + 1);
  });

  it("says so once, and a reload drops the notice", async () => {
    const rig = await connected();
    await rig.state().resetDemoData();
    expect(rig.state().notice).toContain("reset");
    const reloaded = await makeStoreRig({
      storage: rig.storage,
      vault: rig.vault,
      clock: rig.clock,
    });
    expect(reloaded.state().notice).toBeNull();
  });

  it("restarts the demo clock at the seed time", async () => {
    const clock = new VirtualClock();
    const rig = await connected({ clock });
    clock.advance(86_400_000);
    await rig.state().resetDemoData();
    expect(rig.state().now()).toBe(new Date(SEED.now).getTime());
  });
});

describe("the demo clock", () => {
  it("starts at the seed time and moves with real time", async () => {
    const clock = new VirtualClock();
    const rig = await makeStoreRig({ clock });
    const start = new Date(SEED.now).getTime();
    expect(rig.state().now()).toBe(start);
    clock.advance(5000);
    expect(rig.state().now()).toBe(start + 5000);
  });

  it("stamps changes with the demo clock, not the wall clock", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    expect(
      rig
        .state()
        .changes[id]?.basis.readAt.startsWith(new Date(SEED.now).toISOString().slice(0, 10)),
    ).toBe(true);
  });
});

describe("a real school", () => {
  const WALL = Date.UTC(2026, 10, 13, 20, 37);

  it("puts the app on the wall clock, from the token it saves to what's due", async () => {
    const clock = new VirtualClock(WALL);
    const rig = await makeStoreRig({ clock, realSchools: [LCC] });
    await rig.connect(LCC);
    expect(rig.state().now()).toBe(WALL);
    expect(rig.state().connections[LCC]?.connectedAt).toBe(new Date(WALL).toISOString());
    const id = await openFor(rig, "Maya Ortiz");
    expect(rig.state().changes[id]?.basis.readAt.slice(0, 10)).toBe("2026-11-13");
    clock.advance(5000);
    expect(rig.state().now()).toBe(WALL + 5000);
  });

  it("keeps the wall clock beside a demo school", async () => {
    const rig = await makeStoreRig({ clock: new VirtualClock(WALL), realSchools: [LCC] });
    await rig.connectAll();
    expect(rig.state().now()).toBe(WALL);
  });

  it("leaves a demo-only workspace on the demo clock", async () => {
    const rig = await makeStoreRig({ clock: new VirtualClock(WALL) });
    await rig.connectAll();
    expect(rig.state().now()).toBe(new Date(SEED.now).getTime());
  });
});

describe("a second tab", () => {
  const twoTabs = async () => {
    let notify = () => undefined as void;
    const first = await connected();
    const second = await makeStoreRig({
      storage: first.storage,
      vault: first.vault,
      clock: first.clock,
      subscribeStorage: (onChange) => (notify = onChange),
    });
    return { first, second, notify: () => notify() };
  };

  it("picks up a change when the storage event arrives", async () => {
    const { first, second, notify } = await twoTabs();
    const id = await openFor(first, "Maya Ortiz");
    expect(second.state().changes[id]).toBeUndefined();
    notify();
    expect(second.state().changes[id]?.state.tag).toBe("draft");
  });

  it("judges a commit from fresh state even before the storage event arrives", async () => {
    const { first, second } = await twoTabs();
    const id = await openFor(first, "Maya Ortiz");
    approve(first, id);
    await first.clock.run(first.state().sendChanges([id]));
    const refused = await second.clock.run(second.state().sendChanges([id]));
    expect(refused).toEqual([{ id, refused: "not-sendable" }]);
    expect(stateTag(second, id)).toBe("sent");
  });

  it("a save from a stale tab can't roll back another tab's send", async () => {
    const { first, second } = await twoTabs();
    const id = await openFor(first, "Maya Ortiz");
    approve(first, id);
    second.state().setThreadUi(QUEUE, { scrollTop: 10 });
    second.state().setPrefs({ sidebarOpen: false });

    const stored = JSON.parse(first.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as {
      state: {
        changes: Record<string, { state: { tag: string } }>;
        prefs: { sidebarOpen: boolean };
      };
    };
    expect(stored.state.changes[id]?.state.tag).toBe("approved");
    expect(stored.state.prefs.sidebarOpen).toBe(false);

    expect(await first.clock.run(first.state().sendChanges([id]))).toEqual([{ id, state: "sent" }]);
    expect(stateTag(first, id)).toBe("sent");
    // The stale tab reads the disk before it acts, so it can't send what it thought was still approved.
    expect(await second.clock.run(second.state().sendChanges([id]))).toEqual([
      { id, refused: "not-sendable" },
    ]);
  });

  it("does not overwrite what the other tab saved", async () => {
    const { first, second } = await twoTabs();
    const id = await openFor(first, "Maya Ortiz");
    second
      .state()
      .dispatchUser(id, { type: "discard", at: first.state().changes[id]?.basis.readAt as never });
    expect(stateTag(second, id)).toBe("discarded");
    first.store.syncFromStorage();
    expect(stateTag(first, id)).toBe("discarded");
  });
});

describe("one open change per target", () => {
  it("asking the agent for a second draft opens the first one", async () => {
    const rig = await connected();
    await rig.clock.run(rig.state().sendToAgent(QUEUE, DRAFT_GRADE_REQUEST));
    const [first, ...others] = Object.keys(rig.state().changes);
    expect(others).toEqual([]);
    await rig.clock.run(rig.state().sendToAgent(QUEUE, DRAFT_GRADE_REQUEST));
    expect(Object.keys(rig.state().changes)).toEqual([first]);
    expect(rig.state().threads[QUEUE]?.focus).toBe(first);
  });
});

describe("a slow draft and a later click", () => {
  it("focus stays on what was asked for last", async () => {
    const rig = await connected();
    const maya = rig.server.findSubmission("Maya Ortiz", "Essay 2");
    const devon = await openFor(rig, "Devon Reyes", "Essay 2");
    if (!maya) throw new Error("No submission.");
    const slow = rig.state().openSubmission(QUEUE, maya, { fill: "draft" });
    rig.state().focusChange(QUEUE, devon);
    await rig.clock.run(slow);
    expect(rig.state().threads[QUEUE]?.focus).toBe(devon);
  });
});

describe("a school without a working token", () => {
  it.each(["expired", "disconnected"] as const)(
    "%s turns every held change's recovery into Reconnect",
    async (status) => {
      const rig = await connected();
      const id = await openFor(rig, "Maya Ortiz");
      approve(rig, id);
      rig.server.failNextWrite("comment", { kind: "unavailable", status: 500 });
      await rig.clock.run(rig.state().sendChanges([id]));
      const record = rig.state().changes[id];
      if (!record) throw new Error("No change.");
      expect(summarizeFor(record, "connected").banner).toBe("partial");
      expect(summarizeFor(record, status)).toMatchObject({
        banner: "reconnect",
        recovery: "reconnect",
        waitingOnReconnect: true,
      });
    },
  );
});

describe("connect and disconnect", () => {
  it("connecting syncs the school and records the account", async () => {
    const rig = await makeStoreRig();
    const result = await rig.connect(LCC);
    expect(result.ok).toBe(true);
    const connection = rig.state().connections[LCC];
    expect(connection?.status).toBe("connected");
    expect(connection?.accountName).toBe(SEED.instructor);
    expect(connection?.scopes.length).toBeGreaterThan(0);
    expect(connection?.lastSyncedAt).not.toBeNull();
    expect(rig.state().cache[LCC]?.courses.length).toBeGreaterThan(0);
    expect(rig.state().cache[RSU]).toBeUndefined();
  });

  it("lists schools by name whichever one connects first", async () => {
    const rig = await makeStoreRig();
    await rig.connect(RSU);
    await rig.connect(LCC);
    expect(rig.state().schools.map((school) => school.name)).toEqual([
      "Lakeshore Community College",
      "Riverbend State University",
    ]);
  });

  it("disconnecting forgets the token and the cache", async () => {
    const rig = await connected();
    await rig.state().disconnect(LCC);
    expect(await rig.vault.has(LCC)).toBe(false);
    expect(rig.state().connections[LCC]?.status).toBe("disconnected");
    expect(rig.state().cache[LCC]).toBeUndefined();
    expect(rig.state().cache[RSU]).toBeDefined();
    expect(await rig.state().syncSchool(LCC)).toBe(false);
  });

  it("a disconnected school is named as hidden and offers no filter", async () => {
    const rig = await connected();
    await rig.state().disconnect(LCC);
    const coverage = selectSchoolCoverage(rig.state());
    expect(coverage.disconnected.map((school) => school.id)).toEqual([LCC]);
    expect(coverage.withData.map((school) => school.id)).toEqual([RSU]);
  });

  it("an expired token found during a sync marks the connection expired and tells the user", async () => {
    const rig = await connected();
    rig.server.expireToken(LCC);
    expect(await rig.clock.run(rig.state().syncSchool(LCC))).toBe(false);
    expect(rig.state().connections[LCC]?.status).toBe("expired");
    expect(rig.state().notice).toContain("expired");
  });

  it("the enrollment screen gets its steps from the provider", async () => {
    const rig = await connected();
    const enrollment = rig.state().enrollmentFor(LCC);
    expect(enrollment?.kind === "paste-token" && enrollment.steps.length).toBeGreaterThan(0);
  });
});

describe("syncSchool", () => {
  it("a single 429 is retried through the lane and succeeds", async () => {
    const rig = await connected();
    rig.server.throttleNext(2000);
    expect(await rig.clock.run(rig.state().syncSchool(LCC))).toBe(true);
    expect(rig.state().connections[LCC]?.syncError).toBeNull();
    expect(rig.server.log.some((entry) => entry.result === "rate_limited")).toBe(true);
  });

  it("repeated 429s surface as stale data: the old cache stays, with an error and the old timestamp", async () => {
    const clock = new VirtualClock();
    const rig = await connected({ clock });
    const before = rig.state().connections[LCC]?.lastSyncedAt;
    const cached = rig.state().cache[LCC];
    clock.advance(60_000);
    for (let i = 0; i < 4; i++) rig.server.throttleNext(500);
    expect(await rig.clock.run(rig.state().syncSchool(LCC))).toBe(false);
    expect(rig.state().connections[LCC]?.syncError).toBe("rate_limited");
    expect(rig.state().connections[LCC]?.lastSyncedAt).toBe(before);
    expect(rig.state().cache[LCC]).toEqual(cached);
    expect(rig.state().connections[LCC]?.status).toBe("connected");
  });

  it("two syncs at once make one set of requests", async () => {
    const rig = await connected();
    rig.server.log.length = 0;
    await Promise.all([rig.state().syncSchool(LCC), rig.state().syncSchool(LCC)]);
    expect(rig.server.log.filter((entry) => entry.label === "GET /api/v1/courses")).toHaveLength(1);
  });
});

describe("sendChanges", () => {
  it("refreshes the cache from the provider, so screens show what the LMS holds", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    approve(rig, id);
    const target = rig.state().changes[id]?.content.target;
    const before = rig.state().cache[LCC]?.submissions.find((s) => s.ref === target);
    expect(before?.grade).toBeNull();
    await rig.clock.run(rig.state().sendChanges([id]));
    const after = rig.state().cache[LCC]?.submissions.find((s) => s.ref === target);
    expect(after?.workflow).toBe("graded");
    expect(after?.grade).not.toBeNull();
    expect(after?.comments).toHaveLength(1);
  });

  it("a draft goes nowhere without the button", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    expect(await rig.clock.run(rig.state().sendChanges([id]))).toEqual([
      { id, refused: "not-sendable" },
    ]);
    expect(rig.server.log.filter((entry) => entry.kind === "write")).toEqual([]);
  });

  it("offline, Send is disabled with the reason, nothing is tried, and it sends once back online", async () => {
    let online = true;
    let change = () => {};
    const rig = await connected({
      connectivity: { online: () => online, subscribe: (onChange) => (change = onChange) },
    });
    const id = await openFor(rig, "Maya Ortiz");
    approve(rig, id);
    online = false;
    change();
    const row = selectQueueRows(rig.state()).find((entry) => entry.change?.id === id);
    expect(row?.summary?.canSend).toBe(false);
    expect(connectionStatus(rig.state().connections[LCC], false, rig.state().online)).toBe(
      "offline",
    );
    rig.server.log.length = 0;

    expect(await rig.clock.run(rig.state().sendChanges([id]))).toEqual([
      { id, refused: "no-connection" },
    ]);
    expect(rig.state().notice).toBe(OFFLINE_SEND_REASON);
    expect(rig.server.log).toEqual([]);
    expect(stateTag(rig, id)).toBe("approved");

    online = true;
    change();
    expect(
      selectQueueRows(rig.state()).find((entry) => entry.change?.id === id)?.summary?.canSend,
    ).toBe(true);
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(stateTag(rig, id)).toBe("sent");
  });

  it("a storage failure mid-send stops it, goes back to what is durable, and says so", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    approve(rig, id);
    rig.storage.failNextWrite();
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(rig.state().notice).toContain("Couldn't save");
    expect(stateTag(rig, id)).toBe("approved");
    expect(rig.server.log.filter((entry) => entry.kind === "write")).toEqual([]);
  });

  it("a reload during a send finishes at boot once a read confirms everything landed, with one comment", async () => {
    const first = await connected();
    const id = await openFor(first, "Maya Ortiz");
    approve(first, id);
    first.server.loseNextResponse();
    const interrupted = first.state().sendChanges([id]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stateTag(first, id)).toBe("sending");

    const second = await makeStoreRig({
      storage: first.storage,
      vault: first.vault,
      clock: first.clock,
    });
    await second.clock.run(second.state().boot());
    expect(stateTag(second, id)).toBe("sent");
    const target = second.state().changes[id]?.content.target;
    await second.clock.run(second.state().syncSchool(LCC));
    expect(
      second.state().cache[LCC]?.submissions.find((s) => s.ref === target)?.comments,
    ).toHaveLength(1);
    await first.clock.run(interrupted);
  });
});

describe("messaging a missing student", () => {
  const messageFiona = async (rig: StoreRig) => {
    const ref = rig.server.findSubmission("Fiona Kerr", "Sequence Analysis");
    if (!ref) throw new Error("No submission for Fiona Kerr.");
    const id = await rig.clock.run(rig.state().openMessage(QUEUE, ref));
    if (!id) throw new Error("Nothing was drafted.");
    return { ref, id };
  };
  const fionaIn = (rig: StoreRig, ref: string) =>
    Object.values(rig.state().cache)
      .flatMap((cache) => cache?.submissions ?? [])
      .find((s) => s.ref === ref);

  it("drafts a message, not a grade, and nothing reaches the LMS until it is approved", async () => {
    const rig = await connected();
    const { ref, id } = await messageFiona(rig);
    expect(rig.state().changes[id]?.content).toMatchObject({
      kind: "message",
      subject: "Sequence Analysis",
      body: expect.stringContaining("Fiona"),
    });
    expect(await rig.clock.run(rig.state().sendChanges([id]))).toEqual([
      { id, refused: "not-sendable" },
    ]);
    expect(rig.server.log.filter((entry) => entry.kind === "write")).toEqual([]);

    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(stateTag(rig, id)).toBe("sent");
    const school = rig.state().changes[id]!.school;
    const started = rig.server.conversations(school).filter((c) => c.from === "Fiona Kerr");
    expect(started.map((c) => [c.subject, c.messages.map((m) => m.mine)])).toEqual([
      ["Sequence Analysis", [true]],
    ]);
    expect(fionaIn(rig, ref)).toMatchObject({ workflow: "missing", grade: null });
  });

  it("a message and a grade on the same submission are separate drafts, and her row shows the grade", async () => {
    const rig = await connected();
    const { ref, id } = await messageFiona(rig);
    const grade = await rig.clock.run(rig.state().openSubmission(QUEUE, ref, { fill: "draft" }));
    expect(grade).not.toBe(id);
    expect(rig.state().changes[grade!]?.content.kind).toBe("grade");
    expect(await rig.clock.run(rig.state().openMessage(QUEUE, ref))).toBe(id);
    const row = selectQueueRows(rig.state(), null, true).find((r) => r.submission.ref === ref);
    expect(row?.change?.id).toBe(grade);
  });

  it("a zero sent to her keeps every row of the list in its place", async () => {
    const rig = await connected();
    const ref = rig.server.findSubmission("Fiona Kerr", "Sequence Analysis")!;
    const assignment = fionaIn(rig, ref)!.assignment;
    const names = () =>
      selectQueueRows(rig.state(), assignment, true).map((row) => row.submission.studentName);
    const before = names();
    expect(before.at(-1)).toBe("Fiona Kerr");
    const id = (await rig.clock.run(rig.state().openSubmission(QUEUE, ref, { fill: "draft" })))!;
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(fionaIn(rig, ref)?.workflow).toBe("graded");
    expect(names()).toEqual(before);
  });

  it("a student missing two assignments gets a message about each, and one sent is not the other", async () => {
    const rig = await connected();
    const missing = Object.values(rig.state().cache)
      .flatMap((cache) => cache?.submissions ?? [])
      .filter((s) => s.workflow === "missing");
    const [first, second] = missing.filter((s) =>
      missing.some((other) => other.student === s.student && other.ref !== s.ref),
    );
    if (!first || !second) throw new Error("The seed has no student missing two assignments.");
    const one = await rig.clock.run(rig.state().openMessage(QUEUE, first.ref));
    const two = await rig.clock.run(rig.state().openMessage(QUEUE, second.ref));
    expect(two).not.toBe(one);
    expect(rig.state().changes[two!]?.content.target).toBe(second.ref);

    approve(rig, two!);
    await rig.clock.run(rig.state().sendChanges([two!]));
    expect(rig.server.observe(rig.state().changes[one!]!.content)).toMatchObject({ messages: [] });
  });

  it("with AI off the message starts blank and can't be approved empty", async () => {
    const rig = await connected({ noKey: true });
    const { id } = await messageFiona(rig);
    const record = rig.state().changes[id] ?? rig.state().blanks[id];
    expect(record?.content).toMatchObject({ kind: "message", body: "" });
    expect(record && summarize(record).canApprove).toBe(false);
  });
});

describe("dispatchUser", () => {
  it("is the only store route to approved, and needs a witness", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    const at = rig.state().changes[id]?.basis.readAt as never;
    expect(
      rig.state().dispatchUser(id, {
        type: "approve",
        witness: { covers: () => true } as unknown as ApprovalWitness,
        at,
      }),
    ).toEqual({ ok: false, error: "stale-approval" });
    expect(stateTag(rig, id)).toBe("draft");
    approve(rig, id);
    expect(stateTag(rig, id)).toBe("approved");
  });

  it("exposes no action that takes a run event or a bare approve", async () => {
    const rig = await makeStoreRig();
    const actions = Object.keys(rig.state()).filter(
      (key) => typeof rig.state()[key as keyof ReturnType<StoreRig["state"]>] === "function",
    );
    expect(actions.filter((name) => /approve|commit|markSent|finish/i.test(name))).toEqual([]);
  });

  it("an edit on an approved change resets it and says so once, on the change, not again in the chat", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    approve(rig, id);
    const before = rig.state().threads[QUEUE]?.messages.length;
    rig.state().dispatchUser(id, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", comment: "Changed." },
      at: rig.state().changes[id]?.basis.readAt as never,
    });
    expect(rig.state().changes[id]?.state).toMatchObject({ tag: "draft", approvalReset: "edited" });
    expect(rig.state().threads[QUEUE]?.messages.length).toBe(before);
  });
});

describe("resolveConflict", () => {
  it("reads the LMS now, rebases the draft, and asks for approval again", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    const target = rig.state().changes[id]?.content.target as LmsRef<"submission">;
    approve(rig, id);
    rig.server.changeGradeOutOfBand(target, 65, "Jordan Pike (TA)");
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(stateTag(rig, id)).toBe("conflicted");
    const result = await rig.clock.run(rig.state().resolveConflict(id, { grade: "keep-mine" }));
    expect(result.ok).toBe(true);
    expect(rig.state().changes[id]?.state).toEqual({ tag: "draft", approvalReset: "rebased" });
    expect(rig.state().previewFor(id)?.[0]?.note).toContain("65");
  });
});

describe("the sync after a send", () => {
  it("reads again when a sync was already out, so it sees what the send just found", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    const target = rig.state().changes[id]?.content.target as LmsRef<"submission">;
    approve(rig, id);
    const early = rig.state().syncSchool(LCC);
    rig.server.changeGradeOutOfBand(target, 65, "Jordan Pike (TA)");
    await rig.clock.run(Promise.all([early, rig.state().sendChanges([id])]));
    const comments =
      rig.state().cache[LCC]?.submissions.find((submission) => submission.ref === target)
        ?.comments ?? [];
    expect(comments.some((comment) => comment.text.includes("Jordan Pike"))).toBe(true);
  });
});

describe("the demo script", () => {
  const scripted = () => connected({ demoScript: true, noise: QUIET_NOISE });

  it("regrades Luis Cardenas's essay once, right after his draft is read", async () => {
    const rig = await scripted();
    const id = await openFor(rig, DEMO_CONFLICT.student);
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(stateTag(rig, id)).toBe("conflicted");
    expect(rig.server.demoScript().fired).toContain("conflict");
    await rig.clock.run(rig.state().resolveConflict(id, { grade: "keep-mine" }));
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(stateTag(rig, id)).toBe("sent");
  });

  it("makes Priya Raman's comment fail once after her grade lands, and a retry finishes", async () => {
    const rig = await scripted();
    const id = await openFor(rig, DEMO_PARTIAL.student);
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(stateTag(rig, id)).toBe("held");
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(stateTag(rig, id)).toBe("sent");
    const target = rig.state().changes[id]?.content.target;
    expect(
      rig
        .state()
        .cache[LCC]?.submissions.find((s) => s.ref === target)
        ?.comments.filter((c) => c.mine),
    ).toHaveLength(1);
  });

  it("throttles an early write once", async () => {
    const rig = await scripted();
    const first = await openFor(rig, "Maya Ortiz");
    approve(rig, first);
    await rig.clock.run(rig.state().sendChanges([first]));
    rig.server.log.length = 0;
    const second =
      rig.server.findSubmission("Tomas Becker", "Essay 2") ??
      rig
        .state()
        .cache[LCC]?.submissions.find(
          (s) =>
            s.workflow === "submitted" &&
            s.studentName !== DEMO_CONFLICT.student &&
            s.studentName !== DEMO_PARTIAL.student,
        )?.ref;
    if (!second) throw new Error("No second submission.");
    const id = await rig.clock.run(rig.state().openSubmission(QUEUE, second, { fill: "draft" }));
    if (!id) throw new Error("Nothing drafted.");
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(rig.server.demoScript().fired).toContain("throttle");
    expect(stateTag(rig, id)).toBe("sent");
  });

  it("switched off, none of them fire", async () => {
    const rig = await scripted();
    rig.server.setDemoScript(false);
    const luis = await openFor(rig, DEMO_CONFLICT.student);
    const priya = await openFor(rig, DEMO_PARTIAL.student);
    approve(rig, luis);
    approve(rig, priya);
    await rig.clock.run(rig.state().sendChanges([luis, priya]));
    expect(stateTag(rig, luis)).toBe("sent");
    expect(stateTag(rig, priya)).toBe("sent");
    expect(rig.server.demoScript().fired).toEqual([]);
  });
});

describe("selectors", () => {
  it("the queue holds the mockup's 32 ungraded submissions at seed", async () => {
    const rig = await connected();
    expect(selectQueueRows(rig.state())).toHaveLength(32);
  });

  it("the queue is sorted by due date, then most late, then name", async () => {
    const rig = await connected();
    const rows = selectQueueRows(rig.state());
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1], rows[i]];
      if (!a || !b) continue;
      const dueA = new Date(a.assignment.dueAt ?? 0).getTime();
      const dueB = new Date(b.assignment.dueAt ?? 0).getTime();
      expect(dueA).toBeLessThanOrEqual(dueB);
      if (dueA === dueB && a.submission.lateDays === b.submission.lateDays)
        expect(
          a.submission.studentName.localeCompare(b.submission.studentName),
        ).toBeLessThanOrEqual(0);
      if (dueA === dueB)
        expect(a.submission.lateDays).toBeGreaterThanOrEqual(b.submission.lateDays);
    }
  });

  it("a graded row stays as done after its send", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    const rows = selectQueueRows(rig.state());
    expect(rows).toHaveLength(32);
    expect(rows.filter((row) => !row.open)).toHaveLength(1);
    expect(rows.find((row) => row.change?.id === id)?.summary?.label).toBe("Sent");
  });

  it("an assignment's grading list ends with its missing students, and no count of work to grade includes them", async () => {
    const rig = await connected();
    const fiona = rig.server.findSubmission("Fiona Kerr", "Sequence Analysis");
    const all = selectQueueRows(rig.state());
    const assignment = all.find((row) => row.assignment.title === "Sequence Analysis")?.assignment
      .ref as LmsRef<"assignment">;
    const listed = selectQueueRows(rig.state(), assignment, true);
    expect(listed.at(-1)).toMatchObject({ missing: true, open: true });
    expect(listed.at(-1)?.submission.ref).toBe(fiona);
    expect(selectQueueRows(rig.state(), assignment).some((row) => row.missing)).toBe(false);
    expect(all).toHaveLength(32);
  });

  it("the queue narrows to one assignment", async () => {
    const rig = await connected();
    const assignment = selectQueueRows(rig.state())[0]?.assignment.ref as LmsRef<"assignment">;
    const rows = selectQueueRows(rig.state(), assignment);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.assignment.ref === assignment)).toBe(true);
  });

  it("selectors return the same object for the same state, so a zustand hook cannot loop", async () => {
    const rig = await connected();
    const state = rig.state();
    const now = state.now();
    expect(selectQueueRows(state)).toBe(selectQueueRows(state));
    expect(selectInboxRows(state)).toBe(selectInboxRows(state));
    expect(selectWhatsDue(state, now)).toBe(selectWhatsDue(state, now + 1));
    expect(selectCalendar(state, now)).toBe(selectCalendar(state, now + 1));
    const course = state.cache[LCC]?.courses[0]?.ref as LmsRef<"course">;
    expect(selectGradebook(state, course)).toBe(selectGradebook(state, course));
    expect(selectCourseOverview(state, course, now)).toBe(
      selectCourseOverview(state, course, now + 1),
    );
    expect(selectThreadStatus(state, QUEUE)).toBe(selectThreadStatus(state, QUEUE));
  });

  it("what's due groups past due work ahead of what's coming", async () => {
    const rig = await connected();
    const groups = selectWhatsDue(rig.state(), rig.state().now());
    expect(groups[0]?.key).toBe("past");
    expect(groups.map((group) => group.key)).toContain("week");
    expect(
      groups
        .flatMap((group) => group.items)
        .every((item) => item.toGrade > 0 || (item.days !== null && item.days >= 0)),
    ).toBe(true);
  });

  it("the calendar holds every dated assignment, including past graded ones What's due drops", async () => {
    const rig = await connected();
    const state = rig.state();
    const now = state.now();
    const { items, undated, today } = selectCalendar(state, now);
    const dueRefs = selectWhatsDue(state, now)
      .flatMap((group) => group.items)
      .map((item) => item.assignment.ref);
    const closed = items.filter((item) => item.days < 0 && item.toGrade === 0);

    expect(items).toHaveLength(19);
    expect(undated).toBe(0);
    expect(today).toBe(new Date(now).setHours(0, 0, 0, 0));
    expect(closed.length).toBeGreaterThan(0);
    expect(dueRefs).toHaveLength(19 - closed.length);
    expect(dueRefs).toEqual(
      items.filter((item) => !closed.includes(item)).map((item) => item.assignment.ref),
    );
    const dueTimes = items.map((item) => item.assignment.dueAt ?? "");
    expect(dueTimes).toEqual([...dueTimes].sort());
  });

  it("an assignment with no due date is counted, not listed", async () => {
    const rig = await connected();
    const state = rig.state();
    const cache = state.cache[LCC];
    if (!cache) throw new Error("No cache.");
    const [first, ...rest] = cache.assignments;
    if (!first) throw new Error("No assignment.");
    const { items, undated } = selectCalendar(
      {
        ...state,
        cache: {
          ...state.cache,
          [LCC]: { ...cache, assignments: [{ ...first, dueAt: null }, ...rest] },
        },
      },
      state.now(),
    );
    expect(undated).toBe(1);
    expect(items.map((item) => item.assignment.ref)).not.toContain(first.ref);
  });

  it("calendar lanes keep every course, even one with no assignments", async () => {
    const rig = await connected();
    const state = rig.state();
    const cache = state.cache[LCC];
    if (!cache) throw new Error("No cache.");
    const quiet = cache.courses[0];
    if (!quiet) throw new Error("No course.");
    const calendar = selectCalendar(
      {
        ...state,
        cache: {
          ...state.cache,
          [LCC]: { ...cache, assignments: cache.assignments.filter((a) => a.course !== quiet.ref) },
        },
      },
      state.now(),
    );
    expect(calendar.lanes.map((lane) => lane.school.id)).toEqual(
      state.schools.map((school) => school.id),
    );
    expect(calendar.lanes.find((lane) => lane.school.id === LCC)?.courses).toContain(quiet);
    expect(calendar.items.some((item) => item.course.ref === quiet.ref)).toBe(false);
  });

  it("the inbox merges both schools, newest first", async () => {
    const rig = await connected();
    const rows = selectInboxRows(rig.state());
    expect(new Set(rows.map((row) => row.school.id)).size).toBe(2);
    const times = rows.map((row) => row.last?.at ?? "");
    expect(times).toEqual([...times].sort().reverse());
  });

  it("the gradebook has a row per student and a cell per assignment", async () => {
    const rig = await connected();
    const course = rig.state().cache[LCC]?.courses[0];
    if (!course) throw new Error("No course.");
    const book = selectGradebook(rig.state(), course.ref);
    expect(book?.rows).toHaveLength(course.studentCount);
    for (const row of book?.rows ?? [])
      expect(row.cells).toHaveLength(book?.assignments.length ?? 0);
  });

  it("the gradebook shows a pending change beside the LMS grade, not instead of it", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    const change = rig.state().changes[id];
    const book = selectGradebook(rig.state(), change?.course as LmsRef<"course">);
    const cell = book?.rows
      .flatMap((row) => row.cells)
      .find((c) => c.submission?.ref === change?.content.target);
    expect(cell?.grade).toBeNull();
    expect(cell?.pending?.label).toBe("AI draft. Not sent");
  });

  it("the course overview counts what needs doing", async () => {
    const rig = await connected();
    const course = rig.state().cache[LCC]?.courses[0];
    if (!course) throw new Error("No course.");
    const overview = selectCourseOverview(rig.state(), course.ref, rig.state().now());
    expect(overview?.toGrade).toBeGreaterThan(0);
    expect(overview?.unread).toBeGreaterThan(0);
    expect(overview?.lastAnnouncement).not.toBeNull();
    expect(overview?.classAverage).not.toBeNull();
  });

  it("a course with no due dates still leads to its work to grade, oldest submission first", async () => {
    const rig = await connected();
    const course = rig.state().cache[LCC]?.courses.find((c) => c.code === "ENG 101");
    if (!course) throw new Error("No ENG 101.");
    rig.server.clearDueDates(course.ref);
    expect(await rig.state().syncSchool(LCC)).toBe(true);
    const overview = selectCourseOverview(rig.state(), course.ref, rig.state().now());
    const waiting = overview?.needsYou.flatMap((item) =>
      item.kind === "assignment" ? [[item.item.assignment.shortTitle, item.item.toGrade]] : [],
    );
    expect(waiting).toEqual([
      ["Essay 2", 5],
      ["Reading Response 6", 2],
    ]);
    expect(overview?.toGrade).toBe(7);
    expect(overview?.assignments[0]?.assignment.shortTitle).toBe("Essay 2");
    expect(overview?.dueThisWeek).toBe(0);
  });

  it("What's due lists undated work to grade after every dated group", async () => {
    const rig = await connected();
    const state = rig.state();
    const cache = state.cache[LCC];
    const essay = cache?.assignments.find((a) => a.shortTitle === "Essay 2");
    if (!cache || !essay) throw new Error("No Essay 2.");
    const groups = selectWhatsDue(
      {
        ...state,
        cache: {
          ...state.cache,
          [LCC]: {
            ...cache,
            assignments: cache.assignments.map((a) => (a === essay ? { ...a, dueAt: null } : a)),
          },
        },
      },
      state.now(),
    );
    expect(groups.at(-1)?.key).toBe("undated");
    expect(groups.at(-1)?.items.map((item) => [item.assignment.ref, item.days])).toEqual([
      [essay.ref, null],
    ]);
    expect(groups.slice(0, -1).flatMap((group) => group.items).length).toBeGreaterThan(0);
  });

  it("a collapsed course counts a grade once as it moves from to-grade to ready to send", async () => {
    const rig = await connected();
    const grading = Object.values(rig.state().threads).find(
      (thread) => thread.kind === "grading" && thread.title.includes("Essay 2"),
    );
    const course = grading?.course;
    if (!course) throw new Error("No grading thread.");
    const before = selectCourseWaiting(rig.state(), course);
    const id = await openFor(rig, "Maya Ortiz");
    const drafted = selectCourseWaiting(rig.state(), course);
    expect({ grade: drafted.grade, approval: drafted.approval }).toEqual({
      grade: before.grade - 1,
      approval: before.approval + 1,
    });
    approve(rig, id);
    const approved = selectCourseWaiting(rig.state(), course);
    expect({ grade: approved.grade, approval: approved.approval, ready: approved.ready }).toEqual({
      grade: before.grade - 1,
      approval: before.approval,
      ready: 1,
    });
    const school = rig.state().changes[id]?.school as SchoolId;
    const siblings = rig.state().cache[school]?.courses ?? [];
    expect(selectSchoolWaiting(rig.state(), school).ready).toBe(
      siblings.reduce(
        (total, sibling) => total + selectCourseWaiting(rig.state(), sibling.ref).ready,
        0,
      ),
    );
  });

  it("thread status follows the change through its life", async () => {
    const rig = await connected();
    const grading = Object.values(rig.state().threads).find(
      (thread) => thread.kind === "grading" && thread.title.includes("Essay 2"),
    );
    if (!grading) throw new Error("No grading thread.");
    expect(selectThreadStatus(rig.state(), grading.id)?.label).toMatch(/to grade$/);
    const id = await openFor(rig, "Maya Ortiz");
    expect(selectThreadStatus(rig.state(), grading.id)?.label).toBe("AI draft. Not sent");
    approve(rig, id);
    expect(selectThreadStatus(rig.state(), grading.id)?.label).toBe("Ready to send");
    rig.server.changeGradeOutOfBand(
      rig.state().changes[id]?.content.target as LmsRef<"submission">,
      65,
      "TA",
    );
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(selectThreadStatus(rig.state(), grading.id)?.label).toBe("Needs attention");
  });

  it("a general thread has no status pill", async () => {
    const rig = await connected();
    expect(selectThreadStatus(rig.state(), "t-general" as ThreadId)).toBeNull();
  });

  it("an agent run marks its thread as working", async () => {
    const rig = await connected();
    let during: unknown = null;
    const unsubscribe = rig.store.subscribe((state) => {
      if (state.working[QUEUE]) during = selectThreadStatus(state, QUEUE);
    });
    await openFor(rig, "Maya Ortiz");
    unsubscribe();
    expect(during).toMatchObject({ label: "Working" });
    expect(rig.state().working[QUEUE]).toBe(false);
  });
});

describe("seeded threads", () => {
  it("has the mockup's threads plus North Star, the grading list, a general one, and the inbox", async () => {
    const rig = await makeStoreRig();
    const { threads } = rig.state();
    const expected = SEED.courses.flatMap((course) => course.threads.map((thread) => thread.id));
    for (const id of expected) expect(threads[id as ThreadId], id).toBeDefined();
    expect(Object.keys(threads)).toHaveLength(expected.length + 4);
    expect(threads[QUEUE]?.kind).toBe("queue");
    expect(Object.values(threads).filter((thread) => thread.kind === "general")).toHaveLength(1);
  });

  it("no seeded thread puts words in the person's mouth, and none names a host", async () => {
    const rig = await makeStoreRig();
    const seeded = Object.values(rig.state().threads).flatMap((thread) => thread.messages);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.filter((message) => message.type === "user")).toEqual([]);
    expect(JSON.stringify(seeded)).not.toContain("instructure.com");
  });

  it("the queue thread names no count or school, because it can't know which ones get connected", async () => {
    const rig = await makeStoreRig();
    const text = JSON.stringify(rig.state().threads[QUEUE]?.messages);
    expect(text).not.toMatch(/\b32\b|Riverbend|Lakeshore|both schools/);
  });

  it("createThread adds one to a course", async () => {
    const rig = await connected();
    const course = rig.state().cache[LCC]?.courses[0]?.ref as LmsRef<"course">;
    const id = rig
      .state()
      .createThread({ kind: "general", school: LCC, course, title: "Ask about office hours" });
    expect(rig.state().threads[id]).toMatchObject({
      kind: "general",
      course,
      title: "Ask about office hours",
      focus: null,
      messages: [],
    });
  });
});

describe("the store's preview", () => {
  it("lists each field with the provider's comment effect", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    const record = rig.state().changes[id];
    if (!record) throw new Error("No change.");
    const preview = rig.state().previewFor(id);
    expect(preview?.map((field) => field.field)).toContain("grade");
    expect(preview).toEqual(previewOf(record, "append"));
  });

  it("what the preview shows is what the LMS holds after the send", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    const shown = rig.state().previewFor(id);
    const grade = shown?.find((field) => field.field === "grade")?.body;
    const feedback = shown?.find((field) => field.field === "comment")?.body;
    if (grade?.kind !== "grade" || feedback?.kind !== "text")
      throw new Error("No grade or feedback in the preview.");
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(stateTag(rig, id)).toBe("sent");
    const content = rig.state().changes[id]?.content;
    if (!content) throw new Error("No change.");
    const remote = rig.server.observe(content);
    if (remote?.kind !== "grade") throw new Error("No grade in the LMS.");
    expect(remote.grade).toBe(grade.points);
    expect(
      remote.comments.filter((comment) => comment.mine).map((comment) => comment.text),
    ).toContain(feedback.text);
  });

  it("an edit changes the preview and needs a fresh approval before it can send", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    approve(rig, id);
    expect(stateTag(rig, id)).toBe("approved");
    const result = rig.state().dispatchUser(id, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", comment: "Changed after approving." },
      at: new Date(rig.state().now()).toISOString() as IsoTime,
    });
    expect(result.ok).toBe(true);
    expect(stateTag(rig, id)).toBe("draft");
    const body = rig
      .state()
      .previewFor(id)
      ?.find((field) => field.field === "comment")?.body;
    expect(body).toEqual({ kind: "text", title: null, text: "Changed after approving." });
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(rig.server.log.filter((entry) => entry.kind === "write")).toEqual([]);
  });
});

describe("replacing a token", () => {
  it("a refused replacement keeps the working token and says so", async () => {
    const rig = await connected();
    await rig.connect(LCC, "older-token-that-was-revoked-long-ago");
    rig.server.expireToken(LCC);
    await rig.connect(LCC, "working-token-long-enough-to-pass");
    const result = await rig.connect(LCC, "older-token-that-was-revoked-long-ago");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("still in use") });
    expect(rig.state().connections[LCC]?.status).toBe("connected");
    expect(await rig.clock.run(rig.state().syncSchool(LCC))).toBe(true);
  });

  it("an unreachable LMS during a replacement keeps the working token", async () => {
    const rig = await connected();
    rig.server.setNoise({ rate5xx: 1 });
    const result = await rig.connect(LCC, "another-token-long-enough-to-pass");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("still in use") });
    rig.server.setNoise({ rate5xx: 0 });
    expect(rig.state().connections[LCC]?.status).toBe("connected");
    expect(await rig.clock.run(rig.state().syncSchool(LCC))).toBe(true);
  });

  it("a refused reconnect leaves the school expired, and a reload does not call it disconnected", async () => {
    const rig = await connected();
    await rig.connect(LCC, "revoked-token-long-enough-to-pass");
    rig.server.expireToken(LCC);
    await rig.clock.run(rig.state().syncSchool(LCC));
    expect(rig.state().connections[LCC]?.status).toBe("expired");
    expect((await rig.connect(LCC, "revoked-token-long-enough-to-pass")).ok).toBe(false);
    expect(rig.state().connections[LCC]?.status).toBe("expired");
    const second = await makeStoreRig({ storage: rig.storage, vault: rig.vault, clock: rig.clock });
    await second.clock.run(second.state().boot());
    expect(second.state().connections[LCC]?.status).toBe("expired");
  });
});

describe("connect progress", () => {
  it("reports each stage as it starts, in order", async () => {
    const rig = await connected();
    const stages: string[] = [];
    await rig.clock.run(
      rig.state().connect(LCC, new Secret(STORE_TOKEN), (stage) => stages.push(stage)),
    );
    expect(stages).toEqual(["saving", "checking", "reading"]);
  });

  it("stops at checking when the token is refused", async () => {
    const rig = await connected();
    rig.server.setNoise({ rate5xx: 1 });
    const stages: string[] = [];
    await rig.clock.run(
      rig.state().connect(LCC, new Secret(STORE_TOKEN), (stage) => stages.push(stage)),
    );
    expect(stages).toEqual(["saving", "checking"]);
  });

  it("a too short token reports no stage and keeps the saved one", async () => {
    const rig = await connected();
    const stages: string[] = [];
    await rig.clock.run(
      rig.state().connect(LCC, new Secret("short"), (stage) => stages.push(stage)),
    );
    expect(stages).toEqual([]);
    expect(rig.state().connections[LCC]?.status).toBe("connected");
  });
});

describe("syncing", () => {
  it("is on while a sync runs, off after, and not persisted", async () => {
    const rig = await connected();
    const run = rig.state().syncSchool(LCC);
    expect(rig.state().syncing[LCC]).toBe(true);
    await rig.clock.run(run);
    expect(rig.state().syncing[LCC]).toBe(false);
    expect(
      JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}").state.syncing,
    ).toBeUndefined();
  });

  it("a sync that answers after a disconnect does not bring the school back", async () => {
    const rig = await connected({ noise: { ...QUIET_NOISE, latencyMs: [50, 50] } });
    const run = rig.state().syncSchool(LCC);
    await rig.state().disconnect(LCC);
    await rig.clock.run(run);
    expect(rig.state().cache[LCC]).toBeUndefined();
    expect(rig.state().connections[LCC]?.status).toBe("disconnected");
  });

  it("boot finishes a first sync a reload interrupted", async () => {
    const rig = await connected();
    rig.store.setState({
      cache: {},
      connections: {
        ...rig.state().connections,
        [LCC]: { ...rig.state().connections[LCC], lastSyncedAt: null } as ConnectionRecord,
      },
    });
    const second = await makeStoreRig({ storage: rig.storage, vault: rig.vault, clock: rig.clock });
    await second.clock.run(second.state().boot());
    await second.clock.run(second.clock.sleep(10));
    expect(second.state().cache[LCC]?.courses.length).toBeGreaterThan(0);
  });

  it("boot forgets a token whose connect never finished", async () => {
    const rig = await makeStoreRig();
    await rig.vault.enroll(LCC, { kind: "bearer", token: new Secret(STORE_TOKEN) });
    await rig.clock.run(rig.state().boot());
    expect(await rig.vault.has(LCC)).toBe(false);
  });
});

describe("the AI key and scopes", () => {
  it("removing the key forgets it and clears the status", async () => {
    const rig = await makeStoreRig();
    await rig.state().addAiKey(new Secret(STORE_TOKEN));
    await rig.state().turnOffAi();
    expect(rig.state().aiSource).toBe("none");
    expect(await rig.vault.has("ai-key")).toBe(false);
  });

  it("scopes come back in plain words, with no routes in them", async () => {
    const rig = await connected();
    const words = rig.state().scopeWordsFor(LCC);
    expect(words).toContain("Post grades and comments");
    expect(words.join()).not.toMatch(/api|url:/);
  });
});

const sendOne = async (rig: StoreRig, name: string) => {
  const id = await openFor(rig, name);
  approve(rig, id);
  await rig.clock.run(rig.state().sendChanges([id]));
  return id;
};

describe("the writes log", () => {
  it("stays empty until an approved send, then names what landed and none of its content", async () => {
    const rig = await connected();
    const id = await openFor(rig, "Maya Ortiz");
    expect(rig.server.writes()).toEqual([]);
    approve(rig, id);
    expect(rig.server.writes()).toEqual([]);
    await rig.clock.run(rig.state().sendChanges([id]));
    const [write] = rig.server.writes();
    expect(write).toMatchObject({ school: LCC, target: expect.stringContaining("Maya Ortiz") });
    expect(write?.fields.length).toBeGreaterThan(0);
    const record = rig.state().changes[id];
    if (record?.content.kind !== "grade" || !record.content.comment)
      throw new Error("Expected a comment to check against.");
    expect(JSON.stringify(rig.server.writes())).not.toContain(record.content.comment);
  });

  it("leaves out a field that failed", async () => {
    const rig = await connected();
    rig.server.failNextWrite("comment", { kind: "unavailable", status: 500 });
    await sendOne(rig, "Maya Ortiz");
    expect(rig.server.writes()[0]?.fields).not.toContain("comment");
  });

  it("counts a write whose response was lost, because it did land", async () => {
    const rig = await connected();
    rig.server.loseNextResponse(true);
    await sendOne(rig, "Maya Ortiz");
    expect(rig.server.writes().length).toBeGreaterThan(0);
  });

  it("survives a reload and is emptied by a reset", async () => {
    const rig = await connected();
    await sendOne(rig, "Maya Ortiz");
    const second = await makeStoreRig({ storage: rig.storage, vault: rig.vault, clock: rig.clock });
    expect(second.server.writes().length).toBeGreaterThan(0);
    await second.state().resetDemoData();
    expect(second.server.writes()).toEqual([]);
  });
});

describe("the failure lab", () => {
  it("shows a fault as armed until it fires, and tells subscribers", async () => {
    const rig = await connected();
    const heard = vi.fn();
    const stop = rig.server.subscribe(heard);
    rig.server.throttleNext(100, "write");
    expect(rig.server.armed().throttles).toBe(1);
    expect(heard).toHaveBeenCalled();
    const version = rig.server.version();
    await sendOne(rig, "Maya Ortiz");
    expect(rig.server.armed().throttles).toBe(0);
    expect(rig.server.version()).toBeGreaterThan(version);
    stop();
  });

  it("a reset clears anything armed and puts the noise back", async () => {
    const rig = await connected();
    rig.server.loseNextResponse();
    rig.server.setNoise({ rate5xx: 0.5 });
    await rig.state().resetDemoData();
    expect(rig.server.armed()).toEqual({ failedFields: [], lostResponses: 0, throttles: 0 });
    expect(rig.server.noise().rate5xx).toBe(0);
  });

  it("a fresh user starts with no random failures and the demo script off", () => {
    const server = new FakeCanvasServer({
      storage: memoryStorage(),
      now: () => 0,
      sleep: async () => {},
      random: () => 0.5,
    });
    expect(server.noise()).toMatchObject({ rate429: 0, rate5xx: 0, rateLost: 0 });
    expect(server.demoScript().enabled).toBe(false);
  });

  it("noise changed in Settings survives a reload", async () => {
    const storage = memoryStorage();
    const make = () =>
      new FakeCanvasServer({ storage, now: () => 0, sleep: async () => {}, random: () => 0.5 });
    make().setNoise({ rate5xx: 0.25 });
    expect(make().noise().rate5xx).toBe(0.25);
    expect(
      new FakeCanvasServer({
        storage,
        now: () => 0,
        sleep: async () => {},
        random: () => 0.5,
        noise: { rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [0, 0] },
      }).noise().rate5xx,
    ).toBe(0);
  });

  it.each<[string, (stored: Record<string, unknown>) => void]>([
    ["a collection that isn't a list", (stored) => (stored["courses"] = "nope")],
    ["no demo script", (stored) => delete stored["script"]],
    ["another version", (stored) => (stored["version"] = 1)],
  ])("a stored LMS with %s starts fresh instead of loading it", (_name, corrupt) => {
    const storage = memoryStorage();
    const make = () =>
      new FakeCanvasServer({ storage, now: () => 0, sleep: async () => {}, random: () => 0.5 });
    make().setNoise({ rate5xx: 0.25 });
    const stored = JSON.parse(storage.getItem(LMS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    corrupt(stored);
    storage.setItem(LMS_STORAGE_KEY, JSON.stringify(stored));
    expect(make().noise().rate5xx).toBe(0);
  });

  it("a stored LMS from before the write log and the new term keeps everything else", () => {
    const storage = memoryStorage();
    const make = () =>
      new FakeCanvasServer({ storage, now: () => 0, sleep: async () => {}, random: () => 0.5 });
    make().setNoise({ rate5xx: 0.25 });
    const stored = JSON.parse(storage.getItem(LMS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    delete stored["writeLog"];
    delete stored["term"];
    storage.setItem(LMS_STORAGE_KEY, JSON.stringify(stored));
    expect(make().noise().rate5xx).toBe(0.25);
  });
});

describe("missing work", () => {
  it("work with nothing turned in reads as missing once its due date passes, as Canvas does", () => {
    const at = (now: number) =>
      new FakeCanvasServer({
        storage: memoryStorage(),
        now: () => now,
        sleep: async () => {},
        random: () => 0.5,
      });
    const lms = at(0);
    const course = SEED.schools
      .flatMap((school) => lms.courses(school.id as SchoolId))
      .find((c) => c.code === "ENG 101")!;
    const assignment = lms.assignments(course.ref).find((a) => a.title === "Reading Response 6")!;
    const workflows = (now: number) =>
      at(now)
        .submissions(course.ref)
        .filter((s) => s.assignment === assignment.ref)
        .map((s) => s.workflow);
    const due = Date.parse(assignment.dueAt!);
    expect(workflows(due - 1)).toContain("unsubmitted");
    expect(workflows(due + 1)).not.toContain("unsubmitted");
    expect(workflows(due + 1).filter((w) => w === "missing")).toHaveLength(
      workflows(due - 1).filter((w) => w === "unsubmitted" || w === "missing").length,
    );
  });

  const missingOn = (rig: StoreRig, rubric: boolean) => {
    for (const school of [LCC, RSU])
      for (const course of rig.server.courses(school)) {
        const assignments = rig.server.assignments(course.ref);
        const found = rig.server
          .submissions(course.ref)
          .find(
            (s) =>
              s.workflow === "missing" &&
              Boolean(assignments.find((a) => a.ref === s.assignment)?.rubric) === rubric,
          );
        if (found) return { school, submission: found };
      }
    throw new Error("No missing submission to work with.");
  };

  const sendMissing = async (
    rig: StoreRig,
    rubric: boolean,
    patch: (id: ChangeId) => ChangePatch,
  ) => {
    const { school, submission } = missingOn(rig, rubric);
    const missingBefore = selectCourseOverview(
      rig.state(),
      submission.course,
      rig.state().now(),
    )?.missing;
    const id = await rig.clock.run(
      rig.state().openSubmission(QUEUE, submission.ref, { fill: "draft" }),
    );
    if (!id) throw new Error("Nothing was drafted.");
    const edited = rig.state().dispatchUser(id, {
      type: "edit",
      by: "you",
      patch: patch(id),
      at: new Date(rig.state().now()).toISOString() as IsoTime,
    });
    expect(edited.ok).toBe(true);
    approve(rig, id);
    await rig.clock.run(rig.state().sendChanges([id]));
    expect(stateTag(rig, id)).toBe("sent");
    await rig.clock.run(rig.state().syncSchool(school));
    const after = rig.server.submissions(submission.course).find((s) => s.ref === submission.ref);
    const missingAfter = selectCourseOverview(
      rig.state(),
      submission.course,
      rig.state().now(),
    )?.missing;
    expect(missingAfter).toBe((missingBefore ?? 0) - 1);
    return after;
  };

  it("excusing a missing student sends the excuse, and they are no longer missing", async () => {
    const rig = await connected({ noKey: true });
    const after = await sendMissing(rig, false, () => ({ kind: "grade", excused: true }));
    expect(after).toMatchObject({ workflow: "excused", grade: null });
  });

  it("Zero on a missing rubric assignment with AI off sends 0 on every criterion", async () => {
    const rig = await connected({ noKey: true });
    const after = await sendMissing(rig, true, (id) => {
      const content = rig.state().blanks[id]?.content;
      if (content?.kind !== "grade") throw new Error("Not a grade.");
      return zeroPatch(content);
    });
    expect(after).toMatchObject({ workflow: "graded", grade: 0 });
    expect(Object.values(after?.rubricScores ?? {}).every((points) => points === 0)).toBe(true);
    expect(Object.keys(after?.rubricScores ?? {}).length).toBeGreaterThan(0);
  });
});
