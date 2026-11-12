import { describe, expect, it } from "vite-plus/test";

import type { TextFixContent } from "~/shared/domain/change";
import type { LmsRef } from "~/shared/domain/ids";
import { Secret, type LmsProvider } from "~/shared/providers/provider";
import { createMemoryVault } from "~/renderer/providers/vault";
import { DEFAULT_RETRY_POLICY, createWriteback } from "~/renderer/writeback/writeback";

import { SecondLmsStub } from "./fixtures/second-lms-stub";
import { clickWitness, newDraft } from "./fixtures/changes";
import { VirtualClock } from "./fixtures/clock";
import { DurableLedger } from "./fixtures/ledger";
import { bridgedLms } from "./fixtures/bridge";
import { LCC, gradeContentFor, makeRig } from "./fixtures/rig";
import { runProviderContract, type ContractHarness } from "./fixtures/provider-contract";
import { makeTermRig } from "./fixtures/term";
import { runTermSetupContract, type TermContractHarness } from "./fixtures/term-contract";

runProviderContract("fake Canvas", async (): Promise<ContractHarness> => {
  const rig = await makeRig();
  const submission = rig.toGrade(LCC)[0];
  if (!submission) throw new Error("The seed has nothing to grade.");
  return {
    provider: rig.provider(LCC),
    school: LCC,
    content: rig.contentFor(submission),
    failNext: (field, error) => rig.server.failNextWrite(field, error),
    loseNext: () => rig.server.loseNextResponse(),
    throttleNext: (ms) => rig.server.throttleNext(ms),
    expire: () => rig.server.expireToken(LCC),
    writeCount: () => rig.server.log.filter((entry) => entry.kind === "write").length,
  };
});

/** The desktop app's provider: a bridge client, through the IPC map, to the fake in main. */
runProviderContract("fake Canvas over the bridge", async (): Promise<ContractHarness> => {
  const lms = bridgedLms();
  await lms.connect(LCC);
  const submission = lms.server
    .courses(LCC)
    .flatMap((course) => lms.server.submissions(course.ref))
    .find((s) => s.workflow === "submitted");
  if (!submission) throw new Error("The seed has nothing to grade.");
  return {
    provider: lms.provider(LCC),
    school: LCC,
    content: gradeContentFor(lms.server, submission),
    failNext: (field, error) => lms.lab.failNextWrite(field, error),
    loseNext: () => lms.lab.loseNextResponse(),
    throttleNext: (ms) => lms.lab.throttleNext(ms),
    expire: () => lms.lab.expireToken(LCC),
    writeCount: () => lms.server.log.filter((entry) => entry.kind === "write").length,
  };
});

runTermSetupContract("fake Canvas over the bridge", async (): Promise<TermContractHarness> => {
  const lms = bridgedLms();
  await lms.connect(LCC);
  const setup = lms.provider(LCC).termSetup;
  if (!setup) throw new Error("no term setup over the bridge");
  const shells = await setup.newCourses();
  const sources = await setup.copySources();
  const shell = shells.ok ? shells.value.find((entry) => entry.code === "ENG 101") : undefined;
  const source = sources.ok
    ? sources.value.find((entry) => entry.code === "ENG 101" && entry.termName === "Fall 2026")
    : undefined;
  if (!shell || !source) throw new Error("the seed has no ENG 101 to copy");
  return {
    provider: lms.provider(LCC),
    school: LCC,
    shell,
    source,
    advance: (ms) => lms.clock.advance(ms),
    loseNext: () => lms.lab.loseNextResponse(),
    failNextMigration: (stage, message) => lms.lab.failNextMigration(stage, message),
    writeCount: () => lms.server.log.filter((entry) => entry.kind === "write").length,
  };
});

runTermSetupContract("fake Canvas", async (): Promise<TermContractHarness> => {
  const rig = await makeTermRig();
  return {
    provider: rig.provider(LCC),
    school: LCC,
    shell: await rig.shellNamed(LCC, "ENG 101"),
    source: await rig.sourceNamed(LCC, "ENG 101", "Fall 2026"),
    advance: (ms) => rig.clock.advance(ms),
    loseNext: () => rig.server.loseNextResponse(),
    failNextMigration: (stage, message) => rig.server.failNextMigration(stage, message),
    writeCount: () => rig.server.log.filter((entry) => entry.kind === "write").length,
  };
});

