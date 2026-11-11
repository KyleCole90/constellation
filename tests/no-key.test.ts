import { describe, expect, it } from "vite-plus/test";

import type { Agent } from "~/agent/agent";
import { createRuleAgent } from "~/agent/rules";
import { fingerprintOf } from "~/domain/approval";
import {
  finalGrade,
  summarize,
  transition,
  type ChangeContent,
  type ChangePatch,
  type ChangeRecord,
} from "~/domain/change";
import type { ChangeId, IsoTime, LmsRef, ThreadId } from "~/domain/ids";
import type { Assignment, Submission } from "~/domain/lms";
import { visibleMessages } from "~/components/thread/timeline.logic";
import { Secret } from "~/providers/provider";
import {
  selectCourseOverview,
  selectGradebook,
  selectQueueRows,
  selectThreadChanges,
  selectThreadStatus,
} from "~/stores/selectors";
import { WORKSPACE_STORAGE_KEY } from "~/stores/workspace";

import { clickWitness } from "./fixtures/changes";
import { VirtualClock } from "./fixtures/clock";
import { LCC, RSU } from "./fixtures/rig";
import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";
import { planFor, termOf } from "./fixtures/term";

const QUEUE = "t-queue" as ThreadId;
const KEY = new Secret("sk-a-real-looking-ai-key");

const spyAgent = () => {
  const inner = createRuleAgent();
  const runs: string[] = [];
  const agent: Agent = {
    label: inner.label,
    run: (input, signal) => {
      runs.push(input.request);
      return inner.run(input, signal);
    },
  };
  return { agent, runs };
};

const noKeyRig = async (options: Parameters<typeof makeStoreRig>[0] = {}) => {
  const spy = spyAgent();
  const rig = await makeStoreRig({ noKey: true, agent: spy.agent, ...options });
  await rig.connectAll();
  return { rig, runs: spy.runs };
};

const pairs = (rig: StoreRig) =>
  Object.values(rig.state().cache).flatMap((cache) =>
    cache.submissions.flatMap((submission) => {
      const assignment = cache.assignments.find((a) => a.ref === submission.assignment);
      return assignment ? [{ submission, assignment }] : [];
    }),
  );
const pick = (
  rig: StoreRig,
  wanted: (submission: Submission, assignment: Assignment) => boolean,
) => {
  const found = pairs(rig).find(({ submission, assignment }) => wanted(submission, assignment));
  if (!found) throw new Error("The seed has no such submission.");
  return found;
};
const ungraded = (submission: Submission) =>
  submission.workflow === "submitted" && submission.grade === null;
const withRubric = (rig: StoreRig) =>
  pick(rig, (s, a) => ungraded(s) && (a.rubric?.length ?? 0) >= 3 && s.lateDays === 0);
const withoutRubric = (rig: StoreRig) =>
  pick(rig, (s, a) => ungraded(s) && (a.rubric?.length ?? 0) === 0 && s.lateDays === 0);

const open = async (rig: StoreRig, submission: Submission, thread = QUEUE): Promise<ChangeId> => {
  const id = await rig.clock.run(rig.state().openSubmission(thread, submission.ref));
  if (!id) throw new Error("Nothing opened.");
  return id;
};
const atNow = (rig: StoreRig) => new Date(rig.state().now()).toISOString() as IsoTime;
const edit = (rig: StoreRig, id: ChangeId, patch: ChangePatch) =>
  rig.state().dispatchUser(id, { type: "edit", by: "you", patch, at: atNow(rig) });
