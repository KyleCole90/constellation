import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { canvasSchoolAt, createCanvasProvider } from "~/main/providers/canvas";
import {
  copySignature,
  type CourseCopyContent,
  type RemoteState,
  type SetContent,
} from "~/shared/domain/change";
import type { LmsRef } from "~/shared/domain/ids";
import { mintSendPermit } from "~/shared/domain/permit";
import { copyMigration } from "~/shared/domain/setup";
import { CANVAS, CANVAS_FACE } from "~/shared/providers/canvas";
import { FAKE_SCHOOLS } from "~/shared/providers/fake-canvas/provider";
import { Secret, type LmsProvider, type TermSetup } from "~/shared/providers/provider";
import { bridgeCanvas } from "~/renderer/providers/lms";
import { createMemoryVault } from "~/renderer/providers/vault";
import { DEFAULT_RETRY_POLICY, createWriteback } from "~/renderer/writeback/writeback";

import { bridgedLms } from "./fixtures/bridge";
import {
  CanvasTermHttp,
  STORAGE_ORIGIN,
  SHELL_ID,
  SOURCE_ID,
  TEMPLATE_ID,
  TERM_HOST,
  TERM_TOKEN,
} from "./fixtures/canvas-term-http";
import { termName } from "~/shared/domain/term";

import { approved, clickWitness, newDraft, sending } from "./fixtures/changes";
import { VirtualClock } from "./fixtures/clock";
import { DurableLedger } from "./fixtures/ledger";
import { permitFor, unwrap } from "./fixtures/provider-contract";
import { runTermSetupContract, type TermContractHarness } from "./fixtures/term-contract";
import { cartridgeContent, copyContent, termOf } from "./fixtures/term";

const SCHOOL = (() => {
  const school = canvasSchoolAt(TERM_HOST);
  if (!school) throw new Error(`${TERM_HOST} should be a Canvas school`);
  return school;
})();
const SHELL = `${TERM_HOST}:course:${SHELL_ID}` as LmsRef<"course">;

const copyRemote: RemoteState = {
  kind: "course-copy",
  targetVersion: "students:0|items:0",
  students: 0,
  items: 0,
  migrations: [],
};

const canvasOver = (http: CanvasTermHttp, packages: Record<string, Blob> = {}) =>
  createCanvasProvider({
    school: SCHOOL,
    lease: {
      use: (work) => work({ kind: "bearer", token: new Secret(TERM_TOKEN) }),
      replace: async () => {},
    },
    fetch: http.fetch,
    now: http.now,
    packageFile: async (name) => packages[name] ?? null,
  });
const setupOf = (provider: LmsProvider): TermSetup => {
  if (!provider.termSetup) throw new Error("Canvas offers no term setup");
  return provider.termSetup;
};
/** The new-term course and last term's course, as the setup screens find them. */
const shellAndSource = async (provider: LmsProvider) => {
  const setup = setupOf(provider);
  const shell = (await unwrap(setup.newCourses())).find((entry) => entry.ref === SHELL);
  const source = (await unwrap(setup.copySources())).find(
    (entry) => entry.termName === "Fall 2026",
  );
  if (!shell || !source) throw new Error("no shell or source");
  return { shell, source };
};

const httpTermHarness = (hideTermDates: boolean) => async (): Promise<TermContractHarness> => {
  const http = new CanvasTermHttp();
  http.hideTermDates = hideTermDates;
  const provider = canvasOver(http);
  return {
    provider,
    school: SCHOOL.id,
    ...(await shellAndSource(provider)),
    advance: (ms) => http.advance(ms),
    loseNext: () => http.loseNext(),
    failNextMigration: (stage, message) => http.failNextMigration(stage, message),
    writeCount: http.writeCount,
    offersPackages: false,
  };
};
runTermSetupContract("Canvas over HTTP", httpTermHarness(false));
runTermSetupContract("Canvas over HTTP, term dates hidden", httpTermHarness(true));