const makeStub = async () => {
  const stub = new SecondLmsStub();
  const vault = createMemoryVault();
  const school = SecondLmsStub.SCHOOL;
  await vault.enroll(school, { kind: "bearer", token: new Secret("second-lms-token") });
  const clock = new VirtualClock();
  return { stub, clock, provider: stub.provider(vault.leaseFor(school), clock.now) };
};

const stubContent = {
  kind: "grade",
  target: SecondLmsStub.TARGET,
  points: 88,
  outOf: 100,
  rubric: null,
  late: null,
  comment: "Good revision.",
  attachment: null,
  override: null,
  excused: false,
} as const;

runProviderContract("second LMS stub", async (): Promise<ContractHarness> => {
  const { stub, provider } = await makeStub();
  return {
    provider,
    school: SecondLmsStub.SCHOOL,
    content: stubContent,
    failNext: (field, error) => stub.failNext(field === "grade" ? "grade" : "feedback", error),
    loseNext: () => stub.loseNext(),
    throttleNext: (ms) => stub.throttleNext(ms),
    expire: () => stub.expire(),
    writeCount: () => stub.requests.length,
  };
});

describe("a vendor without term setup", () => {
  it("offers none, and answers unsupported to the new kinds", async () => {
    const { provider } = await makeStub();
    expect(provider.termSetup).toBeUndefined();
    const content: TextFixContent = {
      kind: "text-fix",
      target: "ksu:item:1:page:1" as LmsRef<"item">,
      where: "Syllabus",
      splice: { prefix: "a", before: "b", after: "c", suffix: "d" },
    };
    expect(await provider.observe(content)).toEqual({
      ok: false,
      error: { kind: "unsupported", capability: "text-fix" },
    });
  });
});

describe("the runner against a second vendor", () => {
  const setUp = async () => {
    const { stub, clock, provider } = await makeStub();
    const ledger = new DurableLedger();
    const observed = await provider.observe(stubContent);
    if (!observed.ok) throw new Error(observed.error.kind);
    const draft = {
      ...newDraft("ch-b", stubContent, observed.value),
      school: SecondLmsStub.SCHOOL,
      course: SecondLmsStub.COURSE,
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
      providerFor: (): LmsProvider => provider,
      markExpired: () => undefined,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      policy: DEFAULT_RETRY_POLICY,
      locks: null,
    });
    return { stub, clock, ledger, writeback, id: draft.id };
  };

  it("sends grade and feedback as separate requests", async () => {
    const { stub, clock, ledger, writeback, id } = await setUp();
    await clock.run(writeback.send([id]));
    expect(ledger.get(id)?.state.tag).toBe("sent");
    expect(stub.requests).toEqual(["grade", "feedback"]);
    expect(stub.grade).toBe(88);
    expect(stub.feedback).toEqual({ version: 2, text: "Good revision." });
  });

  it("a feedback failure after the grade landed holds, and retry sends only the feedback", async () => {
    const { stub, clock, ledger, writeback, id } = await setUp();
    stub.failNext("feedback", { kind: "unavailable", status: 502 });
    await clock.run(writeback.send([id]));
    expect(ledger.get(id)?.state.tag).toBe("held");
    expect(stub.grade).toBe(88);
    stub.requests = [];
    await clock.run(writeback.send([id]));
    expect(ledger.get(id)?.state.tag).toBe("sent");
    expect(stub.requests).toEqual(["feedback"]);
  });

  it("a replaced feedback whose response was lost is recognized by its fresh version, not written twice", async () => {
    const { stub, clock, ledger, writeback, id } = await setUp();
    stub.loseNext();
    await clock.run(writeback.send([id]));
    expect(ledger.get(id)?.state.tag).toBe("sent");
    expect(stub.requests).toEqual(["grade", "feedback"]);
    expect(stub.feedback?.version).toBe(2);
  });
});
