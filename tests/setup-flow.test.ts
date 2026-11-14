import { describe, expect, it } from "vite-plus/test";

import { type Agent } from "~/shared/agent/agent";
import { ApprovalWitness, fingerprintOf } from "~/shared/domain/approval";
import { riskOf, summarize, type ChangeRecord } from "~/shared/domain/change";
import type { CopySource, CourseShell } from "~/shared/domain/content";
import type { ChangeId, IsoTime, LmsRef, SchoolId } from "~/shared/domain/ids";
import { reviewRows, stageOf, type CourseSetup, type SetupStage } from "~/shared/domain/setup";
import { draftOf, type TermDates, type TermPlan } from "~/shared/domain/term";
import {
  selectChangesShown,
  selectCourse,
  selectSetupOffers,
  selectSetupView,
} from "~/renderer/stores/selectors";
import { WORKSPACE_STORAGE_KEY } from "~/renderer/stores/workspace";

import { clickWitness } from "./fixtures/changes";
import { VirtualClock } from "./fixtures/clock";
import { LCC, RSU } from "./fixtures/rig";
import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";
import { planFor, termOf } from "./fixtures/term";

type Course = LmsRef<"course">;

const connected = async (options: Parameters<typeof makeStoreRig>[0] = {}): Promise<StoreRig> => {
  const rig = await makeStoreRig(options);
  await rig.connectAll();
  return rig;
};

/** A real reload: the old store's timers live on the old clock, so its watcher never wakes again. */
const reload = async (rig: StoreRig, options: { agent?: Agent } = {}): Promise<StoreRig> => {
  const next = await makeStoreRig({
    storage: rig.storage,
    vault: rig.vault,
    clock: new VirtualClock(rig.clock.now()),
    ...options,
  });
  await next.clock.run(next.state().boot());
  return next;
};

const until = async (
  rig: StoreRig,
  holds: () => boolean,
  what = "the condition",
): Promise<void> => {
  const wait = async () => {
    for (let step = 0; step < 2000; step++) {
      if (holds()) return;
      await rig.clock.sleep(50);
    }
    throw new Error(`Never saw ${what}.`);
  };
  await rig.clock.run(wait());
};

const setupOf = (rig: StoreRig, course: Course): CourseSetup => {
  const found = rig.state().setups[course];
  if (!found) throw new Error("No setup.");
  return found;
};
const stage = (rig: StoreRig, course: Course): SetupStage =>
  stageOf(setupOf(rig, course), rig.state().changes, rig.state().setupLive[course]);
const stageIs = (rig: StoreRig, course: Course, tag: SetupStage["tag"]) =>
  until(rig, () => stage(rig, course).tag === tag, `stage ${tag}`);
const record = (rig: StoreRig, id: ChangeId): ChangeRecord => {
  const found = rig.state().changes[id];
  if (!found) throw new Error("No change.");
  return found;
};
const rows = (rig: StoreRig, course: Course) =>
  reviewRows(setupOf(rig, course), rig.state().changes);
const nowIso = (rig: StoreRig) => new Date(rig.state().now()).toISOString() as IsoTime;

const approve = (rig: StoreRig, id: ChangeId) => {
  const result = rig
    .state()
    .dispatchUser(id, { type: "approve", witness: clickWitness(record(rig, id)), at: nowIso(rig) });
  if (!result.ok) throw new Error(result.error);
};
const send = (rig: StoreRig, ids: readonly ChangeId[]) =>
  rig.clock.run(rig.state().sendChanges(ids));
const sentCount = (rig: StoreRig) =>
  Object.values(rig.state().changes).filter((change) => summarize(change).sentAt !== null).length;
/** The one invariant of the whole flow: the LMS holds a write only for a change a person approved and sent. */
const expectWritesMatchSends = (rig: StoreRig) =>
  expect(rig.server.writes()).toHaveLength(sentCount(rig));

const shellOf = (rig: StoreRig, school: SchoolId, code: string): CourseShell => {
  const found = rig.state().newCourses[school]?.find((shell) => shell.code === code);
  if (!found) throw new Error(`${code} isn't offered at ${school}.`);
  return found;
};

const optionsOf = async (rig: StoreRig, school: SchoolId) => {
  await rig.clock.run(rig.state().loadSetupOptions(school));
  const options = rig.state().setupOptions[school];
  if (!options) throw new Error("No options.");
  return options;
};

type Pick_ = { course: string; term: string } | { sample: string };