describe("Canvas term setup reads", () => {
  it("names the shell and its source as Canvas does, with the dates and meeting days a shift needs", async () => {
    const { shell, source } = await shellAndSource(canvasOver(new CanvasTermHttp()));
    expect(shell).toMatchObject({
      code: "ENG-101",
      termName: "Spring 2027",
      startAt: "2027-01-19",
      endAt: "2027-05-14",
      itemCount: 0,
      copyTarget: `${TERM_HOST}:migrations:${SHELL_ID}`,
      stateTarget: `${TERM_HOST}:course-state:${SHELL_ID}`,
    });
    expect(source).toMatchObject({
      ref: `${TERM_HOST}:course:${SOURCE_ID}`,
      startAt: "2026-08-24",
      endAt: "2026-12-11",
      // Essay 1 is due on a Thursday, so the class reads as meeting Thursdays until the teacher says otherwise.
      meetingDays: [4],
      dated: [{ title: "Essay 1", dueAt: "2026-09-10T23:59:00.000Z" }],
    });
  });

  it("counts many new shells side by side, never with more than 8 requests out, so Canvas doesn't throttle the sync", async () => {
    const http = new CanvasTermHttp();
    const [shell] = http.courses.filter((row) => row.id === SHELL_ID);
    if (!shell) throw new Error("the fixture has a shell");
    for (let id = 1; id <= 20; id++)
      http.courses.push({ ...shell, id: SHELL_ID + id, name: `Shell ${id}` });
    let out = 0;
    let most = 0;
    const provider = createCanvasProvider({
      school: SCHOOL,
      lease: {
        use: (work) => work({ kind: "bearer", token: new Secret(TERM_TOKEN) }),
        replace: async () => {},
      },
      fetch: async (url, init) => {
        most = Math.max(most, ++out);
        await new Promise((resolve) => setTimeout(resolve, 1));
        out--;
        return http.fetch(url, init);
      },
      now: http.now,
      packageFile: async () => null,
    });
    expect(await unwrap(setupOf(provider).newCourses())).toHaveLength(21);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
  });

  it("offers the shell and its source with null dates when Canvas hides the term's dates from teachers", async () => {
    const http = new CanvasTermHttp();
    http.hideTermDates = true;
    const setup = setupOf(canvasOver(http));
    const shells = await unwrap(setup.newCourses());
    expect(shells.map((entry) => [entry.ref, entry.startAt, entry.endAt])).toEqual([
      [SHELL, null, null],
    ]);
    const source = (await unwrap(setup.copySources())).find(
      (entry) => entry.ref === `${TERM_HOST}:course:${SOURCE_ID}`,
    );
    expect(source).toMatchObject({ termName: "Fall 2026", startAt: null, endAt: null });
  });

  it("lists a published course whose term hasn't started, and leaves out one whose term is over", async () => {
    const http = new CanvasTermHttp();
    const provider = canvasOver(http);
    for (const row of http.courses) row.workflow_state = "available";
    const listed = (await unwrap(provider.courses())).map((course) => course.ref);
    expect(listed).toContain(SHELL);
    expect(listed).toContain(`${TERM_HOST}:course:${SOURCE_ID}`);
    expect(listed).not.toContain(`${TERM_HOST}:course:${TEMPLATE_ID}`);
  });

  it("lists templates first, and a teacher's own address is the school's contact domain", async () => {
    const provider = canvasOver(new CanvasTermHttp());
    const sources = await unwrap(setupOf(provider).copySources());
    expect(sources.map((entry) => [entry.code, entry.template, entry.termName])).toEqual([
      // Canvas's placeholder "Default Term" is no term a teacher would name.
      ["ENG-TPL", true, ""],
      ["ENG-101", false, "Fall 2026"],
    ]);
    const content = await unwrap(setupOf(provider).courseContent(SHELL));
    expect(content.policy).toEqual({
      contactDomain: "example.edu",
      contactEmail: "teacher@example.edu",
      statements: [],
    });
  });

  it("refuses a course ref this school didn't mint before any request", async () => {
    const http = new CanvasTermHttp();
    const setup = setupOf(canvasOver(http));
    for (const ref of [
      "other.example.edu:course:3301",
      `${TERM_HOST}:course:3301/../../users`,
      `${TERM_HOST}:course:3301:9`,
    ])
      expect(await setup.migrations(ref as LmsRef<"course">)).toEqual({
        ok: false,
        error: { kind: "not_found" },
      });
    expect(http.requests).toEqual([]);
  });
});

