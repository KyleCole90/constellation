import { describe, expect, it } from "vite-plus/test";

import { fieldsOf, summarize, type FieldKey, type LmsError } from "~/domain/change";
import type { ChangeId, IsoTime } from "~/domain/ids";
import type { Submission } from "~/domain/lms";
import type { Result } from "~/domain/ids";
import { LMS_STORAGE_KEY } from "~/providers/fake-canvas/server";
import { DEFAULT_RETRY_POLICY, createWriteback } from "~/writeback/writeback";

import { SimulatedCrash } from "./fixtures/ledger";
import { LCC, RSU, makeRig, type Rig } from "./fixtures/rig";

const heldCause = (rig: Rig, id: ChangeId) => {
  const state = rig.stateOf(id);
  return state.tag === "held" ? state.cause : null;
};
const fieldStatus = (rig: Rig, id: ChangeId, field: FieldKey) => {
  const state = rig.stateOf(id);
  return state.tag === "sending" || state.tag === "held" || state.tag === "sent"
    ? state.run.fields[field]
    : undefined;
};
const myComments = (rig: Rig, submission: Submission, text?: string) =>
  rig
    .lmsSubmission(submission)
    .comments.filter((c) => c.mine && (text === undefined || c.text === text));
const fieldWrites = (rig: Rig, id: ChangeId, field: FieldKey) =>
  rig.writes.filter((write) => write.change === id && write.fields.includes(field)).length;
const lmsRequests = (rig: Rig, school = LCC) =>
  rig.server.log.filter((entry) => entry.school === school);
const iso = (rig: Rig) => new Date(rig.clock.now()).toISOString() as IsoTime;