const pickSource = async (
  rig: StoreRig,
  school: SchoolId,
  pick: Pick_,
): Promise<{ source: CopySource; term: TermDates }> => {
  const options = await optionsOf(rig, school);
  if ("course" in pick) {
    const found = options.sources.find(
      (source) => source.code === pick.course && source.termName === pick.term,
    );
    if (!found) throw new Error(`No source ${pick.course}.`);
    return {
      source: {
        kind: "course",
        ref: found.ref,
        label: `${found.code}, ${found.termName}`,
        termName: found.termName,
      },
      term: termOf(found),
    };
  }
  const sample = options.samples.find((entry) => entry.note.includes(pick.sample));
  const { name, start, end, days } = sample?.hint ?? {};
  if (!sample?.hint || !start || !end || !days)
    throw new Error(`No dated sample from ${pick.sample}.`);
  return {
    source: { kind: "cartridge", name: sample.name, kb: sample.kb, hint: sample.hint },
    term: { name: name ?? null, start, end, days },
  };
};

/** Start, choose, confirm: up to a copy draft nobody has approved. */
const toDraftCopy = async (
  rig: StoreRig,
  school: SchoolId,
  code: string,
  pick: Pick_,
): Promise<{ course: Course; shell: CourseShell; copy: ChangeId; plan: TermPlan }> => {
  const shell = shellOf(rig, school, code);
  const course = shell.ref;
  rig.state().startSetup(course);
  const { source, term } = await pickSource(rig, school, pick);
  expect(rig.state().chooseSource(course, source)).toBeNull();
  const plan = planFor(term, shell);
  expect(await rig.clock.run(rig.state().confirmDates(course, plan))).toBeNull();
  const copy = setupOf(rig, course).copy;
  if (!copy) throw new Error("No copy was drafted.");
  return { course, shell, copy, plan };
};

const toReview = async (rig: StoreRig, school: SchoolId, code: string, pick: Pick_) => {
  const started = await toDraftCopy(rig, school, code, pick);
  approve(rig, started.copy);
  await send(rig, [started.copy]);
  await stageIs(rig, started.course, "review");
  await until(
    rig,
    () => !rig.state().working[setupOf(rig, started.course).thread],
    "the agent to finish",
  );
  return started;
};

/** Works every row the way a person would, one round at a time, until the course has nothing open. */
const workThrough = async (rig: StoreRig, course: Course) => {
  for (let round = 0; round < 12; round++) {
    const open = rows(rig, course).filter(
      (row) => row.status === "manual" || row.status === "fix" || row.status === "still-here",
    );
    if (open.length === 0) return;
    for (const row of open) {
      if (row.status === "manual") expect(rig.state().markHandled(course, row.key)).toBeNull();
      if (row.status === "still-here")
        expect(rig.state().dismissFinding(course, row.key, "Fine as it is")).toBeNull();
    }
    const fixes = open.flatMap((row) =>
      row.status === "fix" && row.change ? [row.change.id] : [],
    );
    for (const id of fixes) {
      if (summarize(record(rig, id)).canApprove) approve(rig, id);
      expectWritesMatchSends(rig);
    }
    if (fixes.length > 0) await send(rig, fixes);
    expectWritesMatchSends(rig);
    if (rows(rig, course).some((row) => row.summary?.recovery === "rescan"))
      await rig.clock.run(rig.state().scanNow(course));
  }
  throw new Error("The review never settled.");
};

const FLOWS: readonly { name: string; school: SchoolId; code: string; pick: Pick_ }[] = [
  {
    name: "Lakeshore from a previous course",
    school: LCC,
    code: "ENG 101",
    pick: { course: "ENG 101", term: "Fall 2026" },
  },
  {
    name: "Lakeshore from a cartridge",
    school: LCC,
    code: "COMM 110",
    pick: { sample: "Lakeshore" },
  },
  {
    name: "Riverbend from a previous course",
    school: RSU,
    code: "ENG 210",
    pick: { course: "ENG 210", term: "Fall 2026" },
  },
  {
    name: "Riverbend from a cartridge",
    school: RSU,
    code: "ENG 210",
    pick: { sample: "Northgate" },
  },
];