describe("Canvas term setup writes", () => {
  it("a copy goes out as one course_copy_importer migration with the shift Canvas is told", async () => {
    const http = new CanvasTermHttp();
    const provider = canvasOver(http);
    const { shell, source } = await shellAndSource(provider);
    const content = copyContent(shell, source);
    await provider.apply(await permitFor(provider, content, ["copy"], SCHOOL.id));
    const posts = http.requests.filter((line) => line.startsWith("POST "));
    expect(posts).toEqual([`POST /courses/${SHELL_ID}/content_migrations`]);
    expect(http.jobs[0]?.shift).toEqual(content.shift);
  });

  it("refuses a copy into or from a course at another school, and sends nothing", async () => {
    const http = new CanvasTermHttp();
    const provider = canvasOver(http);
    const { shell, source } = await shellAndSource(provider);
    const content = copyContent(shell, source);
    const writes = http.writeCount();
    const forgeries: CourseCopyContent[] = [
      { ...content, target: "evil.example:migrations:3301" as LmsRef<"migrations"> },
      { ...content, target: `${TERM_HOST}:migrations:3301/../1` as LmsRef<"migrations"> },
      {
        ...content,
        source: {
          kind: "course",
          ref: "evil.example:course:2201" as LmsRef<"course">,
          label: "ENG-101",
          termName: "Fall 2026",
        },
      },
    ];
    for (const forged of forgeries) {
      const permit = mintSendPermit(sending(approved(newDraft("ch-x", forged, copyRemote))), [
        "copy",
      ]);
      if (!permit) throw new Error("no permit");
      expect(await provider.apply(permit)).toMatchObject({
        copy: { status: "failed", error: { kind: "rejected" } },
      });
    }
    expect(http.writeCount()).toBe(writes);
  });

  it("publishes a file only once its own course says it holds it", async () => {
    const http = new CanvasTermHttp();
    const provider = canvasOver(http);
    const content: SetContent = {
      kind: "item-set",
      target: `${TERM_HOST}:item:${SHELL_ID}:file:9999` as LmsRef<"item">,
      where: "Handout",
      intent: { set: "item-published" },
    };
    const remote: RemoteState = {
      kind: "item-set",
      targetVersion: "present",
      value: "unpublished",
    };
    const permit = mintSendPermit(sending(approved(newDraft("ch-file", content, remote))), [
      "value",
    ]);
    if (!permit) throw new Error("no permit");
    expect(await provider.apply(permit)).toMatchObject({
      value: { status: "failed", error: { kind: "not_found" } },
    });
    expect(http.requests.filter((line) => line.includes("/files/"))).toEqual([
      `GET /courses/${SHELL_ID}/files/9999`,
    ]);
    expect(http.writeCount()).toBe(0);
  });

  it("a copy whose response was lost goes out once: the retry finds its job and sends nothing", async () => {
    const http = new CanvasTermHttp();
    const provider = canvasOver(http);
    const { shell, source } = await shellAndSource(provider);
    const content = copyContent(shell, source);
    const clock = new VirtualClock();
    const ledger = new DurableLedger();
    const draft = {
      ...newDraft("ch-copy", content, await unwrap(provider.observe(content))),
      school: SCHOOL.id,
    };
    ledger.add(draft);
    const committed = ledger.commit(draft.id, {
      type: "approve",
      witness: clickWitness(draft),
      at: draft.basis.readAt,
    });
    if (!committed.ok) throw new Error(committed.error);
    const writeback = createWriteback({
      ledger,
      providerFor: () => provider,
      markExpired: () => undefined,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      policy: DEFAULT_RETRY_POLICY,
      locks: null,
    });
    http.loseNext();
    await clock.run(writeback.send([draft.id]));
    expect(ledger.get(draft.id)?.state.tag).toBe("sent");
    expect(http.jobs).toHaveLength(1);
  });
});

describe("a sandbox course from copy to published, through main's send gate", () => {
  const setUp = () => {
    const http = new CanvasTermHttp();
    const press = { at: Number.NEGATIVE_INFINITY };
    const lms = bridgedLms({ fetch: http.fetch, pressedAt: () => press.at });
    const provider = bridgeCanvas(lms.bridge, CANVAS, CANVAS_FACE, lms.clock.now).create({
      school: SCHOOL,
      lease: createMemoryVault().leaseFor(SCHOOL.id),
    });
    return { http, lms, provider, pressNow: () => (press.at = Date.now()) };
  };

  it("copies and publishes only right after the teacher presses Send", async () => {
    const { http, lms, provider, pressNow } = setUp();
    await lms.vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TERM_TOKEN) });
    const { shell, source } = await shellAndSource(provider);
    const copy: CourseCopyContent = copyContent(shell, source);

    const declined = await provider.apply(await permitFor(provider, copy, ["copy"], SCHOOL.id));
    expect(declined.copy?.status).toBe("failed");
    expect(http.jobs).toEqual([]);

    pressNow();
    const sent = await provider.apply(await permitFor(provider, copy, ["copy"], SCHOOL.id));
    expect(sent.copy?.status).toBe("landed");
    http.advance(60_000);
    const jobs = await unwrap(setupOf(provider).migrations(shell.ref));
    expect(jobs.map((job) => job.state)).toEqual(["completed"]);

    const publish: SetContent = {
      kind: "item-set",
      target: shell.stateTarget,
      where: shell.code,
      intent: { set: "course-published" },
    };
    const published = await provider.apply(
      await permitFor(provider, publish, ["value"], SCHOOL.id),
    );
    expect(published.value?.status).toBe("landed");
    expect(http.requests).toContain(`PUT /courses/${SHELL_ID}`);
    expect((await unwrap(provider.courses())).map((course) => course.ref)).toContain(shell.ref);
  });
});