const editOk = (rig: StoreRig, id: ChangeId, patch: ChangePatch) => {
  const result = edit(rig, id, patch);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const saved = (rig: StoreRig, id: ChangeId): ChangeRecord => {
  const record = rig.state().changes[id];
  if (!record) throw new Error("Not saved.");
  return record;
};
const approve = (rig: StoreRig, id: ChangeId) =>
  rig
    .state()
    .dispatchUser(id, { type: "approve", witness: clickWitness(saved(rig, id)), at: atNow(rig) });
const send = (rig: StoreRig, id: ChangeId) => rig.clock.run(rig.state().sendChanges([id]));
const approveAndSend = async (rig: StoreRig, id: ChangeId) => {
  expect(approve(rig, id).ok).toBe(true);
  await send(rig, id);
  expect(saved(rig, id).state.tag).toBe("sent");
};
const onServer = (rig: StoreRig, submission: Submission) =>
  rig.server.submissions(submission.course).find((s) => s.ref === submission.ref);
const stored = (rig: StoreRig) =>
  JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as {
    state: { changes: Record<string, ChangeRecord> };
  };
const reload = async (rig: StoreRig, options: Parameters<typeof makeStoreRig>[0] = {}) => {
  const next = await makeStoreRig({
    noKey: true,
    storage: rig.storage,
    vault: rig.vault,
    clock: new VirtualClock(rig.clock.now()),
    ...options,
  });
  await next.clock.run(next.state().boot());
  return next;
};
const gradingThreadOf = (rig: StoreRig, assignment: LmsRef<"assignment">): ThreadId => {
  const thread = Object.values(rig.state().threads).find(
    (t) => t.kind === "grading" && t.assignment === assignment,
  );
  if (!thread) throw new Error("No grading thread.");
  return thread.id;
};
const criteriaOf = (assignment: Assignment) => assignment.rubric ?? [];

describe("opening with no key", () => {
  it("a submission gives an unscored blank form, saves nothing, and runs no agent", async () => {
    const { rig, runs } = await noKeyRig();
    const { submission, assignment } = withRubric(rig);
    const id = await open(rig, submission);

    const form = rig.state().blanks[id];
    expect(form?.content).toMatchObject({
      kind: "grade",
      target: submission.ref,
      comment: null,
      attachment: null,
    });
    expect(
      form?.content.kind === "grade" && form.content.rubric?.map((score) => score.points),
    ).toEqual(criteriaOf(assignment).map(() => null));
    expect(form?.rationale ?? []).toHaveLength(0);
    expect(rig.state().threads[QUEUE]?.focus).toBe(id);
    expect(rig.state().changes).toEqual({});
    expect(stored(rig).state.changes).toEqual({});
    expect(runs).toEqual([]);
  });

  it("a conversation gives an empty reply, saves nothing, and runs no agent", async () => {
    const { rig, runs } = await noKeyRig();
    const conversation = Object.values(rig.state().cache).flatMap(
      (cache) => cache.conversations,
    )[0];
    if (!conversation) throw new Error("The seed has no conversation.");
    const id = await rig.clock.run(rig.state().openConversation(QUEUE, conversation.ref));

    expect(id && rig.state().blanks[id]?.content).toMatchObject({
      kind: "reply",
      target: conversation.ref,
      body: "",
    });
    expect(rig.state().changes).toEqual({});
    expect(stored(rig).state.changes).toEqual({});
    expect(runs).toEqual([]);
  });

  it("an announcement gives an empty title and body, saves nothing, and runs no agent", async () => {
    const { rig, runs } = await noKeyRig();
    const course = Object.values(rig.state().cache).flatMap((cache) => cache.courses)[0];
    if (!course) throw new Error("The seed has no course.");
    const id = await rig.clock.run(rig.state().openAnnouncement(QUEUE, course.ref));

    expect(id && rig.state().blanks[id]?.content).toMatchObject({
      kind: "announcement",
      target: course.ref,
      title: "",
      body: "",
    });
    expect(rig.state().changes).toEqual({});
    expect(stored(rig).state.changes).toEqual({});
    expect(runs).toEqual([]);
  });

  it("the thread shows the focused blank to its card and panel", async () => {
    const { rig } = await noKeyRig();
    const id = await open(rig, withRubric(rig).submission);
    expect(selectThreadChanges(rig.state(), QUEUE).map((change) => change.id)).toEqual([id]);
    expect(rig.state().previewFor(id)).toEqual([]);
  });

  it("arrowing across three students leaves every row, cell and status as it was", async () => {
    const { rig } = await noKeyRig();
    const { assignment } = withRubric(rig);
    const rows = pairs(rig)
      .filter((pair) => pair.assignment.ref === assignment.ref && ungraded(pair.submission))
      .slice(0, 3);
    expect(rows).toHaveLength(3);
    const thread = gradingThreadOf(rig, assignment.ref);
    const before = selectThreadStatus(rig.state(), thread);
    const toGrade = selectQueueRows(rig.state(), assignment.ref).filter((row) => row.open).length;
    expect(before).toEqual({ label: `${toGrade} to grade`, tone: "todo" });

    for (const row of rows) await open(rig, row.submission, thread);

    for (const row of selectQueueRows(rig.state(), assignment.ref)) expect(row.change).toBeNull();
    const cells =
      selectGradebook(rig.state(), assignment.course)?.rows.flatMap((row) => row.cells) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((cell) => cell.pending === null)).toBe(true);
    expect(selectThreadStatus(rig.state(), thread)).toEqual(before);
    expect(rig.state().changes).toEqual({});
  });

  it("reopening a blank keeps its id and rereads the LMS", async () => {
    const { rig } = await noKeyRig();
    const first = withRubric(rig);
    const second = pick(rig, (s) => ungraded(s) && s.ref !== first.submission.ref);
    const id = await open(rig, first.submission);
    const readAt = rig.state().blanks[id]?.basis.readAt;
    await open(rig, second.submission);
    await rig.clock.run(rig.clock.sleep(5000));

    expect(await open(rig, first.submission)).toBe(id);
    expect(rig.state().threads[QUEUE]?.focus).toBe(id);
    expect(rig.state().blanks[id]?.basis.readAt).not.toBe(readAt);
  });

  it("a failed LMS read leaves a notice and no form", async () => {
    const { rig } = await noKeyRig();
    const { submission } = withRubric(rig);
    rig.server.expireToken(submission.school);

    expect(await rig.clock.run(rig.state().openSubmission(QUEUE, submission.ref))).toBeNull();

    expect(rig.state().blanks).toEqual({});
    const shown = visibleMessages(rig.state().threads[QUEUE]?.messages ?? [], false, false);
    expect(shown.at(-1)).toMatchObject({
      type: "notice",
      text: expect.stringContaining("Couldn't read the LMS"),
    });
  });

  it("the composer's send does nothing, so no chat line appears", async () => {
    const { rig, runs } = await noKeyRig();
    const before = rig.state().threads[QUEUE]?.messages;
    await rig.clock.run(rig.state().sendToAgent(QUEUE, "Draft this."));
    expect(rig.state().threads[QUEUE]?.messages).toEqual(before);
    expect(runs).toEqual([]);
  });
});