describe("the whole setup", () => {
  it.each(FLOWS)(
    "$name runs to a published course and a template, writing only what was approved",
    async ({ school, code, pick }) => {
      const rig = await connected();
      expect(
        selectSetupOffers(rig.state()).some(
          (offer) => offer.shell.code === code && offer.words === "New and empty",
        ),
      ).toBe(true);

      const { course, copy } = await toDraftCopy(rig, school, code, pick);
      expect(stage(rig, course).tag).toBe("approve-copy");
      expect(rig.server.writes()).toEqual([]);

      expect((await send(rig, [copy]))[0]).toMatchObject({ refused: "not-sendable" });
      expect(rig.server.writes()).toEqual([]);

      approve(rig, copy);
      expect(rig.server.writes()).toEqual([]);
      await send(rig, [copy]);
      expect(rig.server.writes()).toHaveLength(1);

      await stageIs(rig, course, "review");
      expectWritesMatchSends(rig);
      const found = rows(rig, course);
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((row) => row.change).every((row) => row.summary?.canApprove)).toBe(true);
      expect(found.some((row) => row.finding?.fix && !row.change)).toBe(false);

      await workThrough(rig, course);

      expect(await rig.clock.run(rig.state().runPublishCheck(course))).toBeNull();
      expect(stage(rig, course).tag).toBe("publish-check");
      const before = rig.server.writes().length;

      const proposed = await rig.clock.run(rig.state().proposePublish(course));
      if (!proposed.ok) throw new Error(proposed.error);
      expect(stage(rig, course)).toEqual({ tag: "publish-check", publish: proposed.value });
      expect((await send(rig, [proposed.value]))[0]).toMatchObject({ refused: "not-sendable" });
      expect(rig.server.writes()).toHaveLength(before);

      approve(rig, proposed.value);
      await send(rig, [proposed.value]);
      expect(stage(rig, course).tag).toBe("published");
      expect(rig.state().cache[school]?.courses.some((entry) => entry.ref === course)).toBe(true);
      expect(selectSetupOffers(rig.state()).some((offer) => offer.shell.ref === course)).toBe(
        false,
      );
      expectWritesMatchSends(rig);

      const template = await rig.clock.run(rig.state().proposeTemplate(course));
      if (!template.ok) throw new Error(template.error);
      expect(template.value.thread).toBe(setupOf(rig, course).thread);
      expect(selectSetupView(rig.state(), course).template?.id).toBe(template.value.change);
      expectWritesMatchSends(rig);
      approve(rig, template.value.change);
      await send(rig, [template.value.change]);
      expectWritesMatchSends(rig);

      const { sources } = await optionsOf(rig, school);
      expect(sources.find((source) => source.ref === course)).toMatchObject({
        code,
        template: true,
      });
      expect(sources.findIndex((source) => source.ref === course)).toBeLessThan(
        sources.findIndex((source) => !source.template),
      );
    },
  );

  it("startSetup twice gives one setup and one thread", async () => {
    const rig = await connected();
    const { ref } = shellOf(rig, LCC, "ENG 101");
    const first = rig.state().startSetup(ref);
    const threads = Object.keys(rig.state().threads).length;
    expect(rig.state().startSetup(ref)).toBe(first);
    expect(Object.keys(rig.state().threads)).toHaveLength(threads);
    expect(selectCourse(rig.state(), ref)?.code).toBe("ENG 101");
  });

  it("any course in the overview can be saved as a template and then lists as one", async () => {
    const rig = await connected();
    const course = rig.state().cache[LCC]?.courses.find((entry) => entry.code === "ENG 102");
    if (!course) throw new Error("No ENG 102.");
    const before = (await optionsOf(rig, LCC)).sources.find((source) => source.ref === course.ref);
    expect(before?.template).toBe(false);

    const proposed = await rig.clock.run(rig.state().proposeTemplate(course.ref));
    if (!proposed.ok) throw new Error(proposed.error);
    expect(rig.server.writes()).toEqual([]);
    expect(rig.state().threads[proposed.value.thread]?.kind).toBe("setup");

    approve(rig, proposed.value.change);
    await send(rig, [proposed.value.change]);
    expect(
      (await optionsOf(rig, LCC)).sources.find((source) => source.ref === course.ref)?.template,
    ).toBe(true);
    expect(await rig.clock.run(rig.state().proposeTemplate(course.ref))).toMatchObject({
      ok: true,
      value: { change: proposed.value.change },
    });
  });

  it("a cartridge file is read by name and size, and a wrong file is refused in words", async () => {
    const rig = await connected();
    const { ref } = shellOf(rig, LCC, "ENG 101");
    rig.state().startSetup(ref);
    expect(rig.state().chooseCartridgeFile(ref, { name: "grades.csv", size: 10 })).toBe(
      "Canvas course exports are .imscc, not CSV.",
    );
    expect(rig.state().chooseCartridgeFile(ref, { name: "notes.docx", size: 10 })).toMatch(
      /\.imscc/,
    );
    expect(setupOf(rig, ref).source).toBeNull();
    expect(rig.state().chooseCartridgeFile(ref, { name: "mine.imscc", size: 2048 })).toBeNull();
    expect(setupOf(rig, ref).source).toEqual({
      kind: "cartridge",
      name: "mine.imscc",
      kb: 2,
      hint: null,
    });
  });

  it("a file named like a package the school lists takes that package's term", async () => {
    const rig = await connected();
    const { ref } = shellOf(rig, LCC, "ENG 101");
    rig.state().startSetup(ref);
    const sample = (await optionsOf(rig, LCC)).samples.find((entry) => entry.hint !== null);
    if (!sample) throw new Error("No sample with a term.");
    expect(rig.state().chooseCartridgeFile(ref, { name: sample.name, size: 2048 })).toBeNull();
    expect(setupOf(rig, ref).source).toMatchObject({ kind: "cartridge", hint: sample.hint });
  });

  it("the Dates form as typed survives until the source changes", async () => {
    const rig = await connected();
    const shell = shellOf(rig, LCC, "ENG 101");
    const { ref } = shell;
    rig.state().startSetup(ref);
    rig.state().chooseCartridgeFile(ref, { name: "mine.imscc", size: 2048 });
    const [source] = (await optionsOf(rig, LCC)).sources;
    if (!source) throw new Error("No source course.");
    const typed = planFor(termOf(source), shell);
    rig.state().editDates(ref, draftOf(typed));
    expect(setupOf(rig, ref).draft).toEqual(draftOf(typed));
    rig.state().chooseSource(ref, null);
    expect(setupOf(rig, ref).draft).toBeNull();
  });

  it("editing the dates of an approved copy resets its approval", async () => {
    const rig = await connected();
    const { course, copy, plan } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    approve(rig, copy);
    expect(
      await rig.clock.run(rig.state().confirmDates(course, { ...plan, breaks: [] })),
    ).toBeNull();
    expect(setupOf(rig, course).copy).toBe(copy);
    expect(summarize(record(rig, copy)).label).toBe("Needs approval again");
    expect((await send(rig, [copy]))[0]).toMatchObject({ refused: "not-sendable" });
    expect(rig.server.writes()).toEqual([]);
  });

  it("a plan with a problem is refused and drafts nothing", async () => {
    const rig = await connected();
    const shell = shellOf(rig, LCC, "ENG 101");
    rig.state().startSetup(shell.ref);
    const { source, term } = await pickSource(rig, LCC, { course: "ENG 101", term: "Fall 2026" });
    rig.state().chooseSource(shell.ref, source);
    const plan = planFor(term, shell);
    expect(
      await rig.clock.run(
        rig.state().confirmDates(shell.ref, { ...plan, newTerm: { ...plan.newTerm, days: [] } }),
      ),
    ).toBe("Pick at least one meeting day for the new term.");
    expect(setupOf(rig, shell.ref).copy).toBeNull();
  });
});