const PACKAGE = "eng210-northgate-spring2026-export.imscc";
const PACKAGE_BYTES = readFileSync(new URL(`../fixtures/imscc/${PACKAGE}`, import.meta.url));
const packageBlob = () => new Blob([PACKAGE_BYTES]);
const importOf = async (provider: LmsProvider) => {
  const { shell, source } = await shellAndSource(provider);
  const hint = { ...termOf(source), name: termName("Spring 2026"), days: [] };
  return { shell, content: cartridgeContent(shell, PACKAGE, hint, 1) };
};

describe("Canvas .imscc upload", () => {
  it("creates one package migration, uploads to storage without the token, and confirms at the school", async () => {
    const http = new CanvasTermHttp();
    const provider = canvasOver(http, { [PACKAGE]: packageBlob() });
    const { shell, content } = await importOf(provider);
    const sent = await provider.apply(await permitFor(provider, content, ["copy"], SCHOOL.id));
    expect(sent.copy?.status).toBe("landed");
    expect(http.requests.filter((line) => !line.startsWith("GET /courses"))).toEqual(
      expect.arrayContaining([
        `POST /courses/${SHELL_ID}/content_migrations`,
        expect.stringMatching(/^GET \/files\/\d+\/create_success\?uuid=u\d+$/),
      ]),
    );
    expect(http.uploads).toHaveLength(1);
    const [upload] = http.uploads;
    expect(upload?.url.startsWith(STORAGE_ORIGIN)).toBe(true);
    expect(upload?.authorization).toBeNull();
    expect(upload?.file).toEqual({
      field: "file",
      name: PACKAGE,
      size: PACKAGE_BYTES.byteLength,
      last: true,
    });
    expect(JSON.stringify(upload)).not.toContain(TERM_TOKEN);
    expect(http.jobs[0]?.shift).toEqual(content.shift);

    http.advance(60_000);
    const jobs = await unwrap(setupOf(provider).migrations(shell.ref));
    expect(jobs.map((job) => [job.state, job.signature])).toEqual([
      ["completed", `cartridge:${PACKAGE}`],
    ]);
    const imported = await unwrap(setupOf(provider).courseContent(shell.ref));
    expect(imported.items.map((item) => item.title)).toContain(`From ${PACKAGE}`);
  });

  it("storage that answers 201 is done, with no confirm request", async () => {
    const http = new CanvasTermHttp();
    http.storageCreates = true;
    const provider = canvasOver(http, { [PACKAGE]: packageBlob() });
    const { content } = await importOf(provider);
    const sent = await provider.apply(await permitFor(provider, content, ["copy"], SCHOOL.id));
    expect(sent.copy?.status).toBe("landed");
    expect(http.requests.some((line) => line.includes("create_success"))).toBe(false);
    expect(http.jobs[0]?.cartridge?.confirmed).toBe(true);
  });

  it("a confirm step at another host is refused, so the token goes only to the school", async () => {
    const http = new CanvasTermHttp();
    http.confirmOrigin = "https://evil.example";
    const provider = canvasOver(http, { [PACKAGE]: packageBlob() });
    const { content } = await importOf(provider);
    const sent = await provider.apply(await permitFor(provider, content, ["copy"], SCHOOL.id));
    expect(sent.copy).toMatchObject({ status: "failed", error: { kind: "rejected" } });
    // The fake throws on any request that leaves the school, so getting here means none did.
    expect(http.requests.some((line) => line.includes("create_success"))).toBe(false);
  });

  it("a confirm step at another school path is refused, so storage can't aim the token", async () => {
    const http = new CanvasTermHttp();
    http.confirmPath = () => "/api/v1/users/self";
    const provider = canvasOver(http, { [PACKAGE]: packageBlob() });
    const { content } = await importOf(provider);
    const permit = await permitFor(provider, content, ["copy"], SCHOOL.id);
    const before = http.requests.length;
    const sent = await provider.apply(permit);
    expect(sent.copy).toMatchObject({ status: "failed", error: { kind: "rejected" } });
    expect(http.requests.slice(before).some((line) => line.startsWith("GET /users/self"))).toBe(
      false,
    );
  });

  it("a package main's picker didn't choose is refused before any request", async () => {
    const http = new CanvasTermHttp();
    const provider = canvasOver(http);
    const { content } = await importOf(provider);
    const writes = http.writeCount();
    const sent = await provider.apply(await permitFor(provider, content, ["copy"], SCHOOL.id));
    expect(sent.copy).toMatchObject({ status: "failed", error: { kind: "rejected" } });
    expect(http.writeCount()).toBe(writes);
    expect(http.uploads).toEqual([]);
  });

  it("a create whose response was lost starts no second import: the retry finds the job by its package", async () => {
    const http = new CanvasTermHttp();
    const provider = canvasOver(http, { [PACKAGE]: packageBlob() });
    const { shell, content } = await importOf(provider);
    const clock = new VirtualClock();
    const ledger = new DurableLedger();
    const draft = {
      ...newDraft("ch-imscc", content, await unwrap(provider.observe(content))),
      school: SCHOOL.id,
    };
    ledger.add(draft);
    const committed = ledger.commit(draft.id, {
      type: "approve",
      witness: clickWitness(draft),
      at: draft.basis.readAt,
    });
    if (!committed.ok) throw new Error(committed.error);
    const writeback = createWriteback({
      ledger,
      providerFor: () => provider,
      markExpired: () => undefined,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      policy: DEFAULT_RETRY_POLICY,
      locks: null,
    });
    http.loseNext();
    await clock.run(writeback.send([draft.id]));
    expect(ledger.get(draft.id)?.state.tag).toBe("sent");
    expect(http.jobs).toHaveLength(1);
    // Its upload address went with the lost answer, so the job waits for a file: one job, never two imports.
    expect(http.uploads).toEqual([]);
    const jobs = await unwrap(setupOf(provider).migrations(shell.ref));
    expect(jobs.map((job) => job.state)).toEqual(["preparing"]);

    // Past the bound it reads as stalled, never failed: Canvas can't say the file didn't arrive, so the setup offers
    // Copy again with a warning rather than declaring the import gone.
    http.advance(11 * 60_000);
    const stalled = await unwrap(setupOf(provider).migrations(shell.ref));
    expect(stalled.map((job) => job.state)).toEqual(["stalled"]);

    // Copying again is a new change. Its send passes over the stalled job, so this send imports once.
    const again = {
      ...newDraft("ch-imscc-again", content, await unwrap(provider.observe(content))),
      school: SCHOOL.id,
    };
    ledger.add(again);
    const reapproved = ledger.commit(again.id, {
      type: "approve",
      witness: clickWitness(again),
      at: again.basis.readAt,
    });
    if (!reapproved.ok) throw new Error(reapproved.error);
    await clock.run(writeback.send([again.id]));
    expect(ledger.get(again.id)?.state.tag).toBe("sent");
    expect(http.jobs).toHaveLength(2);
    expect(http.uploads).toHaveLength(1);
    http.advance(60_000);
    const after = await unwrap(setupOf(provider).migrations(shell.ref));
    const record = ledger.get(again.id);
    if (!record) throw new Error("no change");
    expect(copyMigration(record, copySignature(content), after)?.state).toBe("completed");
    expect(after.map((job) => job.state)).toEqual(["stalled", "completed"]);
  });

  it("a package Canvas prepares past the bound reads as stalled, then completes, and never as failed", async () => {
    const http = new CanvasTermHttp();
    http.prepareMs = 30 * 60_000;
    const provider = canvasOver(http, { [PACKAGE]: packageBlob() });
    const { shell, content } = await importOf(provider);
    const sent = await provider.apply(await permitFor(provider, content, ["copy"], SCHOOL.id));
    expect(sent.copy?.status).toBe("landed");
    expect(http.uploads).toHaveLength(1);

    const seen: [string, string | null][] = [];
    for (let minute = 0; minute <= 32; minute += 1) {
      const jobs = await unwrap(setupOf(provider).migrations(shell.ref));
      seen.push(...jobs.map((job): [string, string | null] => [job.state, job.message]));
      http.advance(60_000);
    }
    const states = seen.map(([state]) => state);
    expect(states[0]).toBe("preparing");
    expect(states).toContain("stalled");
    expect(states.at(-1)).toBe("completed");
    expect(seen.some(([state]) => state === "failed")).toBe(false);
    expect(JSON.stringify(seen)).not.toMatch(/nothing was imported/i);
    const imported = await unwrap(setupOf(provider).courseContent(shell.ref));
    expect(imported.items.map((item) => item.title)).toContain(`From ${PACKAGE}`);
  });
});

