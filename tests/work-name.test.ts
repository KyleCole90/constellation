import { describe, expect, it } from "vite-plus/test";

import { ANNOUNCEMENT_DRAFTS } from "~/shared/agent/rules/drafts";
import type { ChangeContent } from "~/shared/domain/change";
import type { ThreadId } from "~/shared/domain/ids";
import { workLine } from "~/shared/domain/workName";
import { SEED } from "~/shared/providers/fake-canvas/seed";
import { selectInboxRows, selectThreadName } from "~/renderer/stores/selectors";

import { makeStoreRig } from "./fixtures/store-rig";

const connected = async () => {
  const rig = await makeStoreRig();
  await rig.connectAll();
  return rig;
};

const ANNOUNCEMENT = "t-h150-ann" as ThreadId;
const REPLIES = "t-h150-mail" as ThreadId;

describe("one name for one piece of work", () => {
  it("a seeded announcement thread is called what its draft will be called", () => {
    const seeded = SEED.courses.flatMap((course) =>
      course.threads
        .filter((thread) => thread.kind === "announcement")
        .map((thread) => [thread.title, ANNOUNCEMENT_DRAFTS[course.code]?.title]),
    );
    expect(seeded.length).toBeGreaterThan(0);
    for (const [title, drafted] of seeded) expect(title).toBe(drafted);
  });

  it("an announcement keeps its name through drafting and follows its title when renamed", async () => {
    const rig = await connected();
    const before = selectThreadName(rig.state(), ANNOUNCEMENT);
    const course = Object.values(rig.state().cache)
      .flatMap((cache) => cache.courses)
      .find((candidate) => candidate.code === "HUM 150");
    if (!course) throw new Error("No HUM 150.");
    await rig.clock.run(rig.state().openAnnouncement(ANNOUNCEMENT, course.ref));
    const record = Object.values(rig.state().changes).find(
      (change) => change.content.kind === "announcement",
    );
    if (!record) throw new Error("No draft.");
    expect(record.subject).toBe(before);
    expect(selectThreadName(rig.state(), ANNOUNCEMENT)).toBe(before);

    rig.state().dispatchUser(record.id, {
      type: "edit",
      by: "you",
      patch: { kind: "announcement", title: "Screening is in Hale tonight" },
      at: record.basis.readAt,
    });
    expect(rig.state().changes[record.id]?.subject).toBe("Screening is in Hale tonight");
    expect(selectThreadName(rig.state(), ANNOUNCEMENT)).toBe("Screening is in Hale tonight");
  });

  it("a thread of replies names the person on screen first, then counts the rest", async () => {
    const rig = await connected();
    const [first, second] = selectInboxRows(rig.state()).filter(
      (row) => row.course.code === "HUM 150" && row.conversation.unread,
    );
    if (!first || !second) throw new Error("HUM 150 needs two unread messages.");
    rig.state().setThreadUi(REPLIES, { current: second.conversation.ref });
    expect(selectThreadName(rig.state(), REPLIES)).toBe(
      `Reply to ${second.conversation.from} and 1 other`,
    );
    rig.state().setThreadUi(REPLIES, { current: first.conversation.ref });
    expect(selectThreadName(rig.state(), REPLIES)).toBe(
      `Reply to ${first.conversation.from} and 1 other`,
    );
  });
});

describe("the line under a draft's name", () => {
  const announcement = (title: string) =>
    ({ kind: "announcement", title, body: "" }) as ChangeContent;

  it("says the kind and the audience", () => {
    expect(workLine(announcement("Week 12"), "HUM 150")).toBe("Announcement to HUM 150");
    expect(workLine({ kind: "reply" } as ChangeContent, "HUM 150")).toBe("Message in HUM 150");
    expect(workLine({ kind: "grade" } as ChangeContent, "HUM 150")).toBeNull();
  });

  it("drops out when an untitled announcement's heading already says it", () => {
    expect(workLine(announcement("  "), "HUM 150")).toBeNull();
  });
});