describe("the first edit", () => {
  it("moves the blank into changes under the same id, keeps focus, and credits you", async () => {
    const { rig } = await noKeyRig();
    const id = await open(rig, withRubric(rig).submission);

    editOk(rig, id, { kind: "grade", comment: "Good start." });

    expect(rig.state().blanks[id]).toBeUndefined();
    expect(saved(rig, id).content).toMatchObject({ comment: "Good start." });
    expect(stored(rig).state.changes[id]).toBeDefined();
    expect(rig.state().threads[QUEUE]?.focus).toBe(id);
    expect(saved(rig, id).activity[0]?.actor).toBe("you");
  });

  it("is refused for anything but an edit, and leaves the form alone", async () => {
    const { rig } = await noKeyRig();
    const id = await open(rig, withRubric(rig).submission);
    const form = rig.state().blanks[id];
    if (!form) throw new Error("No form.");

    expect(rig.state().dispatchUser(id, { type: "discard", at: atNow(rig) })).toEqual({
      ok: false,
      error: "not-editable",
    });
    expect(
      rig
        .state()
        .dispatchUser(id, { type: "approve", witness: clickWitness(form), at: atNow(rig) }),
    ).toEqual({ ok: false, error: "not-editable" });

    expect(rig.state().changes).toEqual({});
    expect(rig.state().blanks[id]).toBe(form);
  });

  it("gives way to a draft another tab saved for the same student", async () => {
    const { rig } = await noKeyRig();
    const { submission } = withRubric(rig);
    const id = await open(rig, submission);
    const other = await makeStoreRig({
      noKey: true,
      storage: rig.storage,
      vault: rig.vault,
      clock: new VirtualClock(rig.clock.now() + 60_000),
    });
    const theirs = await open(other, submission);
    editOk(other, theirs, { kind: "grade", comment: "From the other tab." });

    expect(edit(rig, id, { kind: "grade", comment: "From this tab." })).toEqual({
      ok: false,
      error: "not-editable",
    });

    expect(rig.state().blanks[id]).toBeUndefined();
    expect(rig.state().threads[QUEUE]?.focus).toBe(theirs);
    expect(rig.state().changes[theirs]?.content).toMatchObject({ comment: "From the other tab." });
    expect(rig.state().changes[id]).toBeUndefined();
  });
});