describe("a clean send", () => {
  it("lands every field once and reads as sent", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    const results = await rig.clock.run(rig.newWriteback().send([id]));
    expect(results).toEqual([{ id, state: "sent" }]);
    expect(rig.lmsSubmission(submission).grade).not.toBeNull();
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("a draft that was never approved is refused and writes nothing", async () => {
    const rig = await makeRig();
    const submission = rig.toGrade(LCC)[0] as Submission;
    const record = await rig.draft(LCC, rig.contentFor(submission));
    expect(await rig.clock.run(rig.newWriteback().send([record.id]))).toEqual([
      { id: record.id, refused: "not-sendable" },
    ]);
    expect(rig.writes).toEqual([]);
  });

  it("sending the same id twice in one call writes once", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    await rig.clock.run(rig.newWriteback().send([id, id]));
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("a second press while the batch is still sending posts nothing twice", async () => {
    const rig = await makeRig();
    const first = await rig.approvedGrade(LCC, 0);
    const second = await rig.approvedGrade(LCC, 1);
    const writeback = rig.newWriteback();
    await rig.clock.run(
      Promise.all([writeback.send([first.id, second.id]), writeback.send([second.id])]),
    );
    expect(myComments(rig, first.submission)).toHaveLength(1);
    expect(myComments(rig, second.submission)).toHaveLength(1);
    expect(fieldWrites(rig, second.id, "comment")).toBe(1);
  });

  it("a change that is already sent is refused on a second press", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    const writeback = rig.newWriteback();
    await rig.clock.run(writeback.send([id]));
    expect(await rig.clock.run(writeback.send([id]))).toEqual([{ id, refused: "not-sendable" }]);
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("wraps the send in a lock named for the change", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    const names: string[] = [];
    const locks = {
      request: async (name: string, work: () => Promise<unknown>) => (names.push(name), work()),
    } as unknown as Pick<LockManager, "request">;
    const writeback = createWriteback({
      ledger: rig.ledger,
      providerFor: rig.provider,
      markExpired: () => undefined,
      now: rig.clock.now,
      sleep: rig.clock.sleep,
      random: () => 0.5,
      policy: DEFAULT_RETRY_POLICY,
      locks,
    });
    await rig.clock.run(writeback.send([id]));
    expect(names).toEqual([`lms-send:${id}`]);
  });
});

describe("an expired token mid-batch", () => {
  it("holds that change, leaves the rest of the school approved, lets the other school finish, and reconnecting sends each once", async () => {
    const rig = await makeRig();
    const first = await rig.approvedGrade(LCC, 0);
    const second = await rig.approvedGrade(LCC, 1);
    const third = await rig.approvedGrade(LCC, 2);
    const other = await rig.approvedGrade(RSU, 0);
    const writeback = rig.newWriteback();

    const results = await rig.clock.run(
      writeback.send([first.id, second.id, third.id, other.id], (result) => {
        if (result.id === first.id) rig.server.expireToken(LCC);
      }),
    );

    expect(results.map((result) => ("state" in result ? result.state : result.refused))).toEqual([
      "sent",
      "held",
      "approved",
      "sent",
    ]);
    expect(heldCause(rig, second.id)).toEqual({ tag: "reconnect" });
    expect(
      summarize(rig.ledger.get(second.id) as NonNullable<ReturnType<Rig["ledger"]["get"]>>)
        .recovery,
    ).toBe("reconnect");
    expect(rig.expired).toEqual([LCC]);
    expect(writeback.laneStatus(LCC)).toEqual({ state: "closed", reason: "reconnect" });
    expect(writeback.laneStatus(RSU)).toEqual({ state: "open" });

    await rig.connect(LCC, "a-fresh-token-after-reconnecting");
    writeback.reopen(LCC);
    expect(await rig.clock.run(writeback.send([second.id, third.id]))).toEqual([
      { id: second.id, state: "sent" },
      { id: third.id, state: "sent" },
    ]);
    for (const { submission } of [first, second, third, other])
      expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("a token that expires before the first read holds the change without a run having started", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    rig.server.expireToken(LCC);
    await rig.clock.run(rig.newWriteback().send([id]));
    const state = rig.stateOf(id);
    expect(state.tag === "held" && state.run.attempt).toBe(0);
    expect(rig.writes).toEqual([]);
  });
});

describe("a conflict", () => {
  it("writes nothing and refuses to send until it is resolved and approved again", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.changeGradeOutOfBand(submission.ref, 65, "Jordan Pike (TA)");
    const writeback = rig.newWriteback();

    expect(await rig.clock.run(writeback.send([id]))).toEqual([{ id, state: "conflicted" }]);
    expect(rig.writes).toEqual([]);
    expect(rig.lmsSubmission(submission).grade).toBe(65);
    expect(await rig.clock.run(writeback.send([id]))).toEqual([{ id, refused: "not-sendable" }]);

    const record = rig.ledger.get(id);
    const remote = await rig.provider(LCC).observe(record?.content as never);
    if (!remote.ok) throw new Error(remote.error.kind);
    const resolved = rig.ledger.commit(id, {
      type: "resolve-conflict",
      choices: { grade: "keep-mine" },
      remote: remote.value,
      at: iso(rig),
    });
    expect(resolved.ok && resolved.value.state).toEqual({ tag: "draft", approvalReset: "rebased" });
    expect(await rig.clock.run(writeback.send([id]))).toEqual([{ id, refused: "not-sendable" }]);

    rig.approve(id);
    expect(await rig.clock.run(writeback.send([id]))).toEqual([{ id, state: "sent" }]);
    expect(rig.lmsSubmission(submission).grade).not.toBe(65);
  });

  it("a student resubmitting between approval and send stops the write", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.studentResubmits(submission.ref);
    await rig.clock.run(rig.newWriteback().send([id]));
    const state = rig.stateOf(id);
    expect(state.tag === "conflicted" && state.conflicts[0]?.reason).toBe("target-changed");
    expect(rig.writes).toEqual([]);
  });
});

describe("a partial write", () => {
  it("keeps what landed, and a retry sends only the rest and posts exactly one comment", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.failNextWrite("comment", { kind: "unavailable", status: 500 });
    const writeback = rig.newWriteback();

    expect(await rig.clock.run(writeback.send([id]))).toEqual([{ id, state: "held" }]);
    expect(fieldStatus(rig, id, "grade")?.status).toBe("landed");
    expect(fieldStatus(rig, id, "comment")?.status).toBe("failed");
    expect(summarize(rig.ledger.get(id) as never).label).toBe("Partly sent");
    expect(myComments(rig, submission)).toHaveLength(0);

    expect(await rig.clock.run(writeback.send([id]))).toEqual([{ id, state: "sent" }]);
    expect(rig.writes.at(-1)?.fields).toEqual(["comment"]);
    expect(fieldWrites(rig, id, "grade")).toBe(1);
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("a retry after someone else changed a landed grade leaves that grade alone", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.failNextWrite("comment", { kind: "unavailable", status: 500 });
    const writeback = rig.newWriteback();
    await rig.clock.run(writeback.send([id]));
    rig.server.changeGradeOutOfBand(submission.ref, 71, "Jordan Pike (TA)");

    await rig.clock.run(writeback.send([id]));
    expect(rig.lmsSubmission(submission).grade).toBe(71);
    expect(rig.stateOf(id).tag).toBe("sent");
  });
});

describe("a whole request that fails with a 5xx", () => {
  it("retries with backoff and then succeeds without a person", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.failNextWrite("grade", { kind: "unavailable", status: 503 });
    const started = rig.clock.now();
    expect(await rig.clock.run(rig.newWriteback().send([id]))).toEqual([{ id, state: "sent" }]);
    expect(rig.clock.now()).toBeGreaterThan(started);
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("holds as retries exhausted once maxAttempts is spent", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    for (let i = 0; i < 4; i++)
      rig.server.failNextWrite("grade", { kind: "unavailable", status: 503 });
    await rig.clock.run(rig.newWriteback().send([id]));
    const cause = heldCause(rig, id);
    expect(cause?.tag === "failed" && cause.retriesExhausted).toBe(true);
    expect(rig.writes).toHaveLength(4);
  });

  it("a rejected write holds for an edit rather than retrying", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    rig.server.failNextWrite("grade", { kind: "rejected", reason: "Grade is locked." });
    await rig.clock.run(rig.newWriteback().send([id]));
    expect(heldCause(rig, id)).toEqual({ tag: "rejected", reason: "Grade is locked." });
    expect(rig.writes).toHaveLength(1);
  });
});