describe("the guardrail on an occupied course", () => {
  it("a plain click is refused, and only the acknowledged risk approves", async () => {
    const rig = await connected();
    expect(
      selectSetupOffers(rig.state()).find((offer) => offer.shell.code === "HUM 150")?.words,
    ).toMatch(/14 students and \d+ items/);
    const { course, copy } = await toDraftCopy(rig, RSU, "HUM 150", {
      course: "HUM 150",
      term: "Fall 2026",
    });
    const draft = record(rig, copy);
    const risk = riskOf(draft);
    expect(risk).not.toBeNull();

    expect(
      rig
        .state()
        .dispatchUser(copy, { type: "approve", witness: clickWitness(draft), at: nowIso(rig) }),
    ).toEqual({ ok: false, error: "needs-confirmation" });
    expect((await send(rig, [copy]))[0]).toMatchObject({ refused: "not-sendable" });
    expect(rig.server.writes()).toEqual([]);

    const witness = ApprovalWitness.fromClick({ isTrusted: true, type: "click" }, [
      { changeId: copy, fingerprint: fingerprintOf(draft), risk: risk as NonNullable<typeof risk> },
    ]);
    if (!witness) throw new Error("No witness.");
    expect(rig.state().dispatchUser(copy, { type: "approve", witness, at: nowIso(rig) }).ok).toBe(
      true,
    );
    await send(rig, [copy]);
    expect(rig.server.writes()).toHaveLength(1);
    await stageIs(rig, course, "review");
  });
});

describe("a reload", () => {
  it("mid-copy resumes, shows the same progress, and copies once", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    approve(rig, copy);
    await send(rig, [copy]);
    await until(
      rig,
      () => (rig.state().setupLive[course]?.migration?.completion ?? 0) >= 25,
      "the copy under way",
    );
    const percent = rig.state().setupLive[course]?.migration?.completion ?? 0;
    const thread = setupOf(rig, course).thread;

    const next = await reload(rig);
    await until(
      next,
      () =>
        next.state().setupLive[course]?.migration !== undefined &&
        next.state().setupLive[course]?.migration !== null,
      "the job read again",
    );
    expect(next.state().setupLive[course]?.migration?.completion).toBeGreaterThanOrEqual(percent);
    await stageIs(next, course, "review");

    const lines =
      next
        .state()
        .threads[thread]?.messages.flatMap((message) =>
          message.type === "work" ? message.lines : [],
        ) ?? [];
    expect(lines.filter((line) => line === "Copying, 20 percent")).toHaveLength(1);
    expect(lines).toContain("Copying, 100 percent");
    expect(lines).toContain("Scanning tools");
    expect(next.server.writes()).toHaveLength(1);
  });

  it("mid-scan converges with no duplicate changes", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, RSU, "ENG 210", {
      course: "ENG 210",
      term: "Fall 2026",
    });
    approve(rig, copy);
    await send(rig, [copy]);
    await until(
      rig,
      () =>
        stage(rig, course).tag === "scanning" &&
        rig.state().setupLive[course]?.scan?.label === "Scanning assignments",
      "the scan under way",
    );
    expect(setupOf(rig, course).scan).toBeNull();

    const next = await reload(rig);
    await stageIs(next, course, "review");
    const firstRun = Object.keys(next.state().changes).length;
    const fixes = Object.values(setupOf(next, course).fixes);
    expect(new Set(fixes).size).toBe(fixes.length);
    expect(fixes.length).toBe(
      setupOf(next, course).scan?.findings.filter((finding) => finding.fix).length,
    );

    await next.clock.run(next.state().scanNow(course));
    expect(Object.keys(next.state().changes)).toHaveLength(firstRun);
    expect(next.server.writes()).toHaveLength(1);
  });

  it("a workspace saved before setup existed still loads", async () => {
    const rig = await connected();
    const saved = JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as {
      state: Record<string, unknown>;
    };
    delete saved.state["setups"];
    delete saved.state["newCourses"];
    rig.storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(saved));
    const next = await reload(rig);
    expect(next.state().setups).toEqual({});
    expect(next.state().connections[LCC]?.status).toBe("connected");
    expect(next.state().notice).toBeNull();
  });
});

