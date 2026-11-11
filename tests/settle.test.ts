import { describe, expect, it } from "vite-plus/test";

import {
  chatsNewestFirst,
  courseRows,
  settledNewestFirst,
  sidebarJumpOrder,
} from "~/renderer/components/sidebar.logic";
import type { LmsRef, SchoolId } from "~/shared/domain/ids";
import { GRADING_LIST_THREAD, NORTH_STAR_THREAD, isSettled } from "~/renderer/stores/selectors";

import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const LCC = "lcc" as SchoolId;

const withCourseThread = async () => {
  const rig = await makeStoreRig();
  await rig.connectAll();
  const course = rig.state().cache[LCC]?.courses[0];
  if (!course) throw new Error("No course.");
  const id = rig
    .state()
    .createThread({ kind: "general", school: LCC, course: course.ref, title: "Late work policy" });
  rig
    .state()
    .setPrefs({ courseOpen: { [course.ref]: true }, expandedThreads: { [course.ref]: true } });
  return { rig, course: course.ref, id };
};

const rowsOf = (rig: StoreRig, course: LmsRef<"course">) =>
  courseRows(Object.values(rig.state().threads), course, true).map((thread) => thread.id);
const jumps = (rig: StoreRig) => sidebarJumpOrder(rig.state(), true, null, "/");

describe("settling a thread", () => {
  it("drops it from its course's sidebar rows and the ⌘ jump order", async () => {
    const { rig, course, id } = await withCourseThread();
    expect(rowsOf(rig, course)).toContain(id);
    expect(jumps(rig)).toContain(id);

    rig.state().settleThreads([id]);

    expect(isSettled(rig.state().threads[id]!)).toBe(true);
    expect(rowsOf(rig, course)).not.toContain(id);
    expect(jumps(rig)).not.toContain(id);
  });

  it("resuming brings it back", async () => {
    const { rig, course, id } = await withCourseThread();
    rig.state().settleThreads([id]);
    rig.state().resumeThreads([id]);

    expect(isSettled(rig.state().threads[id]!)).toBe(false);
    expect(rowsOf(rig, course)).toContain(id);
    expect(jumps(rig)).toContain(id);
  });

  it("a new message after settling resumes it", async () => {
    const { rig, course, id } = await withCourseThread();
    rig.state().settleThreads([id]);
    rig.clock.advance(1000);
    expect(isSettled(rig.state().threads[id]!)).toBe(true);

    await rig.clock.run(rig.state().sendToAgent(id, "one more thing"));

    expect(isSettled(rig.state().threads[id]!)).toBe(false);
    expect(rowsOf(rig, course)).toContain(id);
  });

  it("stays settled across a reload", async () => {
    const { rig, course, id } = await withCourseThread();
    rig.state().settleThreads([id]);

    const reloaded = await makeStoreRig({
      storage: rig.storage,
      vault: rig.vault,
      clock: rig.clock,
    });
    await reloaded.state().boot();

    expect(isSettled(reloaded.state().threads[id]!)).toBe(true);
    expect(rowsOf(reloaded, course)).not.toContain(id);
  });

  it("the Settled area lists settled threads, newest settled first", async () => {
    const { rig, course, id } = await withCourseThread();
    const later = rig
      .state()
      .createThread({ kind: "general", school: LCC, course, title: "Rubric questions" });
    rig.state().settleThreads([id]);
    rig.clock.advance(1000);
    rig.state().settleThreads([later]);

    expect(
      settledNewestFirst(Object.values(rig.state().threads), true).map((thread) => thread.id),
    ).toEqual([later, id]);
  });

  it("a chat settles out of the Chats list and the jump order, and resumes like a course thread", async () => {
    const { rig } = await withCourseThread();
    const chat = rig
      .state()
      .createThread({ school: null, course: null, title: "Ideas", kind: "north-star-chat" });
    const chats = () => chatsNewestFirst(Object.values(rig.state().threads)).map((t) => t.id);
    expect(chats()).toContain(chat);
    expect(jumps(rig)).toContain(chat);

    rig.state().settleThreads([chat]);

    expect(chats()).not.toContain(chat);
    expect(jumps(rig)).not.toContain(chat);
    expect(
      settledNewestFirst(Object.values(rig.state().threads), true).map((thread) => thread.id),
    ).toEqual([chat]);

    rig.state().resumeThreads([chat]);
    expect(chats()).toContain(chat);
  });

  it("North Star and the grading list don't settle", async () => {
    const { rig } = await withCourseThread();

    rig.state().settleThreads([NORTH_STAR_THREAD, GRADING_LIST_THREAD]);

    for (const id of [NORTH_STAR_THREAD, GRADING_LIST_THREAD])
      expect(isSettled(rig.state().threads[id]!)).toBe(false);
    expect(jumps(rig)).toContain(NORTH_STAR_THREAD);
  });
});