describe("a lost response", () => {
  it("that landed is confirmed by a read after the settle window and never written twice", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.loseNextResponse();
    const started = rig.clock.now();
    expect(await rig.clock.run(rig.newWriteback().send([id]))).toEqual([{ id, state: "sent" }]);
    expect(rig.clock.now() - started).toBeGreaterThanOrEqual(2500);
    expect(rig.writes).toHaveLength(1);
    expect(fieldStatus(rig, id, "comment")).toMatchObject({ status: "landed", via: "observed" });
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("that did not land rests in doubt, and only a Resume press writes again", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.loseNextResponse(false);
    const writeback = rig.newWriteback();

    expect(await rig.clock.run(writeback.send([id]))).toEqual([{ id, state: "held" }]);
    expect(heldCause(rig, id)?.tag).toBe("in-doubt");
    expect(summarize(rig.ledger.get(id) as never).recovery).toBe("resume");
    expect(rig.writes).toHaveLength(1);
    expect(myComments(rig, submission)).toHaveLength(0);

    expect(await rig.clock.run(writeback.send([id]))).toEqual([{ id, state: "sent" }]);
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("a read that fails during settling also rests in doubt", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    rig.server.loseNextResponse();
    const send = rig.newWriteback().send([id]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fieldStatus(rig, id, "comment")?.status).toBe("unknown");
    rig.server.setNoise({ rate5xx: 1 });
    await rig.clock.run(send);
    expect(heldCause(rig, id)?.tag).toBe("in-doubt");
    expect(rig.writes).toHaveLength(1);
  });

  it("that lands late but inside the settle window is confirmed safely", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.lateLanding(1000);
    expect(await rig.clock.run(rig.newWriteback().send([id]))).toEqual([{ id, state: "sent" }]);
    expect(myComments(rig, submission)).toHaveLength(1);
    expect(rig.writes).toHaveLength(1);
  });

  it("KNOWN LIMIT: a write that lands past the settle window can double post after a human Resume", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.lateLanding(60_000);
    const writeback = rig.newWriteback();

    await rig.clock.run(writeback.send([id]));
    expect(heldCause(rig, id)?.tag).toBe("in-doubt");
    await rig.clock.run(writeback.send([id]));
    expect(rig.stateOf(id).tag).toBe("sent");
    expect(myComments(rig, submission)).toHaveLength(1);

    await rig.clock.flush();
    expect(myComments(rig, submission)).toHaveLength(2);
  });
});