describe("a partly filled grade", () => {
  it("cannot be approved, names what's left, and reads In progress", async () => {
    const { rig } = await noKeyRig();
    const { submission, assignment } = withRubric(rig);
    const [first, ...rest] = criteriaOf(assignment);
    if (!first) throw new Error("No criteria.");
    const thread = gradingThreadOf(rig, assignment.ref);
    const id = await open(rig, submission, thread);

    editOk(rig, id, { kind: "grade", rubricPoints: { [first.ref]: 1 } });

    const summary = summarize(saved(rig, id));
    expect(summary.canApprove).toBe(false);
    expect(summary.missing).toEqual(rest.map((criterion) => criterion.name));
    expect(
      selectCourseOverview(rig.state(), assignment.course, rig.state().now())?.needsApproval,
    ).toBe(0);
    expect(selectThreadStatus(rig.state(), thread)).toEqual({ label: "In progress", tone: "todo" });
  });

  it("with a real click still never posts a 0 for the unset rubric score", async () => {
    const { rig } = await noKeyRig();
    const { submission, assignment } = withRubric(rig);
    const [first, second] = criteriaOf(assignment);
    if (!first || !second) throw new Error("No criteria.");
    const before = onServer(rig, submission);
    const id = await open(rig, submission);
    editOk(rig, id, { kind: "grade", rubricPoints: { [first.ref]: 2, [second.ref]: 3 } });

    expect(approve(rig, id)).toEqual({ ok: false, error: "incomplete" });
    await send(rig, id);

    expect(saved(rig, id).state.tag).toBe("draft");
    expect(rig.server.writes()).toEqual([]);
    expect(onServer(rig, submission)?.grade).toBe(before?.grade);
    expect(onServer(rig, submission)?.rubricScores).toEqual(before?.rubricScores);
  });

  it("with no rubric and only a comment never posts a 0", async () => {
    const { rig } = await noKeyRig();
    const { submission } = withoutRubric(rig);
    const id = await open(rig, submission);
    editOk(rig, id, { kind: "grade", comment: "Comment, no score." });

    expect(summarize(saved(rig, id)).missing).toEqual(["Score"]);
    expect(approve(rig, id)).toEqual({ ok: false, error: "incomplete" });
    await send(rig, id);

    expect(rig.server.writes()).toEqual([]);
    expect(onServer(rig, submission)?.grade).toBeNull();
  });

  it("at a school with no rubric write never posts a 0, and asks for one overall score", async () => {
    const { rig } = await noKeyRig({ capabilities: { rubricWrite: false } });
    const { submission } = withRubric(rig);
    const id = await open(rig, submission);
    expect(rig.state().blanks[id]?.content).toMatchObject({ rubric: null, points: null });
    editOk(rig, id, { kind: "grade", comment: "Comment, no score." });

    expect(approve(rig, id)).toEqual({ ok: false, error: "incomplete" });
    await send(rig, id);
    expect(rig.server.writes()).toEqual([]);
    expect(onServer(rig, submission)?.grade).toBeNull();

    editOk(rig, id, { kind: "grade", points: 7 });
    await approveAndSend(rig, id);
    expect(onServer(rig, submission)?.grade).toBe(7);
    expect(onServer(rig, submission)?.rubricScores).toBeNull();
  });

  it("forged as approved in storage does not post", async () => {
    const { rig } = await noKeyRig();
    const { submission, assignment } = withRubric(rig);
    const before = onServer(rig, submission);
    const id = await open(rig, submission);
    editOk(rig, id, {
      kind: "grade",
      rubricPoints: Object.fromEntries(
        criteriaOf(assignment).map((criterion) => [criterion.ref, 1]),
      ),
    });
    expect(approve(rig, id).ok).toBe(true);

    const raw = JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as {
      state: { changes: Record<string, ChangeRecord> };
    };
    const record = raw.state.changes[id] as ChangeRecord;
    if (record.content.kind !== "grade" || record.state.tag !== "approved")
      throw new Error("Expected an approved grade.");
    const forged = {
      ...record,
      content: {
        ...record.content,
        rubric: (record.content.rubric ?? []).map((score) => ({ ...score, points: null })),
      },
    } as ChangeRecord;
    raw.state.changes[id] = {
      ...forged,
      state: {
        tag: "approved",
        approval: { ...record.state.approval, fingerprint: fingerprintOf(forged) },
      },
    };
    rig.storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(raw));

    const next = await reload(rig);
    const held = saved(next, id);
    expect(held.state.tag === "approved" && held.state.approval.fingerprint).toBe(
      fingerprintOf(held),
    );
    expect(transition(held, { type: "begin-send", seen: {}, at: atNow(next) })).toEqual({
      ok: false,
      error: "not-sendable",
    });

    await send(next, id);

    expect(saved(next, id).state.tag).toBe("approved");
    expect(next.server.writes()).toEqual([]);
    expect(onServer(next, submission)?.grade).toBe(before?.grade);
    expect(onServer(next, submission)?.rubricScores).toEqual(before?.rubricScores);
  });
});

