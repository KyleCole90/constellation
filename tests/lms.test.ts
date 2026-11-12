import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createFileStorage } from "~/main/lms";
import type { LmsRef } from "~/shared/domain/ids";
import { invoker } from "~/shared/ipc";

import { bridgedLms } from "./fixtures/bridge";
import { LCC } from "./fixtures/rig";

const dirs: string[] = [];
const storageFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "lms-storage-"));
  dirs.push(dir);
  return join(dir, "lms.json");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("main's file-backed storage", () => {
  it("keeps what was set across a restart, and forgets what was removed", () => {
    const file = storageFile();
    const first = createFileStorage(file);
    first.setItem("a", "1");
    first.setItem("b", "2");
    first.removeItem("a");
    const second = createFileStorage(file);
    expect(second.getItem("a")).toBeNull();
    expect(second.getItem("b")).toBe("2");
  });

  it("reads a damaged file as empty and keeps it aside", () => {
    const file = storageFile();
    writeFileSync(file, '{"b": 2');
    const storage = createFileStorage(file);
    expect(storage.getItem("b")).toBeNull();
    expect(readFileSync(`${file}.bad`, "utf8")).toBe('{"b": 2');
    storage.setItem("b", "3");
    expect(createFileStorage(file).getItem("b")).toBe("3");
  });

  it("reads a file of the wrong shape as empty", () => {
    const file = storageFile();
    writeFileSync(file, '{"b": 2}');
    expect(createFileStorage(file).getItem("b")).toBeNull();
    expect(existsSync(`${file}.bad`)).toBe(true);
  });
});

describe("the lms channels", () => {
  it("reach main's fake with main's token, so the renderer's lease goes unused", async () => {
    const lms = bridgedLms();
    await lms.connect(LCC);
    const courses = await lms.provider(LCC).courses();
    expect(courses.ok && courses.value.length).toBeGreaterThan(0);
  });

  it.each([
    ["lms.courses", {}],
    ["lms.courses", { school: "lcc" }],
    [
      "lms.assignments",
      { school: { id: "lcc", abbr: "LCC", name: "L", host: "l.edu", provider: "fake-canvas" } },
    ],
    [
      "lms.observe",
      {
        school: { id: "lcc", abbr: "LCC", name: "L", host: "l.edu", provider: "fake-canvas" },
        content: { kind: "delete-course" },
      },
    ],
    ["lms.lab", { do: "dropTables" }],
    ["lms.lab", { do: "setNoise", patch: { rate5xx: "all" } }],
  ])("main rejects %s with a bad input %j", async (channel, input) => {
    const lms = bridgedLms();
    await expect(lms.call(channel, input)).rejects.toThrow();
  });

  it("the renderer rejects a course list that doesn't parse", async () => {
    const invoke = invoker(async () => ({ ok: true, value: [{ ref: "lcc:course:1" }] }));
    await expect(
      invoke("lms.courses", {
        school: {
          id: LCC,
          abbr: "LCC",
          name: "Lakeshore",
          host: "l.edu" as never,
          provider: "fake-canvas",
        },
      }),
    ).rejects.toThrow();
  });

  it("a provider read over a bridge that fails reads as the LMS being unavailable", async () => {
    const lms = bridgedLms();
    await lms.connect(LCC);
    const provider = lms.provider(LCC);
    lms.listeners.delete("lms.courses");
    expect(await provider.courses()).toEqual({
      ok: false,
      error: { kind: "unavailable", status: null },
    });
  });

  it("the lab follows main's state whenever it moves", async () => {
    const lms = bridgedLms();
    const seen: number[] = [];
    lms.lab.subscribe(() => seen.push(lms.lab.noise().rate5xx));
    lms.lab.setNoise({ rate5xx: 0.5 });
    await lms.clock.flush();
    expect(lms.server.noise().rate5xx).toBe(0.5);
    expect(lms.lab.noise().rate5xx).toBe(0.5);
    expect(seen).toContain(0.5);
  });

  it("a reload, as a fresh renderer sends, clears what was armed but keeps what was stored", async () => {
    const lms = bridgedLms();
    await lms.connect(LCC);
    lms.lab.loseNextResponse();
    await lms.clock.flush();
    expect(lms.lab.armed().lostResponses).toBe(1);
    const stored = await lms.server.stored();
    await lms.call("lms.lab", { do: "reload" });
    await lms.clock.flush();
    expect(lms.lab.armed().lostResponses).toBe(0);
    expect(await lms.server.stored()).toBe(stored);
  });

  it("an unpackaged app answers verify's reads", async () => {
    const lms = bridgedLms();
    await lms.connect(LCC);
    expect(await lms.lab.stored()).toBe(await lms.server.stored());
    const ref = lms.server.findSubmission("Maya Ortiz", "Essay 2");
    expect(ref).not.toBeNull();
    expect(await lms.lab.findSubmission("Maya Ortiz", "Essay 2")).toBe(ref);
  });

  it("a packaged app refuses verify's reads", async () => {
    const lms = bridgedLms({ packaged: true });
    await lms.connect(LCC);
    expect(await lms.server.stored()).toContain('"version":1');
    await expect(lms.lab.stored()).rejects.toThrow();
    await expect(lms.lab.findSubmission("Maya Ortiz", "Essay 2")).rejects.toThrow();
  });

  it("main's fake keeps the app's demo clock", async () => {
    const lms = bridgedLms();
    await lms.connect(LCC);
    const submission = lms.server.findSubmission("Maya Ortiz", "Essay 2") as LmsRef<"submission">;
    lms.lab.changeGradeOutOfBand(submission, 65, "A TA");
    await lms.clock.flush();
    const stored = JSON.parse((await lms.server.stored()) ?? "{}") as {
      submissions: { ref: string; comments: { at: string }[] }[];
    };
    const at = stored.submissions.find((entry) => entry.ref === submission)?.comments.at(-1)?.at;
    expect(Math.abs(Date.parse(at ?? "") - lms.clock.now())).toBeLessThan(1000);
  });
});