describe("Check again", () => {
  it("finishes the change when the write has landed since, and writes nothing", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.lateLanding(60_000);
    const writeback = rig.newWriteback();
    await rig.clock.run(writeback.send([id]));
    expect(heldCause(rig, id)?.tag).toBe("in-doubt");
    await rig.clock.flush();
    const writes = rig.writes.length;

    const checked = await rig.clock.run(writeback.check(id));

    expect(checked.ok && checked.value.state.tag).toBe("sent");
    expect(rig.writes).toHaveLength(writes);
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("stays in doubt when the LMS still doesn't show the write, and writes nothing", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    rig.server.loseNextResponse(false);
    const writeback = rig.newWriteback();
    await rig.clock.run(writeback.send([id]));
    const writes = rig.writes.length;

    const checked = await rig.clock.run(writeback.check(id));

    expect(checked.ok).toBe(true);
    expect(heldCause(rig, id)?.tag).toBe("in-doubt");
    expect(rig.writes).toHaveLength(writes);
    expect(myComments(rig, submission)).toHaveLength(0);
  });

  it("reports a failed read and leaves the change in doubt", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    rig.server.loseNextResponse(false);
    const writeback = rig.newWriteback();
    await rig.clock.run(writeback.send([id]));
    rig.server.setNoise({ rate5xx: 1 });

    const checked = await rig.clock.run(writeback.check(id));

    expect(checked.ok).toBe(false);
    expect(heldCause(rig, id)?.tag).toBe("in-doubt");
  });

  it("can't send a change that was only approved, even when it's checked", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);

    await rig.clock.run(rig.newWriteback().check(id));

    expect(rig.stateOf(id).tag).toBe("approved");
    expect(rig.writes).toHaveLength(0);
  });
});

describe("a 429", () => {
  it("spends no attempt, however many arrive in a row", async () => {
    const rig = await makeRig();
    const { id, submission } = await rig.approvedGrade(LCC);
    for (let i = 0; i < 6; i++) rig.server.throttleNext(1000, "write");
    expect(await rig.clock.run(rig.newWriteback().send([id]))).toEqual([{ id, state: "sent" }]);
    const state = rig.stateOf(id);
    expect(state.tag === "sent" && state.run.attempt).toBe(1);
    expect(myComments(rig, submission)).toHaveLength(1);
  });

  it("pauses the whole lane for its retry-after, so no request from that school goes out meanwhile", async () => {
    const rig = await makeRig();
    const first = await rig.approvedGrade(LCC, 0);
    const second = await rig.approvedGrade(LCC, 1);
    rig.server.throttleNext(3000, "write");
    const writeback = rig.newWriteback();
    rig.server.log.length = 0;

    await rig.clock.run(writeback.send([first.id, second.id]));

    const requests = lmsRequests(rig);
    const throttled = requests.find((entry) => entry.result === "rate_limited");
    if (!throttled) throw new Error("The throttle never fired.");
    const later = requests[requests.indexOf(throttled) + 1];
    expect(later?.at).toBeGreaterThanOrEqual(throttled.at + 3000);
    expect(
      requests.filter((entry) => entry.at > throttled.at && entry.at < throttled.at + 3000),
    ).toEqual([]);
    expect(rig.stateOf(second.id).tag).toBe("sent");
  });

  it("shows the wait on the change while the lane is paused", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    rig.server.throttleNext(3000, "write");
    const writeback = rig.newWriteback();
    const send = writeback.send([id]);
    await rig.clock.run(Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = rig.stateOf(id);
    expect(state.tag === "sending" && state.run.waitingUntil).toBeGreaterThan(rig.clock.now());
    expect(summarize(rig.ledger.get(id) as never).label).toBe("Waiting on the LMS");
    expect(writeback.laneStatus(LCC)).toMatchObject({ state: "paused", reason: "rate-limited" });
    await rig.clock.run(send);
  });

  it("does not hold up another school", async () => {
    const rig = await makeRig();
    const slow = await rig.approvedGrade(LCC, 0);
    const other = await rig.approvedGrade(RSU, 0);
    rig.server.throttleNext(5000, "write");
    const writeback = rig.newWriteback();
    const finishedAt = new Map<ChangeId, number>();
    await rig.clock.run(
      writeback.send([slow.id, other.id], (result) => finishedAt.set(result.id, rig.clock.now())),
    );
    expect(finishedAt.get(other.id)).toBeLessThan(finishedAt.get(slow.id) as number);
  });
});