describe("a finished form sends as today", () => {
  it("an explicitly entered 0 posts as 0", async () => {
    const { rig } = await noKeyRig();
    const { submission } = withoutRubric(rig);
    const id = await open(rig, submission);

    editOk(rig, id, { kind: "grade", points: 0 });
    await approveAndSend(rig, id);

    expect(onServer(rig, submission)?.grade).toBe(0);
  });

  it("every rubric score entered as 0 posts a total of 0", async () => {
    const { rig } = await noKeyRig();
    const { submission, assignment } = withRubric(rig);
    const id = await open(rig, submission);

    editOk(rig, id, {
      kind: "grade",
      rubricPoints: Object.fromEntries(
        criteriaOf(assignment).map((criterion) => [criterion.ref, 0]),
      ),
    });
    await approveAndSend(rig, id);

    expect(onServer(rig, submission)?.grade).toBe(0);
  });

  it("a late submission lands the raw score minus the penalty", async () => {
    const { rig } = await noKeyRig();
    const { submission, assignment } = pick(
      rig,
      (s, a) =>
        ungraded(s) && s.lateDays > 0 && Boolean(a.latePointsPerDay) && (a.rubric?.length ?? 0) > 0,
    );
    const scores = criteriaOf(assignment).map(
      (criterion) => [criterion.ref, criterion.maxPoints] as const,
    );
    const raw = scores.reduce((sum, [, points]) => sum + points, 0);
    const expected = raw - submission.lateDays * (assignment.latePointsPerDay ?? 0);
    const id = await open(rig, submission);

    const filled = editOk(rig, id, { kind: "grade", rubricPoints: Object.fromEntries(scores) });
    expect(filled.content.kind === "grade" && finalGrade(filled.content)).toBe(expected);
    await approveAndSend(rig, id);

    expect(onServer(rig, submission)?.grade).toBe(expected);
  });

  it("a filled grade sends its rubric and comment to the LMS", async () => {
    const { rig } = await noKeyRig();
    const { submission, assignment } = withRubric(rig);
    const scores = Object.fromEntries(
      criteriaOf(assignment).map((criterion) => [criterion.ref, 2]),
    );
    const id = await open(rig, submission);

    editOk(rig, id, { kind: "grade", rubricPoints: scores, comment: "Thanks for this." });
    await approveAndSend(rig, id);

    const landed = onServer(rig, submission);
    expect(landed?.grade).toBe(criteriaOf(assignment).length * 2);
    expect(landed?.comments.at(-1)?.text).toBe("Thanks for this.");
  });

  it("a filled reply reaches the conversation", async () => {
    const { rig } = await noKeyRig();
    const conversation = Object.values(rig.state().cache).flatMap(
      (cache) => cache.conversations,
    )[0];
    if (!conversation) throw new Error("The seed has no conversation.");
    const id = await rig.clock.run(rig.state().openConversation(QUEUE, conversation.ref));
    if (!id) throw new Error("Nothing opened.");

    editOk(rig, id, { kind: "reply", body: "Yes, that works." });
    await approveAndSend(rig, id);

    expect(
      rig.server
        .conversations(conversation.school)
        .find((c) => c.ref === conversation.ref)
        ?.messages.at(-1)?.text,
    ).toBe("Yes, that works.");
  });

  it("a filled announcement is posted", async () => {
    const { rig } = await noKeyRig();
    const course = Object.values(rig.state().cache).flatMap((cache) => cache.courses)[0];
    if (!course) throw new Error("The seed has no course.");
    const id = await rig.clock.run(rig.state().openAnnouncement(QUEUE, course.ref));
    if (!id) throw new Error("Nothing opened.");

    editOk(rig, id, { kind: "announcement", title: "Room change", body: "We meet in 204." });
    await approveAndSend(rig, id);

    expect(
      rig.server
        .announcements(course.ref)
        .some((a) => a.title === "Room change" && a.body === "We meet in 204."),
    ).toBe(true);
  });
});

