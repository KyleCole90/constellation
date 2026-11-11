import {
  newChangeRecord,
  type ChangeContent,
  type ChangeRecord,
  type FieldKey,
  type GradeContent,
} from "~/domain/change";
import type { ChangeId, IsoTime, SchoolId } from "~/domain/ids";
import type { Submission } from "~/domain/lms";
import type { SendPermit } from "~/domain/permit";
import { QUIET_NOISE } from "~/providers/fake-canvas/faults";
import { FAKE_SCHOOLS, createFakeCanvasDescriptor } from "~/providers/fake-canvas/provider";
import { FakeCanvasServer } from "~/providers/fake-canvas/server";
import { Secret, type LmsProvider } from "~/providers/provider";
import { createMemoryVault } from "~/providers/vault";
import { DEFAULT_RETRY_POLICY, createWriteback, type Writeback } from "~/writeback/writeback";

import { clickWitness } from "./changes";
import { VirtualClock } from "./clock";
import { DurableLedger } from "./ledger";
import { memoryStorage } from "./storage";

export const LCC = "lcc" as SchoolId;
export const RSU = "rsu" as SchoolId;
const TOKEN = "fake-token-with-enough-length";

/** Sends through the real runner against the fake LMS, with a clock the test drives and a record of each write. */
export const makeRig = async () => {
  const clock = new VirtualClock();
  const storage = memoryStorage();
  const vault = createMemoryVault();
  const ledger = new DurableLedger();
  const expired: SchoolId[] = [];
  const writes: { change: ChangeId; fields: readonly FieldKey[] }[] = [];
  let seq = 0;

  const newServer = () =>
    new FakeCanvasServer({
      storage,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      noise: QUIET_NOISE,
      demoScript: false,
    });
  let server = newServer();
  const providers = new Map<SchoolId, LmsProvider>();

  const buildProviders = () => {
    const descriptor = createFakeCanvasDescriptor(server, clock.now);
    for (const school of FAKE_SCHOOLS) {
      const inner = descriptor.create({ school, lease: vault.leaseFor(school.id) });
      providers.set(school.id, {
        ...inner,
        apply: (permit: SendPermit) => {
          writes.push({ change: permit.changeId, fields: permit.fields });
          return inner.apply(permit);
        },
      });
    }
  };
  buildProviders();

  const newWriteback = (): Writeback =>
    createWriteback({
      ledger,
      providerFor: (school) => providers.get(school) ?? null,
      markExpired: (school) => expired.push(school),
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      policy: DEFAULT_RETRY_POLICY,
      locks: null,
    });

  const provider = (school: SchoolId): LmsProvider => {
    const found = providers.get(school);
    if (!found) throw new Error(`No provider for ${school}`);
    return found;
  };

  const connect = async (school: SchoolId, token = TOKEN) => {
    await vault.enroll(school, { kind: "bearer", token: new Secret(token) });
    const result = await provider(school).verify();
    if (!result.ok) throw new Error(`verify failed: ${result.error.kind}`);
  };
  await connect(LCC);
  await connect(RSU);

  const toGrade = (school: SchoolId): readonly Submission[] =>
    server
      .courses(school)
      .flatMap((course) => server.submissions(course.ref))
      .filter((s) => s.workflow === "submitted");

  const contentFor = (
    submission: Submission,
    comment = `Feedback for ${submission.studentName}.`,
  ): GradeContent => {
    const assignment = server
      .assignments(submission.course)
      .find((a) => a.ref === submission.assignment);
    if (!assignment) throw new Error("The submission has no assignment.");
    const rubric =
      assignment.rubric?.map((c) => ({
        criterion: c.ref,
        name: c.name,
        points: Math.floor(c.maxPoints * 0.8),
        outOf: c.maxPoints,
      })) ?? null;
    return {
      kind: "grade",
      target: submission.ref,
      points: rubric ? null : Math.floor(assignment.pointsPossible * 0.8),
      outOf: assignment.pointsPossible,
      rubric,
      late: null,
      comment,
      attachment: null,
      override: null,
      excused: false,
    };
  };

  const draft = async (school: SchoolId, content: ChangeContent): Promise<ChangeRecord> => {
    const remote = await provider(school).observe(content);
    if (!remote.ok) throw new Error(`observe failed: ${remote.error.kind}`);
    const at = new Date(clock.now()).toISOString() as IsoTime;
    const record = newChangeRecord({
      id: `ch-${++seq}` as ChangeId,
      school,
      course: server.courses(school)[0]?.ref ?? ("" as never),
      subject: "test",
      content,
      basis: { readAt: at, remote: remote.value },
      at,
      by: "agent",
    });
    ledger.add(record);
    return record;
  };

  const approve = (id: ChangeId): void => {
    const record = ledger.get(id);
    if (!record) throw new Error("No such change.");
    const result = ledger.commit(id, {
      type: "approve",
      witness: clickWitness(record),
      at: new Date(clock.now()).toISOString() as IsoTime,
    });
    if (!result.ok) throw new Error(`approve rejected: ${result.error}`);
  };

  /** A ready-to-send change for the nth submission that needs a grade at this school. */
  const approvedGrade = async (
    school: SchoolId,
    index = 0,
    comment?: string,
  ): Promise<{ id: ChangeId; submission: Submission }> => {
    const submission = toGrade(school)[index];
    if (!submission) throw new Error("No such submission.");
    const record = await draft(school, contentFor(submission, comment));
    approve(record.id);
    return { id: record.id, submission };
  };

  const lmsSubmission = (submission: Submission): Submission => {
    const found = server.submissions(submission.course).find((s) => s.ref === submission.ref);
    if (!found) throw new Error("The submission is gone.");
    return found;
  };

  /** What a page reload does: new server object and new runner over the same durable state. */
  const reload = (): Writeback => {
    server = newServer();
    buildProviders();
    return newWriteback();
  };

  const stateOf = (id: ChangeId): ChangeRecord["state"] => {
    const record = ledger.get(id);
    if (!record) throw new Error("No such change.");
    return record.state;
  };

  return {
    clock,
    storage,
    vault,
    ledger,
    expired,
    writes,
    get server() {
      return server;
    },
    provider,
    connect,
    toGrade,
    contentFor,
    draft,
    approve,
    approvedGrade,
    lmsSubmission,
    newWriteback,
    reload,
    stateOf,
  };
};
export type Rig = Awaited<ReturnType<typeof makeRig>>;
