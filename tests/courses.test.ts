import { describe, expect, it } from "vite-plus/test";

import { filterInbox } from "~/renderer/components/screens/inbox.logic";
import { fromInboxRows } from "~/renderer/components/thread/queue.logic";
import type { ChangeId, LmsRef, ThreadId } from "~/shared/domain/ids";
import { LMS_STORAGE_KEY } from "~/shared/providers/fake-canvas/server";
import { INBOX_THREAD, selectInboxRows, selectQueueRows } from "~/renderer/stores/selectors";

import { clickWitness } from "./fixtures/changes";
import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const QUEUE = "t-queue" as ThreadId;

const connected = async (): Promise<StoreRig> => {
  const rig = await makeStoreRig();
  await rig.connectAll();
  return rig;
};

const submissionOf = (rig: StoreRig, student: string): LmsRef<"submission"> => {
  const row = selectQueueRows(rig.state()).find(
    (candidate) => candidate.submission.studentName === student,
  );
  if (!row) throw new Error(`No queue row for ${student}.`);
  return row.submission.ref;
};

const draft = async (rig: StoreRig, student: string): Promise<ChangeId> => {
  const id = await rig.clock.run(
    rig.state().openSubmission(QUEUE, submissionOf(rig, student), { fill: "draft" }),
  );
  if (!id) throw new Error(`No draft for ${student}.`);
  return id;
};

const taggedLinesIn = (rig: StoreRig, thread: ThreadId, id: ChangeId): string =>
  JSON.stringify(rig.state().threads[thread]?.messages.filter((message) => message.change === id));
const taggedLines = (rig: StoreRig, id: ChangeId): string => taggedLinesIn(rig, QUEUE, id);

describe("a thread's messages know which change they belong to", () => {
  it("each draft's work lines and the agent's replies are filed under that student's change", async () => {
    const rig = await connected();
    const maya = await draft(rig, "Maya Ortiz");
    const priya = await draft(rig, "Priya Raman");
    const workFiledUnder = (id: ChangeId) =>
      rig
        .state()
        .threads[QUEUE]?.messages.filter(
          (message) => message.type === "work" && message.change === id,
        ).length;
    expect(workFiledUnder(maya)).toBe(1);
    expect(workFiledUnder(priya)).toBe(1);
    expect(taggedLines(rig, maya)).not.toContain("Priya");
    await rig.state().sendToAgent(QUEUE, "make it warmer");
    expect(taggedLines(rig, priya)).toContain('"type":"agent"');
    expect(taggedLines(rig, maya)).not.toContain('"type":"agent"');
  });

  it("a thread's own opening messages have no change", async () => {
    const rig = await connected();
    await draft(rig, "Maya Ortiz");
    expect(rig.state().threads[QUEUE]?.messages[0]).not.toHaveProperty("change");
  });

  it("a correction and its answer are filed under the change that was focused", async () => {
    const rig = await connected();
    const maya = await draft(rig, "Maya Ortiz");
    await draft(rig, "Priya Raman");
    rig.state().focusChange(QUEUE, maya);
    await rig.clock.run(rig.state().sendToAgent(QUEUE, "make it warmer"));
    expect(taggedLines(rig, maya)).toContain("make it warmer");
    expect(taggedLines(rig, maya)).toContain("warmer closing");
  });
});

const inboxRow = (rig: StoreRig, student: string) => {
  const row = selectInboxRows(rig.state()).find(
    (candidate) => candidate.conversation.from === student,
  );
  if (!row) throw new Error(`No conversation from ${student}.`);
  return row;
};

const studentWritesAgain = (rig: StoreRig, ref: LmsRef<"conversation">): void => {
  const saved = rig.storage.getItem(LMS_STORAGE_KEY);
  if (!saved) throw new Error("The fake LMS has saved nothing.");
  const lms = JSON.parse(saved) as {
    conversations: { ref: string; unread: boolean; messages: { id: string; at: string }[] }[];
  };
  const conversation = lms.conversations.find((candidate) => candidate.ref === ref);
  const last = conversation?.messages.at(-1);
  if (!conversation || !last) throw new Error("No conversation to add to.");
  conversation.messages.push({ ...last, id: `${last.id}-again` });
  rig.storage.setItem(LMS_STORAGE_KEY, JSON.stringify(lms));
};