describe("a form returned to blank", () => {
  it("clearing the only score drops the saved draft, keeps focus, and the status reads as before", async () => {
    const { rig } = await noKeyRig();
    const { submission, assignment } = withRubric(rig);
    const [first] = criteriaOf(assignment);
    if (!first) throw new Error("No criteria.");
    const thread = gradingThreadOf(rig, assignment.ref);
    const before = selectThreadStatus(rig.state(), thread);
    const id = await open(rig, submission, thread);

    editOk(rig, id, { kind: "grade", rubricPoints: { [first.ref]: 10 } });
    expect(stored(rig).state.changes[id]).toBeDefined();
    editOk(rig, id, { kind: "grade", rubricPoints: { [first.ref]: null } });

    expect(rig.state().changes[id]).toBeUndefined();
    expect(stored(rig).state.changes[id]).toBeUndefined();
    expect(rig.state().blanks[id]?.activity).toHaveLength(1);
    expect(rig.state().threads[thread]?.focus).toBe(id);
    expect(selectThreadStatus(rig.state(), thread)).toEqual(before);
  });

  it("an emptied reply is dropped and cannot be approved", async () => {
    const { rig } = await noKeyRig();
    const conversation = Object.values(rig.state().cache).flatMap(
      (cache) => cache.conversations,
    )[0];
    if (!conversation) throw new Error("The seed has no conversation.");
    const id = await rig.clock.run(rig.state().openConversation(QUEUE, conversation.ref));
    if (!id) throw new Error("Nothing opened.");
    const form = rig.state().blanks[id];
    if (!form) throw new Error("No form.");

    editOk(rig, id, { kind: "reply", body: "Almost." });
    editOk(rig, id, { kind: "reply", body: "   " });

    expect(rig.state().changes[id]).toBeUndefined();
    expect(
      rig
        .state()
        .dispatchUser(id, { type: "approve", witness: clickWitness(form), at: atNow(rig) }),
    ).toEqual({ ok: false, error: "not-editable" });
    expect(rig.server.writes()).toEqual([]);
  });
});

describe("adding and removing a key", () => {
  it("adding one clears an untouched blank, and the next open runs the agent", async () => {
    const { rig, runs } = await noKeyRig();
    const { submission } = withRubric(rig);
    await open(rig, submission);

    await rig.clock.run(rig.state().addAiKey(KEY));

    expect(rig.state().aiOn()).toBe(true);
    expect(rig.state().blanks).toEqual({});
    expect(rig.state().threads[QUEUE]?.focus).toBeNull();

    const drafted = await open(rig, submission);
    expect(runs).toHaveLength(1);
    expect(saved(rig, drafted).activity[0]?.actor).toBe("agent");
    expect(summarize(saved(rig, drafted)).missing).toEqual([]);
  });

  it("adding one keeps a partly filled draft, and the agent doesn't replace it", async () => {
    const { rig, runs } = await noKeyRig();
    const { submission, assignment } = withRubric(rig);
    const [first] = criteriaOf(assignment);
    if (!first) throw new Error("No criteria.");
    const id = await open(rig, submission);
    const partial = editOk(rig, id, { kind: "grade", rubricPoints: { [first.ref]: 1 } });

    await rig.clock.run(rig.state().addAiKey(KEY));
    expect(rig.state().threads[QUEUE]?.focus).toBe(id);

    expect(await open(rig, submission)).toBe(id);
    expect(saved(rig, id)).toEqual(partial);
    expect(runs).toEqual([]);
  });

  it("removing one keeps an agent draft sendable, and the next new target is blank", async () => {
    const { rig, runs } = await noKeyRig();
    const first = withRubric(rig);
    const second = pick(rig, (s) => ungraded(s) && s.ref !== first.submission.ref);
    await rig.clock.run(rig.state().addAiKey(KEY));
    const drafted = await open(rig, first.submission);
    expect(runs).toHaveLength(1);

    await rig.clock.run(rig.state().turnOffAi());

    expect(rig.state().aiOn()).toBe(false);
    expect(saved(rig, drafted).activity[0]?.actor).toBe("agent");
    const blank = await open(rig, second.submission);
    expect(rig.state().blanks[blank]).toBeDefined();
    expect(rig.state().changes[blank]).toBeUndefined();
    expect(runs).toHaveLength(1);
    await approveAndSend(rig, drafted);
    expect(onServer(rig, first.submission)?.grade).not.toBeNull();
  });

  it("the stored chat is hidden with no key, untouched, and back when a key is added", async () => {
    const { rig } = await noKeyRig();
    const chatty = Object.values(rig.state().threads).find((thread) =>
      thread.messages.some((message) => message.type !== "notice"),
    );
    if (!chatty) throw new Error("The seed has no chat.");
    const before = chatty.messages;

    await open(rig, withRubric(rig).submission, chatty.id);
    const during = rig.state().threads[chatty.id]?.messages ?? [];
    expect(during).toEqual(before);
    expect(
      visibleMessages(during, false, false).filter((message) => message.type !== "notice"),
    ).toEqual([]);

    await rig.clock.run(rig.state().addAiKey(KEY));
    expect(
      visibleMessages(rig.state().threads[chatty.id]?.messages ?? [], rig.state().aiOn(), false),
    ).toEqual(before);
  });

  it("with aiAlways on and no key, opening still runs the agent", async () => {
    const spy = spyAgent();
    const rig = await makeStoreRig({ agent: spy.agent });
    await rig.connectAll();
    expect(rig.state().aiSource).toBe("none");

    const id = await open(rig, withRubric(rig).submission);

    expect(spy.runs).toHaveLength(1);
    expect(rig.state().changes[id]).toBeDefined();
    expect(rig.state().blanks).toEqual({});
  });
});