describe("a fix", () => {
  const firstTextFix = (rig: StoreRig, course: Course) => {
    const row = rows(rig, course).find(
      (candidate) => candidate.change?.content.kind === "text-fix",
    );
    if (!row?.change) throw new Error("No text fix.");
    return { key: row.key, id: row.change.id };
  };

  it("edited after approval resets, says so, and is refused at send", async () => {
    const rig = await connected();
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    const { id } = firstTextFix(rig, course);
    approve(rig, id);
    expect(
      rig.state().dispatchUser(id, {
        type: "edit",
        by: "you",
        patch: { kind: "text-fix", after: "my own words" },
        at: nowIso(rig),
      }).ok,
    ).toBe(true);
    expect(summarize(record(rig, id)).label).toBe("Needs approval again");
    const writes = rig.server.writes().length;
    expect((await send(rig, [id]))[0]).toMatchObject({ refused: "not-sendable" });
    expect(rig.server.writes()).toHaveLength(writes);

    await rig.clock.run(rig.state().scanNow(course));
    expect(record(rig, id).content).toMatchObject({ splice: { after: "my own words" } });
  });

  it.each([
    { ai: "off", noKey: true, label: "Draft. Not sent" },
    { ai: "on", noKey: false, label: "AI draft. Not sent" },
  ])("drafted by the scan reads $label with AI $ai", async ({ noKey, label }) => {
    const rig = await connected({ noKey });
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    const drafts = rows(rig, course).flatMap((row) => (row.change ? [row.change] : []));
    expect(drafts.length).toBeGreaterThan(0);
    expect(new Set(drafts.map((change) => summarize(change).label))).toEqual(new Set([label]));
  });

  it("dismissed is discarded and a rescan does not revive it, and restored drafts again", async () => {
    const rig = await connected();
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    const { key, id } = firstTextFix(rig, course);
    expect(rig.state().dismissFinding(course, key, "Keep the old wording")).toBeNull();
    expect(record(rig, id).state.tag).toBe("discarded");
    expect(rows(rig, course).find((row) => row.key === key)).toMatchObject({
      status: "dismissed",
      change: null,
      resolution: { reason: "Keep the old wording" },
    });

    await rig.clock.run(rig.state().scanNow(course));
    expect(rows(rig, course).find((row) => row.key === key)).toMatchObject({
      status: "dismissed",
      change: null,
    });

    await rig.clock.run(rig.state().restoreFinding(course, key));
    const restored = rows(rig, course).find((row) => row.key === key);
    expect(restored?.status).toBe("fix");
    expect(restored?.change?.id).not.toBe(id);
    expect(restored?.summary?.canApprove).toBe(true);
  });

  it("sent becomes Fixed after the rescan, with nothing else moved", async () => {
    const rig = await connected();
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    const { key, id } = firstTextFix(rig, course);
    approve(rig, id);
    const others = rows(rig, course).filter((row) => row.change && row.key !== key).length;
    await send(rig, [id]);
    expect(rows(rig, course).find((row) => row.change?.id === id)?.status).toBe("fixed");
    expect(
      rows(rig, course).filter(
        (row) => row.change && row.change.id !== id && row.summary?.canApprove,
      ).length,
    ).toBeGreaterThanOrEqual(others - 1);
    expectWritesMatchSends(rig);
  });

  it("the agent rewords a rule's finding, mints nothing, and its words survive a rules-only rescan", async () => {
    const agent: Agent = {
      label: "Stub",
      async *run(input) {
        const finding = input.scope.scan?.findings.find(
          (entry) => entry.fix?.kind === "text-fix" && entry.item !== null,
        );
        if (finding?.item) {
          yield {
            type: "finding",
            findingType: finding.type,
            item: finding.item,
            quote: finding.quote,
            why: "Said by the agent.",
            after: "Written by the agent.",
          };
          yield {
            type: "finding",
            findingType: "empty-module",
            item: finding.item,
            quote: "nothing like it",
            why: "Made up.",
            after: null,
          };
        }
      },
    };
    const rig = await connected({ agent });
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    const row = rows(rig, course).find(
      (candidate) => candidate.finding?.why === "Said by the agent.",
    );
    expect(row?.change?.content).toMatchObject({ splice: { after: "Written by the agent." } });
    expect(rows(rig, course).some((candidate) => candidate.finding?.why === "Made up.")).toBe(
      false,
    );
    const changes = Object.keys(rig.state().changes).length;

    await rig.clock.run(rig.state().scanNow(course));
    expect(rows(rig, course).find((candidate) => candidate.key === row?.key)?.finding?.why).toBe(
      "Said by the agent.",
    );
    expect(Object.keys(rig.state().changes)).toHaveLength(changes);
  });
});