describe("main's .imscc picker", () => {
  const setUp = (path: string | null) => {
    const http = new CanvasTermHttp();
    const lms = bridgedLms({ fetch: http.fetch, choosePackage: async () => path });
    const provider = bridgeCanvas(lms.bridge, CANVAS, CANVAS_FACE, lms.clock.now).create({
      school: SCHOOL,
      lease: createMemoryVault().leaseFor(SCHOOL.id),
    });
    return { http, lms, provider };
  };
  const onDisk = (name: string, bytes: Uint8Array) => {
    const path = join(mkdtempSync(join(tmpdir(), "imscc-")), name);
    writeFileSync(path, bytes);
    return path;
  };

  it("hands the renderer a name, size and the package's own term, and uploads main's own file", async () => {
    const path = onDisk(PACKAGE, PACKAGE_BYTES);
    const { http, lms, provider } = setUp(path);
    await lms.vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TERM_TOKEN) });
    const picked = await unwrap(
      setupOf(provider).pickPackage?.() ?? Promise.reject(new Error("no picker")),
    );
    if (!picked) throw new Error("the picker chose nothing");
    expect(picked).toEqual({
      name: PACKAGE,
      kb: Math.ceil(PACKAGE_BYTES.byteLength / 1024),
      hint: null,
    });
    expect(JSON.stringify(picked)).not.toContain(path);

    const { shell, content } = await importOf(provider);
    // The renderer's size is only a request; the upload uses main's file.
    const lying = { ...content, source: { ...content.source, kb: 999_999 } };
    const sent = await provider.apply(await permitFor(provider, lying, ["copy"], SCHOOL.id));
    expect(sent.copy?.status).toBe("landed");
    expect(http.uploads[0]?.file?.size).toBe(PACKAGE_BYTES.byteLength);
    expect(shell.ref).toBe(SHELL);
  });

  it("refuses a file that isn't a package, and a cancel picks nothing", async () => {
    const wrong = setUp(onDisk("grades.csv", new Uint8Array([1, 2, 3])));
    expect(await setupOf(wrong.provider).pickPackage?.()).toMatchObject({
      ok: false,
      error: { kind: "rejected" },
    });
    const empty = setUp(onDisk("empty.imscc", new Uint8Array()));
    expect(await setupOf(empty.provider).pickPackage?.()).toMatchObject({ ok: false });
    const cancelled = setUp(null);
    expect(await setupOf(cancelled.provider).pickPackage?.()).toEqual({ ok: true, value: null });
  });

  it("reads the old term from the package's course settings and due dates", async () => {
    const fixture = (name: string) =>
      onDisk(name, readFileSync(new URL(`../fixtures/imscc/${name}`, import.meta.url)));
    const pick = (path: string) =>
      setupOf(setUp(path).provider).pickPackage?.() ?? Promise.reject(new Error("no picker"));
    expect(await unwrap(pick(fixture("comm110-lakeshore-fall2026-export.imscc")))).toMatchObject({
      hint: { name: null, start: "2026-08-24", end: "2026-12-11", days: [2, 4] },
    });
    // A real export often leaves the end blank; the teacher types only what's missing.
    expect(await unwrap(pick(fixture("damaged-export.imscc")))).toMatchObject({
      hint: { start: "2026-01-20", end: "", days: [] },
    });
    expect(await unwrap(pick(onDisk("not-a-zip.imscc", new Uint8Array([1, 2, 3]))))).toMatchObject({
      hint: null,
    });
  });

  it("a demo school picks through main's picker too, so the desktop app has one import path", async () => {
    const path = onDisk(PACKAGE, PACKAGE_BYTES);
    const lms = bridgedLms({ choosePackage: async () => path });
    for (const school of FAKE_SCHOOLS)
      expect(await lms.provider(school.id).termSetup?.pickPackage?.()).toMatchObject({
        ok: true,
        value: { name: PACKAGE },
      });
  });
});