describe("a blank when AI turns on or another tab is open", () => {
  it("isn't saved by spaces alone", async () => {
    const { rig } = await noKeyRig();
    const id = await open(rig, withRubric(rig).submission);

    expect(edit(rig, id, { kind: "grade", comment: "   " }).ok).toBe(true);

    expect(rig.state().changes[id]).toBeUndefined();
    expect(rig.state().blanks[id]).toBeDefined();
  });

  it("isn't placed when a key is saved during its read", async () => {
    const { rig } = await noKeyRig();
    const opening = rig.state().openSubmission(QUEUE, withRubric(rig).submission.ref);
    await rig.clock.run(rig.state().addAiKey(KEY));

    await rig.clock.run(opening);

    expect(rig.state().blanks).toEqual({});
    expect(rig.state().threads[QUEUE]?.focus).toBeNull();
  });

  it("goes away when another tab adds a key", async () => {
    let notify = () => {};
    const { rig } = await noKeyRig({ subscribeStorage: (onChange) => (notify = onChange) });
    await open(rig, withRubric(rig).submission);
    const other = await makeStoreRig({
      noKey: true,
      storage: rig.storage,
      vault: rig.vault,
      clock: new VirtualClock(rig.clock.now()),
    });
    await other.clock.run(other.state().addAiKey(KEY));

    notify();

    expect(rig.state().blanks).toEqual({});
    expect(rig.state().threads[QUEUE]?.focus).toBeNull();
    expect(rig.state().prefs.threadUi[QUEUE]).toMatchObject({ current: null, queueOpen: true });
  });

  it("stays in focus when another tab opens a blank of its own", async () => {
    const { rig } = await noKeyRig();
    const { submission } = withRubric(rig);
    const id = await open(rig, submission);
    const other = await makeStoreRig({
      noKey: true,
      storage: rig.storage,
      vault: rig.vault,
      clock: new VirtualClock(rig.clock.now() + 60_000),
    });
    await other.clock.run(other.state().boot());
    const theirs = await open(
      other,
      pick(other, (s, a) => ungraded(s) && (a.rubric?.length ?? 0) >= 3 && s.ref !== submission.ref)
        .submission,
    );
    expect(theirs).not.toBe(id);

    rig.store.syncFromStorage();

    expect(rig.state().threads[QUEUE]?.focus).toBe(id);
  });
});

describe("focus on a form that isn't there", () => {
  it("is tolerated in the thread's changes and cleared at boot", async () => {
    const { rig } = await noKeyRig();
    await open(rig, withRubric(rig).submission);

    const second = await makeStoreRig({
      noKey: true,
      storage: rig.storage,
      vault: rig.vault,
      clock: new VirtualClock(rig.clock.now()),
    });
    expect(second.state().threads[QUEUE]?.focus).not.toBeNull();
    expect(selectThreadChanges(second.state(), QUEUE)).toEqual([]);

    await second.clock.run(second.state().boot());
    expect(second.state().threads[QUEUE]?.focus).toBeNull();
    expect(second.state().changes).toEqual({});
    expect(second.state().prefs.threadUi[QUEUE]).toMatchObject({
      current: null,
      queueOpen: true,
      panel: null,
    });
  });

  it("disconnecting a school drops only its blanks", async () => {
    const { rig } = await noKeyRig();
    const lcc = pick(rig, (s) => ungraded(s) && s.school === LCC);
    const rsu = pick(rig, (s) => ungraded(s) && s.school === RSU);
    const thread = rig
      .state()
      .createThread({ kind: "general", school: null, course: null, title: "Scratch" });
    const held = await open(rig, rsu.submission, thread);
    await open(rig, lcc.submission, thread);

    await rig.clock.run(rig.state().disconnect(LCC));

    expect(Object.keys(rig.state().blanks)).toEqual([held]);
    expect(rig.state().threads[thread]?.focus).toBeNull();
  });
});