describe("a note the teacher already answered", () => {
  it("adds no unread, no needs-reply row, and no name to the replies work", async () => {
    const rig = await connected();
    const rows = selectInboxRows(rig.state());
    const note = inboxRow(rig, "Facilities");
    expect(note.conversation.unread).toBe(false);
    expect(note.last?.mine).toBe(true);
    expect(
      filterInbox(rows, "needs-reply", "all").map((row) => row.conversation.from),
    ).not.toContain("Facilities");
    expect(fromInboxRows(rows).map((row) => row.title)).not.toContain("Facilities");
  });
});

describe("reading a conversation locally", () => {
  it("stays read after a sync, even though the LMS still says unread", async () => {
    const rig = await connected();
    const { conversation } = inboxRow(rig, "Wren Calloway");
    rig.state().setConversationRead(conversation.ref, true);
    await rig.clock.run(rig.state().syncSchool(conversation.school));
    expect(inboxRow(rig, "Wren Calloway").conversation.unread).toBe(false);
  });

  it("goes back to unread after a sync that brings a newer student message", async () => {
    const rig = await connected();
    const { conversation } = inboxRow(rig, "Wren Calloway");
    rig.state().setConversationRead(conversation.ref, true);
    studentWritesAgain(rig, conversation.ref);
    await rig.clock.run(rig.state().syncSchool(conversation.school));
    expect(inboxRow(rig, "Wren Calloway").conversation.unread).toBe(true);
  });

  it("marking it unread again survives a sync too", async () => {
    const rig = await connected();
    const { conversation } = inboxRow(rig, "Wren Calloway");
    rig.state().setConversationRead(conversation.ref, true);
    rig.state().setConversationRead(conversation.ref, false);
    await rig.clock.run(rig.state().syncSchool(conversation.school));
    expect(inboxRow(rig, "Wren Calloway").conversation.unread).toBe(true);
  });
});

describe("the inbox thread", () => {
  it("drafts replies for students in different courses and schools", async () => {
    const rig = await connected();
    const wren = inboxRow(rig, "Wren Calloway");
    const harper = inboxRow(rig, "Harper Vance");
    expect(wren.school.id).not.toBe(harper.school.id);
    const first = await rig.clock.run(
      rig.state().openConversation(INBOX_THREAD, wren.conversation.ref),
    );
    const second = await rig.clock.run(
      rig.state().openConversation(INBOX_THREAD, harper.conversation.ref),
    );
    if (!first || !second) throw new Error("Expected two drafts.");
    expect(rig.state().changes[first]?.content.target).toBe(wren.conversation.ref);
    expect(rig.state().changes[second]?.content.target).toBe(harper.conversation.ref);
    expect(taggedLinesIn(rig, INBOX_THREAD, first)).toContain("Wren");
    expect(taggedLinesIn(rig, INBOX_THREAD, first)).not.toContain("Harper");
  });
});

describe("a grade sent for work on an assignment not yet due", () => {
  it("keeps its change on the queue row, so a batch can still count it", async () => {
    const rig = await connected();
    const row = selectQueueRows(rig.state()).find(
      (candidate) =>
        candidate.submission.studentName === "Emil Novak" &&
        candidate.assignment.shortTitle === "Speech 3 Outline",
    );
    if (!row) throw new Error("No row for Emil.");
    const id = await rig.clock.run(
      rig.state().openSubmission(QUEUE, row.submission.ref, { fill: "draft" }),
    );
    const record = id && rig.state().changes[id];
    if (!id || !record) throw new Error("No draft.");
    rig.state().dispatchUser(id, {
      type: "approve",
      witness: clickWitness(record),
      at: record.basis.readAt,
    });
    await rig.clock.run(rig.state().sendChanges([id]));
    const after = selectQueueRows(rig.state()).find(
      (candidate) => candidate.submission.ref === row.submission.ref,
    );
    expect(after?.change?.id).toBe(id);
    expect(after?.open).toBe(false);
  });

  it("nothing in the fake LMS was submitted after the moment it starts at", async () => {
    const rig = await connected();
    const start = rig.state().now();
    const submissions = selectQueueRows(rig.state()).map((row) => row.submission);
    expect(submissions.length).toBeGreaterThan(0);
    expect(
      submissions
        .filter(
          (submission) =>
            submission.submittedAt !== null && Date.parse(submission.submittedAt) > start,
        )
        .map((submission) => submission.ref),
    ).toEqual([]);
  });
});
