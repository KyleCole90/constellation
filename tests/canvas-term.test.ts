import { describe, expect, it } from "vite-plus/test";

import type { SendConfirmation } from "~/main/lms";
import { canvasSchoolAt, createCanvasProvider } from "~/main/providers/canvas";
import type { CourseCopyContent, RemoteState, SetContent } from "~/shared/domain/change";
import type { LmsRef } from "~/shared/domain/ids";
import { mintSendPermit } from "~/shared/domain/permit";
import { CANVAS, CANVAS_FACE } from "~/shared/providers/canvas";
import { Secret, type LmsProvider, type TermSetup } from "~/shared/providers/provider";
import { bridgeCanvas } from "~/renderer/providers/lms";
import { createMemoryVault } from "~/renderer/providers/vault";
import { DEFAULT_RETRY_POLICY, createWriteback } from "~/renderer/writeback/writeback";

import { bridgedLms } from "./fixtures/bridge";
import {
  CanvasTermHttp,
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
import { copyContent } from "./fixtures/term";

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

const canvasOver = (http: CanvasTermHttp) =>
  createCanvasProvider({
    school: SCHOOL,
    lease: {
      use: (work) => work({ kind: "bearer", token: new Secret(TERM_TOKEN) }),
      replace: async () => {},
    },
    fetch: http.fetch,
    now: http.now,
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