describe("the publish check", () => {
  it("refuses while anything is open, and refuses a course that moved since the check", async () => {
    const rig = await connected();
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    expect(await rig.clock.run(rig.state().proposePublish(course))).toMatchObject({ ok: false });
    expect(setupOf(rig, course).publish).toBeNull();

    await workThrough(rig, course);
    await rig.clock.run(rig.state().runPublishCheck(course));
    const moved = { ...setupOf(rig, course), check: { at: nowIso(rig), version: "an older read" } };
    rig.store.setState({ setups: { ...rig.state().setups, [course]: moved } });
    expect(await rig.clock.run(rig.state().proposePublish(course))).toEqual({
      ok: false,
      error: "The course changed after the publish check. Run the check again.",
    });
  });
});

/** Another tab holding the watcher's lock until it closes. */
const otherTab = () => {
  let closed = false;
  let close = () => {};
  const gone = new Promise<void>((resolve) => (close = resolve));
  const request = async (name: string, ...rest: unknown[]) => {
    const work = rest.at(-1) as (lock: object | null) => Promise<unknown>;
    const { ifAvailable } = (rest.length > 1 ? rest[0] : {}) as { ifAvailable?: boolean };
    if (name.startsWith("setup-watch:") && !closed) {
      if (ifAvailable) return work(null);
      await gone;
    }
    return work({});
  };
  return {
    locks: { request } as unknown as Pick<LockManager, "request">,
    close: () => {
      closed = true;
      close();
    },
  };
};

describe("a copy that can't be seen clearly", () => {
  it("won't redraft over a copy that may still land, so a dates edit can't copy twice", async () => {
    const rig = await connected();
    const { course, copy, plan } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    rig.server.lateLanding(60_000);
    approve(rig, copy);
    await send(rig, [copy]);
    expect(summarize(record(rig, copy)).canEdit).toBe(false);
    expect(record(rig, copy).state.tag).toBe("held");

    expect(await rig.clock.run(rig.state().confirmDates(course, { ...plan, breaks: [] }))).toBe(
      "This copy can't be changed right now.",
    );
    expect(setupOf(rig, course).copy).toBe(copy);
    expect(record(rig, copy).state.tag).toBe("held");
  });

  it("lets a person start over after the LMS refused a copy outright", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    rig.server.failNextWrite("copy", { kind: "rejected", reason: "The course is locked." });
    approve(rig, copy);
    await send(rig, [copy]);
    expect(record(rig, copy).state.tag).toBe("held");
    expect(rig.server.writes()).toEqual([]);

    expect(rig.state().chooseSource(course, null)).toBeNull();
    expect(record(rig, copy).state.tag).toBe("discarded");
    expect(stage(rig, course).tag).toBe("source");
  });
});

describe("a watcher that stopped", () => {
  it("starts again when the school reconnects", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    approve(rig, copy);
    await send(rig, [copy]);
    rig.server.expireToken(LCC);
    await until(
      rig,
      () => rig.state().connections[LCC]?.status === "expired",
      "the school to expire",
    );
    expect(stage(rig, course).tag).toBe("copying");

    await rig.connect(LCC, "a-fresh-token-long-enough");
    await stageIs(rig, course, "review");
  });

  it("waits for another tab's watcher and takes over when that tab closes", async () => {
    const tab = otherTab();
    const rig = await connected({ locks: tab.locks });
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    approve(rig, copy);
    await send(rig, [copy]);
    await rig.clock.run(rig.clock.sleep(30_000));
    expect(stage(rig, course).tag).toBe("copying");

    tab.close();
    await stageIs(rig, course, "review");
  });

  it("a reload after a send rescans, so a fix that landed stops reading as still here", async () => {
    const rig = await connected();
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    const fix = rows(rig, course).find(
      (row) => row.change && row.finding?.fix?.kind === "text-fix",
    );
    if (!fix?.change) throw new Error("No text fix.");
    const { scan } = setupOf(rig, course);
    approve(rig, fix.change.id);
    await send(rig, [fix.change.id]);
    rig.store.setState({
      setups: { ...rig.state().setups, [course]: { ...setupOf(rig, course), scan } },
    });
    expect(rows(rig, course).find((row) => row.key === fix.key)?.status).toBe("checking");

    const next = await reload(rig);
    await until(
      next,
      () => rows(next, course).find((row) => row.key === fix.key)?.status === "fixed",
      "the row to read as fixed",
    );
  });
});

