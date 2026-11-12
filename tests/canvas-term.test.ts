import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { SendConfirmation } from "~/main/lms";
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
  TERM_HOST,
  TERM_TOKEN,
} from "./fixtures/canvas-term-http";
import { approved, clickWitness, newDraft, sending } from "./fixtures/changes";
import { VirtualClock } from "./fixtures/clock";
import { DurableLedger } from "./fixtures/ledger";
import { permitFor, unwrap } from "./fixtures/provider-contract";
import { runTermSetupContract } from "./fixtures/term-contract";
import { cartridgeContent, copyContent } from "./fixtures/term";

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

runTermSetupContract("Canvas over HTTP", async () => {
  const http = new CanvasTermHttp();
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
});

describe("Canvas term setup reads", () => {
  it("names the shell and its source as Canvas does, with the dates a shift needs", async () => {
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
      meetingDays: [],
      dated: [{ title: "Essay 1", dueAt: "2026-09-10T23:59:00.000Z" }],
    });
  });

  it("lists templates first, and a teacher's own address is the school's contact domain", async () => {
    const provider = canvasOver(new CanvasTermHttp());
    const sources = await unwrap(setupOf(provider).copySources());
    expect(sources.map((entry) => [entry.code, entry.template])).toEqual([
      ["ENG-TPL", true],
      ["ENG-101", false],
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
    expect(await provider.describeSend(content)).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
    expect(http.requests.filter((line) => line.includes("/files/"))).toEqual([
      `GET /courses/${SHELL_ID}/files/9999`,
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

describe("a sandbox course from copy to published, through main's confirm dialog", () => {
  const setUp = (...answers: boolean[]) => {
    const http = new CanvasTermHttp();
    const asks: SendConfirmation[] = [];
    const lms = bridgedLms({
      fetch: http.fetch,
      confirmSend: async (ask) => {
        asks.push(ask);
        return answers.shift() ?? false;
      },
    });
    const provider = bridgeCanvas(lms.bridge, CANVAS, CANVAS_FACE, lms.clock.now).create({
      school: SCHOOL,
      lease: createMemoryVault().leaseFor(SCHOOL.id),
    });
    return { http, asks, lms, provider };
  };

  it("asks before the copy and before the publish, naming each course as Canvas reports it", async () => {
    const { http, asks, lms, provider } = setUp(false, true, true);
    await lms.vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TERM_TOKEN) });
    const { shell, source } = await shellAndSource(provider);
    const copy: CourseCopyContent = copyContent(shell, source);

    const declined = await provider.apply(await permitFor(provider, copy, ["copy"], SCHOOL.id));
    expect(declined.copy?.status).toBe("failed");
    expect(http.jobs).toEqual([]);

    const sent = await provider.apply(await permitFor(provider, copy, ["copy"], SCHOOL.id));
    expect(sent.copy?.status).toBe("landed");
    expect(asks[1]).toEqual({
      host: TERM_HOST,
      target: "Copy into ENG-101, ENG-101 Composition",
      lines: [
        "Copy from: ENG-101, ENG-101 Composition",
        `Dates: ${copy.shift.oldStart} to ${copy.shift.oldEnd} move to ${copy.shift.newStart} to ${copy.shift.newEnd}`,
      ],
    });
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
    expect(asks[2]).toEqual({
      host: TERM_HOST,
      target: "ENG-101, ENG-101 Composition",
      lines: ["Publish the course, so its students can see it"],
    });
    expect(http.requests).toContain(`PUT /courses/${SHELL_ID}`);
    expect((await unwrap(provider.courses())).map((course) => course.ref)).toContain(shell.ref);
  });
});

const PACKAGE = "eng210-northgate-spring2026-export.imscc";
const PACKAGE_BYTES = readFileSync(new URL(`../fixtures/imscc/${PACKAGE}`, import.meta.url));
const packageBlob = () => new Blob([PACKAGE_BYTES]);
const importOf = async (provider: LmsProvider) => {
  const { shell, source } = await shellAndSource(provider);
  const hint = { name: "Spring 2026", start: source.startAt, end: source.endAt, days: [] };
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

    // Past the bound it reads as failed, with the reason, so the setup offers Copy again.
    http.advance(11 * 60_000);
    const stranded = await unwrap(setupOf(provider).migrations(shell.ref));
    expect(stranded.map((job) => [job.state, job.message])).toEqual([
      ["failed", expect.stringContaining("never received the package file")],
    ]);

    // Copying again is a new change. Its send passes over the stranded job, so exactly one import runs.
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
    expect(after.map((job) => job.state)).toEqual(["failed", "completed"]);
  });
});

describe("main's .imscc picker", () => {
  const setUp = (path: string | null) => {
    const http = new CanvasTermHttp();
    const asks: SendConfirmation[] = [];
    const lms = bridgedLms({
      fetch: http.fetch,
      confirmSend: async (ask) => {
        asks.push(ask);
        return true;
      },
      choosePackage: async () => path,
    });
    const provider = bridgeCanvas(lms.bridge, CANVAS, CANVAS_FACE, lms.clock.now).create({
      school: SCHOOL,
      lease: createMemoryVault().leaseFor(SCHOOL.id),
    });
    return { http, asks, lms, provider };
  };
  const onDisk = (name: string, bytes: Uint8Array) => {
    const path = join(mkdtempSync(join(tmpdir(), "imscc-")), name);
    writeFileSync(path, bytes);
    return path;
  };

  it("hands the renderer a name and size only, and the confirm dialog names main's own file", async () => {
    const path = onDisk(PACKAGE, PACKAGE_BYTES);
    const { http, asks, lms, provider } = setUp(path);
    await lms.vault.enroll(SCHOOL.id, { kind: "bearer", token: new Secret(TERM_TOKEN) });
    const picked = await unwrap(
      setupOf(provider).pickPackage?.() ?? Promise.reject(new Error("no picker")),
    );
    if (!picked) throw new Error("the picker chose nothing");
    expect(picked).toEqual({ name: PACKAGE, kb: Math.ceil(PACKAGE_BYTES.byteLength / 1024) });
    expect(JSON.stringify(picked)).not.toContain(path);

    const { shell, content } = await importOf(provider);
    // The renderer's size is only a request; the dialog and the upload use main's file.
    const lying = { ...content, source: { ...content.source, kb: 999_999 } };
    const sent = await provider.apply(await permitFor(provider, lying, ["copy"], SCHOOL.id));
    expect(sent.copy?.status).toBe("landed");
    expect(asks[0]).toEqual({
      host: TERM_HOST,
      target: "Import into ENG-101, ENG-101 Composition",
      lines: [
        `Package: ${PACKAGE}, ${picked.kb} KB`,
        `Dates: ${content.shift.oldStart} to ${content.shift.oldEnd} move to ${content.shift.newStart} to ${content.shift.newEnd}`,
      ],
    });
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

  it("a demo school has no picker: the page's file input names its package", () => {
    const lms = bridgedLms();
    for (const school of FAKE_SCHOOLS)
      expect(lms.provider(school.id).termSetup?.pickPackage).toBeUndefined();
  });
});