describe("a reload during a send", () => {
  /** Field applications that actually reached the LMS, read from its own durable state. */
  const landedWrites = (rig: Rig): number =>
    (JSON.parse(rig.storage.getItem(LMS_STORAGE_KEY) ?? "{}") as { seq: number }).seq;

  const SCENARIOS: Readonly<Record<string, (rig: Rig) => void>> = {
    "a clean send": () => undefined,
    "a send with a 429": (rig) => rig.server.throttleNext(1000, "write"),
    "a send whose response is lost after it landed": (rig) => rig.server.loseNextResponse(),
    "a send whose request is lost before it landed": (rig) => rig.server.loseNextResponse(false),
    "a send where the comment fails after the grade landed": (rig) =>
      rig.server.failNextWrite("comment", { kind: "unavailable", status: 500 }),
  };

  const crashAt = async (
    arm: (rig: Rig) => void,
    atCommit: number,
    when: "before-durable" | "after-durable",
  ) => {
    const rig = await makeRig();
    const submission = rig.toGrade(LCC)[0] as Submission;
    const content = {
      ...rig.contentFor(submission),
      attachment: { name: "feedback.pdf", kb: 200 },
    };
    const record = await rig.draft(LCC, content);
    rig.approve(record.id);
    arm(rig);
    rig.ledger.armCrash({ atCommit, when });
    const crashed = await rig.clock.run(
      rig
        .newWriteback()
        .send([record.id])
        .then(
          () => false,
          (error: unknown) => error instanceof SimulatedCrash,
        ),
    );
    rig.ledger.armCrash(null);
    // A write the crashed tab already handed to the LMS keeps its fate, so nothing armed survives the reload.
    await rig.clock.flush();

    const writeback = rig.reload();
    await rig.clock.run(writeback.recover());
    if (rig.stateOf(record.id).tag !== "sent") await rig.clock.run(writeback.send([record.id]));
    return { rig, id: record.id, submission, crashed, fields: fieldsOf(content).length };
  };

  for (const [name, arm] of Object.entries(SCENARIOS)) {
    for (const when of ["before-durable", "after-durable"] as const) {
      it(`${name}, crashing ${when} at every commit, ends sent with each field written exactly once`, async () => {
        let boundaries = 0;
        for (let atCommit = 1; ; atCommit++) {
          const { rig, id, submission, crashed, fields } = await crashAt(arm, atCommit, when);
          const at = `crash at commit ${atCommit}`;
          expect(rig.stateOf(id).tag, at).toBe("sent");
          expect(myComments(rig, submission), at).toHaveLength(1);
          expect(landedWrites(rig), at).toBe(fields);
          if (!crashed) break;
          boundaries += 1;
        }
        expect(boundaries).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it("a crash before the send is durable has written nothing, so no request ever leaves unrecorded", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    rig.ledger.armCrash({ atCommit: 1, when: "before-durable" });
    await rig.clock.run(
      rig
        .newWriteback()
        .send([id])
        .catch(() => undefined),
    );
    expect(rig.writes).toEqual([]);
    expect(rig.stateOf(id).tag).toBe("approved");
  });

  it("recover only reads", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    rig.ledger.armCrash({ atCommit: 1, when: "after-durable" });
    await rig.clock.run(
      rig
        .newWriteback()
        .send([id])
        .catch(() => undefined),
    );
    rig.ledger.armCrash(null);
    const writes = rig.writes.length;
    await rig.clock.run(rig.reload().recover());
    expect(rig.writes).toHaveLength(writes);
    expect(heldCause(rig, id)?.tag).toBe("interrupted");
    expect(summarize(rig.ledger.get(id) as never).recovery).toBe("resume");
  });

  it("recover leaves a change alone when another tab holds its lock", async () => {
    const rig = await makeRig();
    const { id } = await rig.approvedGrade(LCC);
    rig.ledger.armCrash({ atCommit: 1, when: "after-durable" });
    await rig.clock.run(
      rig
        .newWriteback()
        .send([id])
        .catch(() => undefined),
    );
    rig.ledger.armCrash(null);
    const heldLock = {
      request: (_name: string, _options: unknown, work: (lock: null) => Promise<unknown>) =>
        work(null),
    } as unknown as Pick<LockManager, "request">;
    const tab = createWriteback({
      ledger: rig.ledger,
      providerFor: rig.provider,
      markExpired: () => undefined,
      now: rig.clock.now,
      sleep: rig.clock.sleep,
      random: () => 0.5,
      policy: DEFAULT_RETRY_POLICY,
      locks: heldLock,
    });
    await rig.clock.run(tab.recover());
    expect(rig.stateOf(id).tag).toBe("sending");
  });
});

describe("reads through the lane", () => {
  it("a 429 on a read retries after the pause and returns the data", async () => {
    const rig = await makeRig();
    const writeback = rig.newWriteback();
    const provider = rig.provider(LCC);
    rig.server.throttleNext(2000);
    const result = await rig.clock.run(writeback.laneRead(LCC, () => provider.courses()));
    expect(result.ok).toBe(true);
    expect(rig.server.log.filter((entry) => entry.result === "rate_limited")).toHaveLength(1);
  });

  it("repeated 429s on a read give up and report the failure", async () => {
    const rig = await makeRig();
    const writeback = rig.newWriteback();
    const provider = rig.provider(LCC);
    for (let i = 0; i < 4; i++) rig.server.throttleNext(100);
    const result = await rig.clock.run(writeback.laneRead(LCC, () => provider.courses()));
    expect(result).toEqual({ ok: false, error: { kind: "rate_limited", retryAfterMs: 100 } });
  });
});

describe("laneRead", () => {
  const laneRig = async () => {
    const rig = await makeRig();
    return {
      rig,
      writeback: createWriteback({
        ledger: rig.ledger,
        providerFor: rig.provider,
        markExpired: () => undefined,
        now: rig.clock.now,
        sleep: rig.clock.sleep,
        random: () => 0.5,
        policy: DEFAULT_RETRY_POLICY,
        locks: null,
      }),
    };
  };
  const answers = (...results: readonly Result<string, LmsError>[]) => {
    let calls = 0;
    return {
      read: () =>
        Promise.resolve(results[Math.min(calls++, results.length - 1)] as Result<string, LmsError>),
      calls: () => calls,
    };
  };
  const UNAVAILABLE = { ok: false, error: { kind: "unavailable", status: 503 } } as const;

  it("a single 503 on a read is retried and succeeds", async () => {
    const { rig, writeback } = await laneRig();
    const { read, calls } = answers(UNAVAILABLE, { ok: true, value: "courses" });
    expect(await rig.clock.run(writeback.laneRead(LCC, read))).toEqual({
      ok: true,
      value: "courses",
    });
    expect(calls()).toBe(2);
  });

  it("a 503 that never clears gives up after the policy's attempts", async () => {
    const { rig, writeback } = await laneRig();
    const { read, calls } = answers(UNAVAILABLE);
    expect(await rig.clock.run(writeback.laneRead(LCC, read))).toEqual(UNAVAILABLE);
    expect(calls()).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
  });

  it("an expired token is not retried, since it can't get better by waiting", async () => {
    const { rig, writeback } = await laneRig();
    const { read, calls } = answers({ ok: false, error: { kind: "auth_expired" } });
    expect(await rig.clock.run(writeback.laneRead(LCC, read))).toEqual({
      ok: false,
      error: { kind: "auth_expired" },
    });
    expect(calls()).toBe(1);
  });
});