describe("which changes a setup thread has on screen", () => {
  it("includes the publish card whichever finding row is focused, so a banner above it doesn't repeat the card's", async () => {
    const rig = await connected();
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    await workThrough(rig, course);
    expect(await rig.clock.run(rig.state().runPublishCheck(course))).toBeNull();
    const proposed = await rig.clock.run(rig.state().proposePublish(course));
    if (!proposed.ok) throw new Error(proposed.error);
    const setupThread = Object.values(rig.state().threads).find(
      (thread) => thread.kind === "setup" && thread.course === course,
    );
    if (!setupThread) throw new Error("No setup thread.");
    rig.state().focusChange(setupThread.id, null);
    const unfocused = rig.state().threads[setupThread.id];
    if (!unfocused) throw new Error("No setup thread.");
    expect(selectChangesShown(rig.state(), unfocused)).toEqual([proposed.value]);
  });

  it("is only the focused change on an ordinary thread", async () => {
    const rig = await connected();
    const queue = Object.values(rig.state().threads).find((thread) => thread.kind !== "setup");
    if (!queue) throw new Error("No thread.");
    expect(selectChangesShown(rig.state(), queue)).toEqual(queue.focus ? [queue.focus] : []);
  });
});

describe("a finding that comes back", () => {
  it("drops an approved publish, so it can't go out with something open", async () => {
    const rig = await connected();
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    await workThrough(rig, course);
    expect(await rig.clock.run(rig.state().runPublishCheck(course))).toBeNull();
    const proposed = await rig.clock.run(rig.state().proposePublish(course));
    if (!proposed.ok) throw new Error(proposed.error);
    approve(rig, proposed.value);
    const before = rig.server.writes().length;
    const handled = rows(rig, course).find(
      (row) => row.status === "handled" || row.status === "dismissed",
    );
    if (!handled) throw new Error("Nothing was handled.");

    expect(await rig.clock.run(rig.state().restoreFinding(course, handled.key))).toBeNull();
    expect(record(rig, proposed.value).state.tag).toBe("discarded");
    expect(stage(rig, course).tag).toBe("review");
    expect((await send(rig, [proposed.value]))[0]).toMatchObject({ refused: "not-sendable" });
    expect(rig.server.writes()).toHaveLength(before);
  });

  it("says so when the restore's rescan can't read the course", async () => {
    const rig = await connected();
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    const manual = rows(rig, course).find((row) => row.status === "manual");
    if (!manual) throw new Error("No manual row.");
    expect(rig.state().markHandled(course, manual.key)).toBeNull();
    rig.server.expireToken(LCC);
    expect(await rig.clock.run(rig.state().restoreFinding(course, manual.key))).toEqual(
      expect.any(String),
    );
  });
});

describe("a failed copy", () => {
  it("stays failed when Copy again can't read the course", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    rig.server.failNextMigration("running", "The importer timed out.");
    approve(rig, copy);
    await send(rig, [copy]);
    await stageIs(rig, course, "copy-failed");
    rig.server.expireToken(LCC);

    expect(await rig.clock.run(rig.state().retryCopy(course))).toEqual(expect.any(String));
    expect(stage(rig, course).tag).toBe("copy-failed");
  });

  it("shows the failure, and Copy again is a new draft that needs a new approval", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    rig.server.failNextMigration("running", "The importer timed out.");
    approve(rig, copy);
    await send(rig, [copy]);
    await stageIs(rig, course, "copy-failed");
    expect(stage(rig, course)).toMatchObject({ migration: { message: "The importer timed out." } });
    expect(summarize(record(rig, copy)).sentAt).not.toBeNull();

    expect(await rig.clock.run(rig.state().retryCopy(course))).toBeNull();
    const retry = setupOf(rig, course).copy as ChangeId;
    expect(retry).not.toBe(copy);
    expect(stage(rig, course)).toEqual({ tag: "approve-copy", copy: retry, stale: false });
    expect((await send(rig, [retry]))[0]).toMatchObject({ refused: "not-sendable" });
    expect(rig.server.writes()).toHaveLength(1);

    approve(rig, retry);
    await send(rig, [retry]);
    await stageIs(rig, course, "review");
    expect(rig.server.writes()).toHaveLength(2);
    expect(
      rig
        .state()
        .threads[setupOf(rig, course).thread]?.messages.flatMap((message) =>
          message.type === "work" ? message.lines : [],
        ),
    ).toContain("Copying, 100 percent (attempt 2)");
  });

  it("a reload after a failed job still shows the failure", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    rig.server.failNextMigration("pre_processing", "The package would not open.");
    approve(rig, copy);
    await send(rig, [copy]);
    await stageIs(rig, course, "copy-failed");
    const next = await reload(rig);
    await stageIs(next, course, "copy-failed");
  });
});