describe("course setup with no key", () => {
  it("scanning gives rule fixes, calls no agent, and keeps the rule's words", async () => {
    const agent: Agent = {
      label: "Stub",
      async *run(input) {
        calls += 1;
        const finding = input.scope.scan?.findings.find(
          (entry) => entry.fix?.kind === "text-fix" && entry.item !== null,
        );
        if (finding?.item)
          yield {
            type: "finding",
            findingType: finding.type,
            item: finding.item,
            quote: finding.quote,
            why: "Said by the agent.",
            after: "Written by the agent.",
          };
      },
    };
    let calls = 0;
    const rig = await makeStoreRig({ noKey: true, agent });
    await rig.connectAll();
    const shell = rig.state().newCourses[LCC]?.find((entry) => entry.code === "ENG 101");
    if (!shell) throw new Error("ENG 101 isn't offered.");
    const course = shell.ref;
    rig.state().startSetup(course);
    await rig.clock.run(rig.state().loadSetupOptions(LCC));
    const source = rig
      .state()
      .setupOptions[LCC]?.sources.find(
        (entry) => entry.code === "ENG 101" && entry.termName === "Fall 2026",
      );
    if (!source) throw new Error("No source.");
    expect(
      rig.state().chooseSource(course, {
        kind: "course",
        ref: source.ref,
        label: `${source.code}, ${source.termName}`,
        termName: source.termName,
      }),
    ).toBeNull();
    expect(
      await rig.clock.run(rig.state().confirmDates(course, planFor(termOf(source), shell))),
    ).toBeNull();
    const copy = rig.state().setups[course]?.copy;
    if (!copy) throw new Error("No copy.");
    expect(approve(rig, copy).ok).toBe(true);
    await send(rig, copy);
    const waiting = async () => {
      for (let step = 0; step < 2000 && !rig.state().setups[course]?.scan; step++)
        await rig.clock.sleep(50);
    };
    await rig.clock.run(waiting());

    const setup = rig.state().setups[course];
    const findings = setup?.scan?.findings ?? [];
    expect(findings.some((finding) => finding.fix?.kind === "text-fix")).toBe(true);
    expect(Object.keys(setup?.fixes ?? {}).length).toBeGreaterThan(0);
    expect(findings.some((finding) => finding.why === "Said by the agent.")).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("a workspace saved before this", () => {
  const CONTENT_AT_549E11D = {
    kind: "grade",
    target: "lcc:submission:1:2:3",
    points: null,
    outOf: 100,
    rubric: [
      { criterion: "lcc:criterion:2:thesis", name: "Thesis", points: 18, outOf: 25 },
      { criterion: "lcc:criterion:2:evidence", name: "Evidence", points: 0, outOf: 25 },
    ],
    late: { days: 1, pointsPerDay: 2 },
    comment: "Strong opening. Keep going.",
    attachment: null,
  } as unknown as ChangeContent;
  const FINGERPRINT_AT_549E11D = "1fd3d0b7e7605f";

  it("rehydrates, and its approved fingerprint still matches", async () => {
    const { rig } = await noKeyRig();
    const raw = JSON.parse(rig.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}") as {
      state: { changes: Record<string, unknown> };
    };
    const at = "2026-10-30T12:00:00.000Z";
    raw.state.changes["ch-old"] = {
      id: "ch-old",
      school: "lcc",
      course: "lcc:course:1",
      subject: "Maya Ortiz, Essay 2",
      content: CONTENT_AT_549E11D,
      basis: {
        readAt: at,
        remote: {
          kind: "grade",
          targetVersion: "attempt:1",
          grade: null,
          rubric: null,
          comments: [],
          attachments: [],
        },
      },
      landed: [],
      seen: null,
      rationale: [],
      activity: [{ at, actor: "agent", text: "Drafted" }],
      state: {
        tag: "approved",
        approval: { changeId: "ch-old", fingerprint: FINGERPRINT_AT_549E11D, at, via: "button" },
      },
    };
    rig.storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(raw));

    const next = await reload(rig);

    const record = saved(next, "ch-old" as ChangeId);
    expect(record.content.kind === "grade" && finalGrade(record.content)).toBe(16);
    expect(fingerprintOf(record)).toBe(FINGERPRINT_AT_549E11D);
    expect(summarize(record).missing).toEqual([]);
    expect(transition(record, { type: "begin-send", seen: {}, at: at as IsoTime }).ok).toBe(true);
  });
});