describe("the lane", () => {
  it("a 429 during the watch pauses the school's other reads too", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    approve(rig, copy);
    await send(rig, [copy]);
    await until(
      rig,
      () => (rig.state().setupLive[course]?.migration?.completion ?? 0) > 0,
      "the watch started",
    );

    rig.server.throttleNext(3000, "any");
    await until(rig, () => rig.state().laneStatus(LCC).state === "paused", "the lane to pause");
    const lane = rig.state().laneStatus(LCC);
    if (lane.state !== "paused") throw new Error("Not paused.");
    const synced = await rig.clock.run(rig.state().syncSchool(LCC));
    expect(synced).toBe(true);
    expect(rig.state().now()).toBeGreaterThanOrEqual(lane.until);

    await stageIs(rig, course, "review");
    expect(rig.server.writes()).toHaveLength(1);
  });
});

describe("the sync", () => {
  it("a failed read of the new courses leaves the sync successful and the old list in place", async () => {
    const rig = await connected();
    const known = rig.state().newCourses[LCC];
    expect(known?.length).toBeGreaterThan(0);
    const real = rig.server.call.bind(rig.server);
    rig.server.call = (route, credential, work) =>
      route.label.includes("state[]=unpublished")
        ? Promise.resolve({ ok: false, error: { kind: "not_found" } })
        : real(route, credential, work);
    expect(await rig.clock.run(rig.state().syncSchool(LCC))).toBe(true);
    expect(rig.state().connections[LCC]?.syncError).toBeNull();
    expect(rig.state().newCourses[LCC]).toEqual(known);
  });
});

describe("the source", () => {
  it("copy sources list the seeded templates first", async () => {
    const rig = await connected();
    const { sources } = await optionsOf(rig, LCC);
    const firstPlain = sources.findIndex((source) => !source.template);
    expect(sources.slice(0, firstPlain).every((source) => source.template)).toBe(true);
    expect(sources.slice(firstPlain).every((source) => !source.template)).toBe(true);
  });

  it("choosing another source drops the unsent copy", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    expect(rig.state().chooseSource(course, null)).toBeNull();
    expect(record(rig, copy).state.tag).toBe("discarded");
    expect(stage(rig, course).tag).toBe("source");
  });
});

describe("cancelling a setup", () => {
  const offerOf = (rig: StoreRig, course: Course) =>
    selectSetupOffers(rig.state()).find((offer) => offer.shell.ref === course);

  it("before the copy is sent drops the draft and the thread, and the course is offered again", async () => {
    const rig = await connected();
    const { course, copy } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    const thread = setupOf(rig, course).thread;
    expect(offerOf(rig, course)).toMatchObject({ thread, cancellable: true });

    expect(rig.state().cancelSetup(course).ok).toBe(true);
    expect(rig.state().setups[course]).toBeUndefined();
    expect(rig.state().threads[thread]).toBeUndefined();
    expect(record(rig, copy).state.tag).toBe("discarded");
    expect(offerOf(rig, course)).toMatchObject({ thread: null, words: "New and empty" });
    expect(rig.server.writes()).toEqual([]);

    expect(rig.state().startSetup(course)).not.toBe(thread);
    expect(stage(rig, course).tag).toBe("source");
  });

  it("comes back on undo with its thread, source, dates and a draft of the same copy", async () => {
    const rig = await connected();
    const { course, copy, plan } = await toDraftCopy(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    const before = setupOf(rig, course);
    const cancelled = rig.state().cancelSetup(course);
    if (!cancelled.ok) throw new Error(cancelled.error);
    expect(rig.state().setups[course]).toBeUndefined();
    expect(rig.state().threads[before.thread]).toBeUndefined();

    expect(rig.state().restoreSetup(cancelled.value)).toBeNull();
    const after = setupOf(rig, course);
    expect(after).toMatchObject({ thread: before.thread, source: before.source, plan });
    expect(after.copy).not.toBe(copy);
    expect(rig.state().threads[before.thread]?.focus).toBe(after.copy);
    expect(after.copy && record(rig, after.copy).content).toEqual(record(rig, copy).content);
    expect(stage(rig, course).tag).toBe("approve-copy");
    expect(rig.server.writes()).toEqual([]);
    expect(rig.state().restoreSetup(cancelled.value)).toBe(
      "This course has a setup again, so the cancelled one can't come back.",
    );
  });

  it("is refused once the copy has gone to the LMS", async () => {
    const rig = await connected();
    const { course } = await toReview(rig, LCC, "ENG 101", {
      course: "ENG 101",
      term: "Fall 2026",
    });
    expect(offerOf(rig, course)?.cancellable).toBe(false);
    expect(rig.state().cancelSetup(course)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already gone to the LMS/),
    });
    expect(rig.state().setups[course]).toBeDefined();
  });
});
