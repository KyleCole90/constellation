import { describe, expect, it } from "vite-plus/test";

import { parseAgentEffect, type Agent, type AgentScope } from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import { northStarStream } from "~/shared/agent/rules/northStar";
import { planWork, sittingsOf } from "~/renderer/components/screens/due.logic";
import { composerHints } from "~/renderer/components/thread/composer.logic";
import { buildTimeline, liveReplies } from "~/renderer/components/thread/timeline.logic";
import type { ChangeId, IsoTime, LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import type { Assignment } from "~/shared/domain/lms";
import {
  NORTH_STAR_THREAD,
  isChatThread,
  selectDueExtras,
  selectHandoffName,
  selectQueueRows,
  selectSource,
  selectThreadChanges,
  selectThreadStatus,
  selectWhatsDue,
  selectWorkStages,
  withoutChatThreads,
} from "~/renderer/stores/selectors";
import { seedThreads } from "~/renderer/stores/seedThreads";
import type { Thread, ThreadMessage } from "~/renderer/stores/types";
import { WORKSPACE_STORAGE_KEY } from "~/renderer/stores/workspace";

import { clickWitness } from "./fixtures/changes";
import { VirtualClock } from "./fixtures/clock";
import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";

const LCC = "lcc" as SchoolId;
const RSU = "rsu" as SchoolId;

const connected = async (options: Parameters<typeof makeStoreRig>[0] = {}) => {
  const rig = await makeStoreRig(options);
  await rig.connectAll();
  return rig;
};
const chats = (rig: StoreRig) =>
  Object.values(rig.state().threads).filter((thread) => thread.kind === "north-star-chat");
const chatOf = (rig: StoreRig): ThreadId => {
  const chat = chats(rig).at(-1);
  if (!chat) throw new Error("No chat.");
  return chat.id;
};
const startChat = async (rig: StoreRig, text: string) => {
  const started = rig.state().startChat(text);
  if (!started) throw new Error("No chat started.");
  await rig.clock.run(started.done);
  return started.thread;
};
const ask = async (
  rig: StoreRig,
  text: string,
  thread: ThreadId | undefined = chats(rig).at(-1)?.id,
) => {
  if (thread) await rig.clock.run(rig.state().sendToAgent(thread, text));
  else await startChat(rig, text);
};
const threadOf = (rig: StoreRig, id: ThreadId): Thread => {
  const thread = rig.state().threads[id];
  if (!thread) throw new Error(`No thread ${id}.`);
  return thread;
};
const messagesOf = <T extends ThreadMessage["type"]>(rig: StoreRig, id: ThreadId, type: T) =>
  threadOf(rig, id).messages.filter(
    (message): message is Extract<ThreadMessage, { type: T }> => message.type === type,
  );
const lastAgent = (rig: StoreRig) => messagesOf(rig, chatOf(rig), "agent").at(-1);
const allOf = <K extends "courses" | "assignments" | "conversations" | "announcements">(
  rig: StoreRig,
  key: K,
) =>
  Object.values(rig.state().cache).flatMap(
    (cache) => cache[key] as readonly (typeof cache)[K][number][],
  );
const courseByCode = (rig: StoreRig, code: string) => {
  const course = allOf(rig, "courses").find((candidate) => candidate.code === code);
  if (!course) throw new Error(`No course ${code}.`);
  return course;
};
const sidebarCodes = (rig: StoreRig) =>
  rig
    .state()
    .schools.flatMap((school) => rig.state().cache[school.id]?.courses ?? [])
    .map((course) => course.code);
const handoffCodes = (rig: StoreRig) =>
  messagesOf(rig, chatOf(rig), "handoff").map(
    (message) => allOf(rig, "courses").find((course) => course.ref === message.course)?.code,
  );

const scopeOf = (rig: StoreRig, over: Partial<AgentScope> = {}): AgentScope => ({
  focus: null,
  changes: [],
  submissions: [],
  assignments: allOf(rig, "assignments"),
  conversations: allOf(rig, "conversations"),
  courses: allOf(rig, "courses"),
  northStar: {
    announcements: allOf(rig, "announcements"),
    schools: rig.state().schools,
    now: "2026-10-30T15:42:00.000Z" as IsoTime,
    next: [],
  },
  ...over,
});

describe("a handoff from North Star", () => {
  it("starts one course thread, with the card in the chat and the banner in the course", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement for HUM 150");
    const [card, ...others] = messagesOf(rig, chatOf(rig), "handoff");
    if (!card) throw new Error("No handoff card.");
    expect(others).toEqual([]);
    const hum = courseByCode(rig, "HUM 150");
    expect(card.course).toBe(hum.ref);
    const destination = threadOf(rig, card.to);
    expect([destination.kind, destination.course]).toEqual(["announcement", hum.ref]);
    expect(messagesOf(rig, card.to, "handed-off")).toEqual([
      expect.objectContaining({
        from: chatOf(rig),
        request: "Draft this week's announcement for HUM 150",
      }),
    ]);
    const focus = destination.focus && rig.state().changes[destination.focus];
    expect(focus && [focus.course, focus.content.kind, focus.state.tag]).toEqual([
      hum.ref,
      "announcement",
      "draft",
    ]);
  });

  it("spans schools, with a thread and a draft for each course", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement for COMM 110 and HUM 150");
    expect(handoffCodes(rig)).toEqual(["COMM 110", "HUM 150"]);
    const destinations = messagesOf(rig, chatOf(rig), "handoff").map((card) =>
      threadOf(rig, card.to),
    );
    expect(destinations.map((thread) => thread.school)).toEqual([LCC, RSU]);
    for (const thread of destinations) {
      expect(messagesOf(rig, thread.id, "handed-off")).toHaveLength(1);
      expect(thread.focus && rig.state().changes[thread.focus]?.course).toBe(thread.course);
    }
    expect(rig.state().working[chatOf(rig)]).toBe(false);
  });

  it("finishes the drafts it started when the app reloads mid-handoff", async () => {
    const clock = new VirtualClock();
    const rules = createRuleAgent();
    const slow: Agent = {
      label: rules.label,
      async *run(input, signal) {
        await clock.sleep(1000);
        yield* rules.run(input, signal);
      },
    };
    const rig = await connected({ clock, agent: slow });
    const destinations = () => messagesOf(rig, chatOf(rig), "handoff").map((card) => card.to);
    const midway = () =>
      destinations().length === 2 && destinations().every((to) => rig.state().working[to]);
    void rig.state().startChat("Draft this week's announcement for COMM 110 and HUM 150");
    await rig.clock.run(
      new Promise<void>((resolve) => {
        const poll = () => (midway() ? resolve() : setTimeout(poll, 0));
        poll();
      }),
    );
    const handedTo = destinations();
    expect(handedTo.map((to) => threadOf(rig, to).focus)).toEqual([null, null]);

    const reloaded = await makeStoreRig({
      storage: rig.storage,
      vault: rig.vault,
      clock: new VirtualClock(rig.clock.now()),
    });
    await reloaded.clock.run(reloaded.state().boot());
    await reloaded.clock.flush();
    for (const to of handedTo) {
      const thread = threadOf(reloaded, to);
      const draft = thread.focus && reloaded.state().changes[thread.focus];
      expect(draft && [draft.course, draft.content.kind]).toEqual([thread.course, "announcement"]);
      expect(selectThreadStatus(reloaded.state(), to)?.label).not.toBe("Not started");
    }
  });

  it("resolves a course by school name, short code, and all", async () => {
    const lakeshore = await connected();
    await ask(lakeshore, "Draft an announcement for Lakeshore");
    expect(handoffCodes(lakeshore)).toEqual(["ENG 101", "ENG 102", "COMM 110"]);
    const rsu = await connected();
    await ask(rsu, "Draft an announcement for RSU");
    expect(handoffCodes(rsu)).toEqual(["ENG 210", "ENG 305", "HUM 150"]);
    const all = await connected();
    await ask(all, "Draft an announcement for every course");
    expect(handoffCodes(all)).toHaveLength(6);
  });

  it("asks which course when none is named, then acts on the answer in the same chat", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement");
    expect(messagesOf(rig, chatOf(rig), "handoff")).toEqual([]);
    expect(Object.keys(rig.state().changes)).toEqual([]);
    expect(lastAgent(rig)?.lines).toBeUndefined();
    expect(lastAgent(rig)?.text).toBe("Which course should get the announcement?");
    expect(lastAgent(rig)?.replies).toEqual([...sidebarCodes(rig), "All my courses"]);
    await ask(rig, "ENG 305");
    expect(handoffCodes(rig)).toEqual(["ENG 305"]);
  });

  it("takes a typed course code as the answer, however it's typed, and asks again about one it can't find", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement");
    await ask(rig, "XYZ 999");
    expect(lastAgent(rig)?.text).toBe(
      "I can't find XYZ 999 in your courses. Which course should get the announcement?",
    );
    await ask(rig, "hum150");
    expect(handoffCodes(rig)).toEqual(["HUM 150"]);
    expect(
      messagesOf(
        rig,
        messagesOf(rig, chatOf(rig), "handoff")[0]?.to ?? chatOf(rig),
        "handed-off",
      )[0]?.request,
    ).toBe("Draft this week's announcement");
  });

  it("takes All my courses as an answer to which course", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement");
    await ask(rig, "All my courses");
    expect(handoffCodes(rig)).toEqual(sidebarCodes(rig));
  });

  it("takes a typed assignment name as the answer to which assignment, the way the pill would", async () => {
    const typed = await connected();
    await ask(typed, "Start grading");
    await ask(typed, "close reading 2");
    const pill = await connected();
    await ask(pill, "Start grading");
    await ask(pill, "Start grading Close Reading 2");
    expect(handoffCodes(typed)).toEqual(handoffCodes(pill));
    expect(handoffCodes(typed)).toEqual(["ENG 210"]);
    expect(lastAgent(typed)?.text).toBe(lastAgent(pill)?.text);
    const [card] = messagesOf(typed, chatOf(typed), "handoff");
    expect(messagesOf(typed, card?.to ?? chatOf(typed), "handed-off")[0]?.request).toBe(
      "Start grading Close Reading 2",
    );
  });

  it("doesn't read a bare assignment name as an answer when nobody asked", async () => {
    const rig = await connected();
    await ask(rig, "Close Reading 2");
    expect(handoffCodes(rig)).toEqual([]);
    expect(lastAgent(rig)?.text).toContain("I didn't catch that");
  });

  it("offers the assignments with the most to grade, and each answer starts that one", async () => {
    const rig = await connected();
    await ask(rig, "Start grading");
    const question = lastAgent(rig);
    expect(question?.lines).toBeUndefined();
    const submissions = Object.values(rig.state().cache).flatMap((cache) => cache.submissions);
    const open = (a: Assignment) =>
      submissions.filter((s) => s.assignment === a.ref && s.workflow === "submitted").length;
    const busiest = [...allOf(rig, "assignments")].sort((a, b) => open(b) - open(a)).slice(0, 3);
    expect(question?.replies).toEqual(busiest.map((a) => `Start grading ${a.shortTitle}`));
    for (const [index, a] of busiest.entries()) {
      await ask(rig, question?.replies?.[index] ?? "");
      const card = messagesOf(rig, chatOf(rig), "handoff").at(-1);
      expect(card?.course).toBe(a.course);
      expect(card && threadOf(rig, card.to).title).toBe(`Grade ${a.shortTitle}`);
    }
  });

  it("offers a title two courses share only once", async () => {
    const rig = await connected();
    const essay = allOf(rig, "assignments").find((a) => a.shortTitle === "Essay 2") as Assignment;
    const twin: Assignment = {
      ...essay,
      ref: `${essay.ref}-twin` as LmsRef<"assignment">,
      course: courseByCode(rig, "ENG 102").ref,
    };
    const effects: unknown[] = [];
    for await (const effect of createRuleAgent().run(
      {
        request: "Start grading",
        thread: { history: [] },
        scope: scopeOf(rig, { assignments: [essay, twin] }),
      },
      new AbortController().signal,
    ))
      effects.push(effect);
    expect(effects).toEqual([expect.objectContaining({ replies: ["Start grading Essay 2"] })]);
  });

  it("offers an answer only until a later message exists", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement");
    const live = () => {
      const { messages } = threadOf(rig, chatOf(rig));
      return messages.flatMap((message) => liveReplies(message, messages));
    };
    expect(live()).toContain("HUM 150");
    await ask(rig, "What needs grading?");
    expect(messagesOf(rig, chatOf(rig), "agent")[0]?.replies).toContain("HUM 150");
    expect(live()).toEqual([]);
  });

  it("says so when a named course isn't theirs, and still starts the one that is", async () => {
    const rig = await connected();
    await ask(rig, "Draft an announcement for HUM 150 and ENG 999");
    expect(handoffCodes(rig)).toEqual(["HUM 150"]);
    expect(lastAgent(rig)?.text).toContain("ENG 999");
  });

  it("drafts every unread reply per course, focuses the first, and leaves the list open", async () => {
    const rig = await connected();
    await ask(rig, "Draft replies to my unread messages");
    const cards = messagesOf(rig, chatOf(rig), "handoff");
    const withUnread = new Set(
      allOf(rig, "conversations")
        .filter((c) => c.unread)
        .map((c) => c.course),
    );
    expect(new Set(cards.map((card) => card.course))).toEqual(withUnread);
    for (const card of cards) {
      const thread = threadOf(rig, card.to);
      expect(thread.kind).toBe("messages");
      const unread = allOf(rig, "conversations").filter(
        (c) => c.course === card.course && c.unread,
      );
      const drafts = Object.values(rig.state().changes).filter(
        (change) => change.course === card.course && change.content.kind === "reply",
      );
      expect(drafts.map((change) => change.content.target).sort()).toEqual(
        unread.map((c) => c.ref).sort(),
      );
      expect(thread.focus && rig.state().changes[thread.focus]?.content.target).toBe(
        unread[0]?.ref,
      );
      expect(rig.state().prefs.threadUi[card.to]?.queueOpen).toBe(true);
    }
  });

  it("keeps a replies card named for who it handed off after one of them is sent", async () => {
    const rig = await connected();
    await ask(rig, "Draft replies in ENG 101");
    const [card] = messagesOf(rig, chatOf(rig), "handoff");
    if (!card) throw new Error("No handoff card.");
    const before = selectHandoffName(rig.state(), card);
    expect(before).toMatch(/^Reply to .+ and \d+ others?$/);
    const first = threadOf(rig, card.to).focus;
    const record = first && rig.state().changes[first];
    if (!first || !record) throw new Error("No focused draft.");
    rig.state().dispatchUser(first, {
      type: "approve",
      witness: clickWitness(record),
      at: record.basis.readAt,
    });
    await rig.clock.run(rig.state().sendChanges([first]));
    expect(rig.state().changes[first]?.state.tag).toBe("sent");
    expect(selectHandoffName(rig.state(), card)).toBe(before);
  });

  it("drafts one reply to the person named, in their course's thread", async () => {
    const rig = await connected();
    await ask(rig, "Reply to Imani Okafor");
    const imani = allOf(rig, "conversations").find((c) => c.from === "Imani Okafor");
    if (!imani) throw new Error("No conversation from Imani.");
    expect(handoffCodes(rig)).toEqual(["ENG 101"]);
    const drafts = Object.values(rig.state().changes);
    expect(drafts.map((change) => change.content.target)).toEqual([imani.ref]);
    expect(lastAgent(rig)?.text).toBe(
      "Started a draft reply to **Imani Okafor** in your **ENG 101** thread. Students see nothing until you approve it.",
    );
  });

  it("asks who, and starts nothing, when no message is from the person named", async () => {
    const rig = await connected();
    await ask(rig, "Reply to Imani Okafro");
    expect(messagesOf(rig, chatOf(rig), "handoff")).toEqual([]);
    expect(Object.keys(rig.state().changes)).toEqual([]);
    expect(lastAgent(rig)?.text).toBe(
      "I can't find a message from Imani Okafro. Who should I reply to?",
    );
    const offered = lastAgent(rig)?.replies ?? [];
    expect(offered.length).toBeGreaterThan(0);
    await ask(rig, offered[0] ?? "");
    expect(messagesOf(rig, chatOf(rig), "handoff")).toHaveLength(1);
  });

  it("opens the grading list and drafts nothing when asked to start grading", async () => {
    const rig = await connected();
    await ask(rig, "Start grading Essay 2");
    const [card, ...others] = messagesOf(rig, chatOf(rig), "handoff");
    if (!card) throw new Error("No handoff card.");
    expect(others).toEqual([]);
    const thread = threadOf(rig, card.to);
    expect([thread.kind, thread.title]).toEqual(["grading", "Grade Essay 2"]);
    expect(rig.state().prefs.threadUi[card.to]?.queueOpen).toBe(true);
    expect(Object.keys(rig.state().changes)).toEqual([]);
  });

  it("offers the grading list to open, without claiming it already opened", async () => {
    const rig = await connected();
    await ask(rig, "Grade Essay 2 in ENG 101");
    expect(handoffCodes(rig)).toEqual(["ENG 101"]);
    expect(lastAgent(rig)?.text).not.toContain("Opened");
    expect(lastAgent(rig)?.text).toContain("choose Open");
  });

  it("hands one grading list to each course with that title", async () => {
    const rig = await connected();
    const essay = allOf(rig, "assignments").find((a) => a.shortTitle === "Essay 2") as Assignment;
    const other = courseByCode(rig, "ENG 102");
    const twin: Assignment = {
      ...essay,
      ref: `${essay.ref}-twin` as LmsRef<"assignment">,
      course: other.ref,
    };
    const effects: unknown[] = [];
    for await (const effect of createRuleAgent().run(
      {
        request: "Start grading Essay 2",
        thread: { history: [] },
        scope: scopeOf(rig, { assignments: [...allOf(rig, "assignments"), twin] }),
      },
      new AbortController().signal,
    ))
      effects.push(effect);
    expect(
      effects
        .filter((effect) => (effect as { type: string }).type === "handoff")
        .map((effect) => (effect as { work: unknown }).work),
    ).toEqual([
      { kind: "grading", assignment: essay.ref },
      { kind: "grading", assignment: twin.ref },
    ]);
  });

  it("takes the longest title it hears, and hands off nothing for a title it doesn't know", async () => {
    const rig = await connected();
    await ask(rig, "Start grading Essay 3 Outline");
    expect(handoffCodes(rig)).toEqual(["ENG 101"]);
    await ask(rig, "Start grading Nothing Called This");
    expect(handoffCodes(rig)).toEqual(["ENG 101"]);
    expect(lastAgent(rig)?.replies?.length).toBeGreaterThan(0);
  });

  it("creates a destination the seed doesn't have under the usual title", async () => {
    const rig = await connected();
    await ask(rig, "Start grading Screening Notes");
    const [card] = messagesOf(rig, chatOf(rig), "handoff");
    expect(card && threadOf(rig, card.to).title).toBe("Grade Screening Notes");
  });

  it("reuses the thread and the draft when asked twice", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement for HUM 150");
    const threadsBefore = Object.keys(rig.state().threads).length;
    const changesBefore = Object.keys(rig.state().changes);
    await ask(rig, "Draft this week's announcement for HUM 150");
    const [first, second] = messagesOf(rig, chatOf(rig), "handoff");
    expect(second?.to).toBe(first?.to);
    expect(Object.keys(rig.state().threads)).toHaveLength(threadsBefore);
    expect(Object.keys(rig.state().changes)).toEqual(changesBefore);
    const thread = first && threadOf(rig, first.to);
    expect(thread?.focus).toBe(changesBefore[0]);
  });

  describe("in the course thread", () => {
    const shape = (rig: StoreRig, id: ThreadId) => {
      const thread = threadOf(rig, id);
      return buildTimeline(thread.messages, selectThreadChanges(rig.state(), id), {
        focus: thread.focus,
        expanded: false,
      }).map((item) => (item.type === "message" ? item.message.type : item.type));
    };
    const destinationOf = (rig: StoreRig): ThreadId => {
      const card = messagesOf(rig, chatOf(rig), "handoff").at(-1);
      if (!card) throw new Error("No handoff card.");
      return card.to;
    };

    it("reads the ask, then the work, then the draft, with nothing the person didn't ask for above them", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement for HUM 150");
      expect(shape(rig, destinationOf(rig))).toEqual(["handed-off", "work", "change", "agent"]);
    });

    it("keeps what the person typed in the thread when a handoff replaces its lead-in", async () => {
      const rig = await connected();
      const thread = Object.values(rig.state().threads).find(
        (candidate) => candidate.title === "Monday screening moves to Hale Auditorium",
      );
      if (!thread) throw new Error("No announcement thread.");
      await ask(rig, "What can you do here?", thread.id);
      rig.clock.advance(1000);
      await ask(rig, "Draft this week's announcement for HUM 150");
      expect(destinationOf(rig)).toBe(thread.id);
      expect(shape(rig, thread.id)).toEqual([
        "user",
        "agent",
        "handed-off",
        "work",
        "change",
        "agent",
      ]);
      expect(messagesOf(rig, thread.id, "user").map((message) => message.text)).toEqual([
        "What can you do here?",
      ]);
    });

    it("holds no line promising a draft before one exists", async () => {
      const rig = await connected();
      const thread = Object.values(rig.state().threads).find(
        (candidate) => candidate.title === "Monday screening moves to Hale Auditorium",
      );
      if (!thread) throw new Error("No announcement thread.");
      const leadIn = messagesOf(rig, thread.id, "agent")[0]?.text;
      expect(leadIn).toContain("Your last post was");
      expect(leadIn).not.toMatch(/open the draft/i);
      await ask(rig, "Draft this week's announcement for HUM 150");
      expect(
        messagesOf(rig, thread.id, "agent")
          .map((message) => message.text)
          .join(" "),
      ).not.toMatch(/open the draft/i);
    });

    it("adds nothing when the draft already exists, and the chat says so", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement for HUM 150");
      const before = threadOf(rig, destinationOf(rig)).messages;
      await ask(rig, "Draft this week's announcement for HUM 150");
      expect(threadOf(rig, destinationOf(rig)).messages).toEqual(before);
      expect(lastAgent(rig)?.text).toContain(
        "**HUM 150** already has a draft, so I didn't start another.",
      );
      expect(lastAgent(rig)?.text).not.toContain("Started");
      expect(messagesOf(rig, chatOf(rig), "handoff").at(-1)?.brief).toBe(
        "Already drafted. Open it to review.",
      );
    });

    it("starts only the courses without a draft when some already have one", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement for HUM 150");
      await ask(rig, "Draft this week's announcement for COMM 110 and HUM 150");
      expect(lastAgent(rig)?.text).toContain(
        "Started a draft announcement in your **COMM 110** thread.",
      );
      expect(lastAgent(rig)?.text).toContain("**HUM 150** already has a draft");
      const [comm, hum] = messagesOf(rig, chatOf(rig), "handoff").slice(-2);
      expect(comm && messagesOf(rig, comm.to, "handed-off")).toHaveLength(1);
      expect(hum && messagesOf(rig, hum.to, "handed-off")).toHaveLength(1);
    });

    it("starts a new draft once the last one has been discarded", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement for HUM 150");
      const [first] = Object.keys(rig.state().changes) as ChangeId[];
      if (!first) throw new Error("No draft.");
      rig.state().dispatchUser(first, {
        type: "discard",
        at: new Date(rig.clock.now()).toISOString() as IsoTime,
      });
      await ask(rig, "Draft this week's announcement for HUM 150");
      expect(lastAgent(rig)?.text).toContain(
        "Started a draft announcement in your **HUM 150** thread.",
      );
      expect(messagesOf(rig, destinationOf(rig), "handed-off")).toHaveLength(2);
    });

    it("adds nothing when every unread message already has a reply drafted", async () => {
      const rig = await connected();
      await ask(rig, "Draft replies to my unread messages in HUM 150");
      const before = threadOf(rig, destinationOf(rig)).messages;
      await ask(rig, "Draft replies to my unread messages in HUM 150");
      expect(threadOf(rig, destinationOf(rig)).messages).toEqual(before);
      expect(lastAgent(rig)?.text).toContain("**HUM 150** already has its replies drafted");
    });

    it("opens the grading list once, however many times it's asked for", async () => {
      const rig = await connected();
      await ask(rig, "Start grading Essay 2");
      await ask(rig, "Start grading Essay 2");
      expect(messagesOf(rig, destinationOf(rig), "handed-off")).toHaveLength(1);
    });

    it("shows the original ask when the course came from answering a question", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement");
      await ask(rig, "HUM 150");
      expect(
        messagesOf(rig, destinationOf(rig), "handed-off").map((banner) => banner.request),
      ).toEqual(["Draft this week's announcement"]);
    });

    it("shows the original ask when it named a course that isn't theirs", async () => {
      const rig = await connected();
      await ask(rig, "Draft an announcement for ENG 999");
      await ask(rig, "HUM 150");
      expect(
        messagesOf(rig, destinationOf(rig), "handed-off").map((banner) => [
          banner.request,
          banner.left,
        ]),
      ).toEqual([["Draft an announcement for ENG 999", undefined]]);
    });

    it("shows a full request typed as the answer as itself", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement");
      await ask(rig, "Write an announcement for HUM 150");
      expect(
        messagesOf(rig, destinationOf(rig), "handed-off").map((banner) => banner.request),
      ).toEqual(["Write an announcement for HUM 150"]);
    });
  });

  describe("with a topic", () => {
    const announcementFor = (rig: StoreRig, code: string) => {
      const course = courseByCode(rig, code);
      const content = Object.values(rig.state().changes).find(
        (change) => change.content.kind === "announcement" && change.content.target === course.ref,
      )?.content;
      return content?.kind === "announcement" ? content : undefined;
    };

    it("drafts the announcement about it, and leaves nothing out", async () => {
      const rig = await connected();
      await ask(rig, "Draft an announcement for ENG 102 about the midterm review");
      expect(announcementFor(rig, "ENG 102")).toMatchObject({
        title: "Midterm review",
        body: expect.stringContaining("the midterm review"),
      });
      expect(lastAgent(rig)?.text).not.toContain("I left out");
    });

    it("keeps the topic from the first message when the course comes in an answer", async () => {
      const rig = await connected();
      await ask(rig, "Draft an announcement about the guest speaker");
      await ask(rig, "HUM 150");
      expect(announcementFor(rig, "HUM 150")?.title).toBe("Guest speaker");
      expect(lastAgent(rig)?.text).not.toContain("I left out");
    });

    it("still names what isn't the topic", async () => {
      const rig = await connected();
      await ask(
        rig,
        "Draft an announcement for HUM 150 about the guest speaker, and make it short",
      );
      expect(announcementFor(rig, "HUM 150")?.title).toBe("Guest speaker");
      expect(lastAgent(rig)?.text).toContain('I left out "short"');
    });

    it("keeps a topic that also says when", async () => {
      const rig = await connected();
      await ask(rig, "Draft an announcement for HUM 150 about the midterm review on Friday at 3pm");
      expect(announcementFor(rig, "HUM 150")?.title).toBe("Midterm review on Friday at 3pm");
    });
  });

  describe("with a detail the rule agent can't use", () => {
    const leftIn = (rig: StoreRig) => {
      const card = messagesOf(rig, chatOf(rig), "handoff").at(-1);
      return card && messagesOf(rig, card.to, "handed-off").at(-1)?.left;
    };

    it("names it in the chat and above the draft", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement for HUM 150, and remember Thursday at 7pm");
      expect(lastAgent(rig)?.text).toContain('I left out "remember Thursday at 7pm"');
      expect(leftIn(rig)).toBe('"remember Thursday at 7pm"');
    });

    it("keeps the teacher's words in order across clauses, and cuts a long one short", async () => {
      const rig = await connected();
      await ask(
        rig,
        "Draft this week's announcement for COMM 110 and HUM 150, and make it short, and remember the screening moved to Thursday at 7pm so everyone has time to plan around it and bring a printed copy of the reading",
      );
      expect(
        leftIn(rig)?.startsWith('"short, remember the screening moved to Thursday at 7pm'),
      ).toBe(true);
      expect(leftIn(rig)?.endsWith('…"')).toBe(true);
      expect(leftIn(rig)?.length).toBeLessThanOrEqual(102);
    });

    it("still names a detail from the first message when the course comes in an answer", async () => {
      const rig = await connected();
      await ask(rig, "Draft an announcement, and remember the guest speaker");
      await ask(rig, "HUM 150");
      expect(lastAgent(rig)?.text).toContain('I left out "remember the guest speaker"');
    });

    it("names one left out of replies too", async () => {
      const rig = await connected();
      await ask(rig, "Draft replies to my unread messages in HUM 150 saying class is cancelled");
      expect(lastAgent(rig)?.text).toContain('I left out "saying class is cancelled"');
    });

    it("names a time as left out, because a time isn't a topic", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement for HUM 150 about Thursday at 7pm");
      expect(lastAgent(rig)?.text).toContain('I left out "Thursday at 7pm"');
      expect(leftIn(rig)).toBe('"Thursday at 7pm"');
    });

    it("says the same when the draft already exists", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement for HUM 150");
      await ask(rig, "Draft this week's announcement for HUM 150 about Thursday at 7pm");
      expect(lastAgent(rig)?.text).toContain('I left out "Thursday at 7pm"');
    });

    it("names a topic it couldn't use because the draft already exists", async () => {
      const rig = await connected();
      await ask(rig, "Draft this week's announcement for HUM 150");
      await ask(rig, "Draft an announcement for HUM 150 about the midterm review");
      expect(lastAgent(rig)?.text).toContain('I left out "midterm review"');
    });

    it.each([
      "Draft this week's announcement for HUM 150",
      "please write a new announcement for all my courses",
      "Draft an announcement for Riverbend State University",
      "Make an announcement for RSU.",
      "Draft next week's announcement for HUM 150 and ENG 999",
    ])("stays quiet about %s", async (request) => {
      const rig = await connected();
      await ask(rig, request);
      expect(lastAgent(rig)?.text).not.toContain("I left out");
      expect(leftIn(rig)).toBeUndefined();
    });
  });

  it("says a draft started in the teacher's own thread and students see nothing, for one course, several, and replies", async () => {
    const one = await connected();
    await ask(one, "Draft this week's announcement for HUM 150");
    expect(lastAgent(one)?.text).toBe(
      "Started a draft announcement in your **HUM 150** thread. Students see nothing until you approve it.",
    );
    const two = await connected();
    await ask(two, "Draft this week's announcement for COMM 110 and HUM 150");
    expect(lastAgent(two)?.text).toBe(
      "Started draft announcements in your **COMM 110** and **HUM 150** threads. Students see nothing until you approve them.",
    );
    const replies = await connected();
    await ask(replies, "Draft replies to my unread messages in HUM 150");
    expect(lastAgent(replies)?.text).toBe(
      "Started draft replies in your **HUM 150** thread. Students see nothing until you approve them.",
    );
  });

  it("writes nothing to the LMS, and leaves every change a draft", async () => {
    const rig = await connected();
    const before = rig.storage.getItem("lms-app.fake-canvas.v1");
    const postsBefore = allOf(rig, "announcements").length;
    await ask(rig, "Draft this week's announcement for COMM 110 and HUM 150");
    await ask(rig, "Draft replies to my unread messages");
    await ask(rig, "Start grading Essay 2");
    const changes = Object.values(rig.state().changes);
    expect(changes.length).toBeGreaterThan(2);
    expect(new Set(changes.map((change) => change.state.tag))).toEqual(new Set(["draft"]));
    expect(rig.storage.getItem("lms-app.fake-canvas.v1")).toBe(before);
    expect(allOf(rig, "announcements")).toHaveLength(postsBefore);
  });

  it("never pulls other threads' change cards into a chat", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement for COMM 110 and HUM 150");
    expect(Object.keys(rig.state().changes).length).toBeGreaterThan(0);
    expect(selectThreadChanges(rig.state(), chatOf(rig))).toEqual([]);
    expect(selectThreadStatus(rig.state(), chatOf(rig))).toBeNull();
  });
});

describe("the handoff parser", () => {
  const handoff = (rig: StoreRig, over: Record<string, unknown> = {}) => {
    const course = courseByCode(rig, "HUM 150");
    return {
      type: "handoff",
      school: course.school,
      course: course.ref,
      work: { kind: "announcement" },
      brief: "Draft it.",
      request: "Draft the announcement.",
      ...over,
    };
  };

  it("refuses a handoff from a course thread", async () => {
    const rig = await connected();
    const { northStar: _dropped, ...courseScope } = scopeOf(rig);
    expect(parseAgentEffect(handoff(rig), courseScope)).toEqual({
      ok: false,
      error: { kind: "out-of-scope", target: "handoff" },
    });
  });

  it("a course thread's agent can't reach the sink with one", async () => {
    const agent: Agent = {
      label: "test double",
      async *run(input) {
        const course = input.scope.courses[0];
        yield {
          type: "handoff",
          school: course?.school,
          course: course?.ref,
          work: { kind: "announcement" },
          brief: "Hand this off.",
        };
      },
    };
    const rig = await connected({ agent });
    const thread = "t-e101-ann" as ThreadId;
    const count = Object.keys(rig.state().threads).length;
    await ask(rig, "hand this off", thread);
    expect(messagesOf(rig, thread, "refusal")).toHaveLength(1);
    expect(messagesOf(rig, thread, "handed-off")).toEqual([]);
    expect(Object.keys(rig.state().threads)).toHaveLength(count);
  });

  it("refuses a course outside scope, and a course from the wrong school", async () => {
    const rig = await connected();
    expect(parseAgentEffect(handoff(rig, { course: "rsu:course:999" }), scopeOf(rig)).ok).toBe(
      false,
    );
    expect(parseAgentEffect(handoff(rig, { school: LCC }), scopeOf(rig)).ok).toBe(false);
    expect(parseAgentEffect(handoff(rig), scopeOf(rig))).toEqual({
      ok: true,
      value: expect.objectContaining({ type: "handoff", brief: "Draft it." }),
    });
  });

  it("refuses a grading assignment outside scope or in another course", async () => {
    const rig = await connected();
    const elsewhere = allOf(rig, "assignments").find(
      (a) => a.course !== courseByCode(rig, "HUM 150").ref,
    );
    const own = allOf(rig, "assignments").find(
      (a) => a.course === courseByCode(rig, "HUM 150").ref,
    );
    expect(
      parseAgentEffect(
        handoff(rig, { work: { kind: "grading", assignment: "rsu:assignment:999" } }),
        scopeOf(rig),
      ),
    ).toEqual({ ok: false, error: { kind: "out-of-scope", target: "rsu:assignment:999" } });
    expect(
      parseAgentEffect(
        handoff(rig, { work: { kind: "grading", assignment: elsewhere?.ref } }),
        scopeOf(rig),
      ).ok,
    ).toBe(false);
    expect(
      parseAgentEffect(
        handoff(rig, { work: { kind: "grading", assignment: own?.ref } }),
        scopeOf(rig),
      ).ok,
    ).toBe(true);
  });

  it("refuses work it doesn't know and a blank brief", async () => {
    const rig = await connected();
    expect(parseAgentEffect(handoff(rig, { work: { kind: "approve" } }), scopeOf(rig))).toEqual({
      ok: false,
      error: { kind: "malformed", detail: "handoff work approve" },
    });
    expect(parseAgentEffect(handoff(rig, { brief: "  " }), scopeOf(rig)).ok).toBe(false);
    expect(parseAgentEffect(handoff(rig, { request: undefined }), scopeOf(rig))).toEqual({
      ok: false,
      error: { kind: "malformed", detail: "request" },
    });
    expect(
      parseAgentEffect(handoff(rig, { work: { kind: "announcement", topic: 7 } }), scopeOf(rig)),
    ).toEqual({ ok: false, error: { kind: "malformed", detail: "announcement topic" } });
    expect(
      parseAgentEffect(
        handoff(rig, { work: { kind: "announcement", topic: "the field trip" } }),
        scopeOf(rig),
      ),
    ).toEqual({
      ok: true,
      value: expect.objectContaining({ work: { kind: "announcement", topic: "the field trip" } }),
    });
    expect(parseAgentEffect(handoff(rig, { left: 7 }), scopeOf(rig))).toEqual({
      ok: false,
      error: { kind: "malformed", detail: "left" },
    });
    expect(parseAgentEffect(handoff(rig, { left: "the date" }), scopeOf(rig))).toEqual({
      ok: true,
      value: expect.objectContaining({ request: "Draft the announcement.", left: "the date" }),
    });
  });

  it("refuses replies that aren't an array of real texts, and keeps ones that are", async () => {
    const rig = await connected();
    for (const replies of ["HUM 150", [""], ["  "], ["HUM 150", 150], [null], {}, null]) {
      expect(parseAgentEffect({ type: "say", text: "Which?", replies }, scopeOf(rig))).toEqual({
        ok: false,
        error: { kind: "malformed", detail: "say replies" },
      });
    }
    expect(
      parseAgentEffect(
        { type: "say", text: "Which?", replies: ["HUM 150", "All my courses"] },
        scopeOf(rig),
      ),
    ).toEqual({
      ok: true,
      value: { type: "say", text: "Which?", replies: ["HUM 150", "All my courses"] },
    });
  });

  it("refuses a line whose source doesn't exist, and keeps one that does", async () => {
    const rig = await connected();
    const assignment = allOf(rig, "assignments")[0];
    for (const source of [
      { kind: "assignment", ref: "lcc:assignment:0" },
      { kind: "course", ref: "lcc:course:0" },
      { kind: "announcement", ref: "lcc:announcement:0" },
      { kind: "conversation", ref: "lcc:conversation:0" },
      { kind: "grade" },
      "due",
    ]) {
      expect(
        parseAgentEffect(
          { type: "say", text: "See this.", lines: [{ source, title: "It" }] },
          scopeOf(rig),
        ).ok,
      ).toBe(false);
    }
    expect(
      parseAgentEffect(
        {
          type: "say",
          text: "See this.",
          lines: [
            {
              source: { kind: "assignment", ref: assignment?.ref, extra: 1 },
              title: "It",
              detail: "Due soon",
              extra: 1,
            },
            { source: { kind: "due" }, title: "All" },
          ],
        },
        scopeOf(rig),
      ),
    ).toEqual({
      ok: true,
      value: {
        type: "say",
        text: "See this.",
        lines: [
          { source: { kind: "assignment", ref: assignment?.ref }, title: "It", detail: "Due soon" },
          { source: { kind: "due" }, title: "All" },
        ],
      },
    });
  });

  it("refuses a line with no title, or that isn't a line", async () => {
    const rig = await connected();
    for (const lines of [
      "due",
      [{ kind: "due" }],
      [{ source: { kind: "due" } }],
      [{ source: { kind: "due" }, title: " " }],
      [{ source: { kind: "due" }, title: "All", detail: 3 }],
    ]) {
      expect(parseAgentEffect({ type: "say", text: "See this.", lines }, scopeOf(rig))).toEqual({
        ok: false,
        error: { kind: "malformed", detail: "say lines" },
      });
    }
  });

  it("refuses an announcement source outside North Star", async () => {
    const rig = await connected();
    const post = allOf(rig, "announcements")[0];
    const { northStar: _dropped, ...courseScope } = scopeOf(rig);
    expect(
      parseAgentEffect(
        {
          type: "say",
          text: "See this.",
          lines: [{ source: { kind: "announcement", ref: post?.ref }, title: "It" }],
        },
        courseScope,
      ).ok,
    ).toBe(false);
  });
});

describe("a follow-up to the chat's last handoff", () => {
  const imaniAsked =
    "Hi Professor, I missed Essay 2 because I picked up extra shifts when my brother was in the hospital. Is it still possible to turn it in this weekend? I can send a note from his doctor if you need one.";

  it("answers what she asked about, and links her draft instead of offering it again", async () => {
    const rig = await connected();
    await ask(rig, "Reply to Imani Okafor");
    await ask(rig, "What did she ask about?");
    const answer = lastAgent(rig);
    expect(answer?.text).toBe("**Imani Okafor** wrote to you: **Essay 2 is going to be late**.");
    expect(answer?.lines?.[0]).toMatchObject({
      source: { kind: "conversation" },
      title: "Essay 2 is going to be late",
      detail: imaniAsked,
    });
    expect(answer?.lines?.[1]).toMatchObject({ source: { kind: "change" } });
    expect(answer?.replies ?? []).not.toContain("Reply to Imani Okafor");
    expect(messagesOf(rig, chatOf(rig), "handoff")).toHaveLength(1);
  });

  it("points a change at the draft it started, and changes nothing from the chat", async () => {
    const rig = await connected();
    await ask(rig, "Reply to Imani Okafor");
    const before = structuredClone(rig.state().changes);
    const [draft] = Object.keys(before) as ChangeId[];
    await ask(rig, "make it friendlier");
    const answer = lastAgent(rig);
    expect(answer?.text).toBe(
      "I can't change a draft from this chat. Open it in your **ENG 101** thread and say what to change there.",
    );
    expect(answer?.lines?.map((line) => line.source)).toEqual([{ kind: "change", ref: draft }]);
    expect(answer?.replies ?? []).not.toContain("Reply to Imani Okafor");
    expect(rig.state().changes).toEqual(before);
  });

  it("offers the last handoff as the first pill when it can't place a request", async () => {
    const rig = await connected();
    await ask(rig, "Start grading Memo Revision");
    await ask(rig, "banana");
    expect(lastAgent(rig)?.text).toContain("I didn't catch that");
    expect(lastAgent(rig)?.replies?.[0]).toMatch(/^Start grading Memo Revision in /);
    expect(lastAgent(rig)?.replies).toHaveLength(3);
  });

  it("doesn't offer work again once it has its draft", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement for HUM 150");
    await ask(rig, "banana");
    expect(lastAgent(rig)?.text).toContain("I didn't catch that");
    expect(lastAgent(rig)?.replies).not.toContain("Open the draft announcement for HUM 150");
  });

  it("does the same for the student they name next", async () => {
    const rig = await connected();
    await ask(rig, "Reply to Imani Okafor");
    await ask(rig, "make it friendlier");
    await ask(rig, "now do the same for Owen");
    expect(lastAgent(rig)?.text).not.toContain("I didn't catch that");
    expect(lastAgent(rig)?.text).toContain("**Owen Tierney**");
    const drafted = Object.values(rig.state().changes).map((change) => change.subject);
    expect(drafted.some((subject) => subject.includes("Owen Tierney"))).toBe(true);
    expect(messagesOf(rig, chatOf(rig), "handoff")).toHaveLength(2);
  });

  it("asks who when the same is for someone who hasn't written", async () => {
    const rig = await connected();
    await ask(rig, "Reply to Imani Okafor");
    await ask(rig, "do the same for Zelda");
    expect(lastAgent(rig)?.text).toBe("I can't find a message from Zelda. Who should I reply to?");
  });

  it("follows the latest handoff, not an earlier one", async () => {
    const rig = await connected();
    await ask(rig, "Reply to Imani Okafor");
    await ask(rig, "Draft this week's announcement for HUM 150");
    await ask(rig, "What is it about?");
    expect(lastAgent(rig)?.text).toBe(
      "The last work I started here is in your **HUM 150** thread.",
    );
    const [announcement] = Object.values(rig.state().changes).filter(
      (change) => change.content.kind === "announcement",
    );
    expect(lastAgent(rig)?.lines?.map((line) => line.source)).toEqual([
      { kind: "change", ref: announcement?.id },
    ]);
    expect(lastAgent(rig)?.replies ?? []).not.toContain("Open the draft announcement for HUM 150");
  });

  it("doesn't make one up when the chat hasn't handed anything off", async () => {
    const rig = await connected();
    await ask(rig, "make it friendlier");
    expect(lastAgent(rig)?.text).toContain("I didn't catch that");
    expect(lastAgent(rig)?.replies?.[0]).not.toContain("Reply to Imani");
  });
});

describe("what North Star answers", () => {
  it("names the next assignments due, and agrees with What's due", async () => {
    const rig = await connected();
    await ask(rig, "What's due this week?");
    const answer = lastAgent(rig);
    const groups = selectWhatsDue(rig.state(), rig.state().now());
    const items = groups
      .flatMap((group) => group.items)
      .filter((item) => item.days !== null && item.days >= 0 && item.days <= 7);
    expect(answer?.text).toBe(`${items.length} assignments are due in the next 7 days.`);
    expect(
      answer?.lines
        ?.slice(0, -1)
        .map(({ source }) => (source.kind === "assignment" ? source.ref : null)),
    ).toEqual(items.map((item) => item.assignment.ref));
    expect(answer?.lines?.slice(0, -1).map((line) => line.title)).toEqual(
      items.map((item) => item.assignment.shortTitle),
    );
    expect(answer?.lines?.at(-1)).toEqual({ source: { kind: "due" }, title: "All of what's due" });
    expect(messagesOf(rig, chatOf(rig), "work").length).toBeGreaterThan(0);
  });

  it("says each thing once: the lead carries no item, and each item is one line", async () => {
    const rig = await connected();
    await ask(rig, "What's due this week?");
    const answer = lastAgent(rig);
    for (const line of answer?.lines ?? []) expect(answer?.text).not.toContain(line.title);
    await ask(rig, "Find anything about the late policy");
    const found = lastAgent(rig);
    expect(found?.text).toBe("8 results.");
    expect(new Set(found?.lines?.map((line) => line.title)).size).toBe(found?.lines?.length);
  });

  it("doesn't call something due when its time already passed today, and keeps what's due later today", async () => {
    const rig = await connected();
    const [base] = allOf(rig, "assignments");
    if (!base) throw new Error("No assignment.");
    const passed = {
      ...base,
      shortTitle: "Due this morning",
      dueAt: "2026-10-30T09:00:00" as IsoTime,
    };
    const tonight = {
      ...base,
      ref: "lcc:assignment:tonight" as Assignment["ref"],
      shortTitle: "Due tonight",
      dueAt: "2026-10-30T23:59:00" as IsoTime,
    };
    const scope = scopeOf(rig, { assignments: [passed, tonight] });
    const said = [
      ...northStarStream(
        { request: "What's due?", thread: { history: [] }, scope },
        { ...scope.northStar!, now: "2026-10-30T14:00:00" as IsoTime },
      ),
    ].at(-1) as { text: string; lines: readonly { title: string }[] };
    expect(said.text).toBe("1 assignment is due in the next 7 days.");
    expect(said.lines.map((line) => line.title)).toEqual(["Due tonight", "All of what's due"]);
  });

  it("says when a find has more than it shows, and how to narrow it", async () => {
    const rig = await connected();
    await ask(rig, "Find anything about ENG");
    const answer = lastAgent(rig);
    const shown = answer?.lines?.length ?? 0;
    expect(shown).toBe(8);
    expect(answer?.text).toMatch(/^Showing 8 of \d+ results\. Name a course to narrow it\.$/);
    await ask(rig, "Find anything about ENG 101");
    expect(lastAgent(rig)?.lines?.every((line) => line.detail?.includes("ENG 101"))).toBe(true);
  });

  it("counts grading per course, and the count moves with the data", async () => {
    const rig = await connected();
    await ask(rig, "What needs grading?");
    const answer = lastAgent(rig);
    const open = Object.values(rig.state().cache)
      .flatMap((cache) => cache.submissions)
      .filter((s) => s.workflow === "submitted").length;
    expect(answer?.text).toContain(`${open} submissions need a grade`);
    const eng = courseByCode(rig, "ENG 101");
    expect(answer?.lines).toContainEqual(
      expect.objectContaining({ source: { kind: "course", ref: eng.ref }, title: "ENG 101" }),
    );
    expect(answer?.lines?.at(-1)?.source).toEqual({ kind: "due" });
  });

  it("finds a rubric, and reports its real criteria", async () => {
    const rig = await connected();
    await ask(rig, "Where's the rubric for Essay 2?");
    const essay = allOf(rig, "assignments").find((a) => a.shortTitle === "Essay 2");
    const answer = lastAgent(rig);
    expect(answer?.text).toBe("1 result.");
    expect(answer?.lines?.map((line) => line.source)).toEqual([
      { kind: "assignment", ref: essay?.ref },
    ]);
    for (const criterion of essay?.rubric ?? [])
      expect(answer?.lines?.[0]?.detail).toContain(criterion.name);
  });

  it("says plainly when an assignment has no rubric", async () => {
    const rig = await connected();
    const bare = allOf(rig, "assignments").find((a) => !a.rubric);
    if (!bare) throw new Error("The seed has an assignment with no rubric.");
    await ask(rig, `Where's the rubric for ${bare.shortTitle}?`);
    expect(lastAgent(rig)?.lines?.[0]?.detail).toContain("It has no rubric.");
  });

  it("finds the late policy on the assignments that have one, and only those", async () => {
    const rig = await connected();
    await ask(rig, "Find anything about the late policy");
    const answer = lastAgent(rig);
    const assignments = allOf(rig, "assignments");
    const cited =
      answer?.lines?.flatMap(({ source }) => (source.kind === "assignment" ? [source.ref] : [])) ??
      [];
    expect(new Set(cited)).toEqual(
      new Set(assignments.filter((a) => a.latePointsPerDay !== null).map((a) => a.ref)),
    );
    expect(answer?.lines?.some((line) => line.detail?.includes("2.5 points a day"))).toBe(true);
    expect(answer?.lines?.some(({ source }) => source.kind === "conversation")).toBe(true);
  });

  it("searches announcement bodies", async () => {
    const rig = await connected();
    await ask(rig, "Find anything about printed copies");
    expect(lastAgent(rig)?.lines?.map(({ source }) => source.kind)).toEqual(["announcement"]);
  });

  it("finds a student by name, and links the work waiting on a grade", async () => {
    const rig = await connected();
    await ask(rig, "Find Priya Raman");
    const submissions = Object.values(rig.state().cache).flatMap((cache) => cache.submissions);
    const waiting = submissions.find(
      (s) => s.studentName === "Priya Raman" && s.workflow === "submitted",
    );
    if (!waiting) throw new Error("The seed has work from Priya Raman to grade.");
    const answer = lastAgent(rig);
    expect(answer?.lines).toContainEqual({
      source: { kind: "submission", ref: waiting.ref },
      title: "Priya Raman",
      detail: "ENG 101, to grade",
    });
    await ask(rig, "Find Priya");
    expect(lastAgent(rig)?.lines?.map((line) => line.title)).toContain("Priya Raman");
  });

  it("admits when it finds nothing, cites nothing, and says the words as typed", async () => {
    const rig = await connected();
    await ask(rig, "Find anything about Parking Permits");
    expect(lastAgent(rig)?.text).toContain("can't find anything about Parking Permits");
    expect(lastAgent(rig)?.lines).toBeUndefined();
  });

  it("declines to approve or send as a plain note that names the real button, the same as every other thread", async () => {
    const rig = await connected();
    await ask(rig, "approve them all");
    expect(messagesOf(rig, chatOf(rig), "declined").at(-1)?.text).toContain(
      "Review before sending",
    );
    expect(
      messagesOf(rig, chatOf(rig), "declined")
        .at(-1)
        ?.lines?.map((line) => line.source.kind),
    ).toEqual(["due"]);
    await ask(rig, "send it");
    expect(messagesOf(rig, chatOf(rig), "declined")).toHaveLength(2);
    expect(messagesOf(rig, chatOf(rig), "refusal")).toEqual([]);
    expect(Object.keys(rig.state().changes)).toEqual([]);
  });

  it("declines to delete, the same plain note as a send, and touches nothing", async () => {
    const rig = await connected();
    await ask(rig, "Delete all the grades in ENG 101");
    expect(messagesOf(rig, chatOf(rig), "declined").at(-1)?.text).toContain("can't delete");
    expect(handoffCodes(rig)).toEqual([]);
    expect(Object.keys(rig.state().changes)).toEqual([]);
  });

  it("keeps a real rule break as a refusal, apart from an ordinary no", async () => {
    const agent: Agent = {
      label: "rule breaker",
      async *run() {
        yield { type: "approve", change: "anything" };
      },
    };
    const rig = await connected({ agent });
    await ask(rig, "do it");
    expect(messagesOf(rig, chatOf(rig), "refusal")).toHaveLength(1);
    expect(messagesOf(rig, chatOf(rig), "declined")).toEqual([]);
  });

  it("falls back to the next work, in the plan's order", async () => {
    const rig = await connected();
    await ask(rig, "hello there");
    expect(lastAgent(rig)?.text).toContain("I can tell you what's due");
    const steps = sittingsOf(
      planWork({
        groups: selectWhatsDue(rig.state(), rig.state().now()),
        extras: selectDueExtras(rig.state()),
        stages: selectWorkStages(rig.state()),
        expired: [],
        now: rig.state().now(),
      }),
    )
      .flatMap((sitting) => sitting.steps.slice(0, 1))
      .slice(0, 3);
    const offered = lastAgent(rig)?.replies ?? [];
    expect(offered).toHaveLength(3);
    for (const [index, step] of steps.entries())
      expect(offered[index]).toContain(step.courseCode ?? "");
    expect(offered[0]).toContain("Start grading");
    expect(new Set(steps.map((step) => step.courseCode)).size).toBe(3);
  });

  it("every piece of work its fallback offers starts in that course, not the fallback or a no", async () => {
    const start = await connected();
    await ask(start, "hello there");
    const offered = lastAgent(start)?.replies ?? [];
    expect(offered).toHaveLength(3);
    expect(lastAgent(start)?.text).toMatch(/start work in them\.$/);
    for (const answer of offered) {
      const rig = await connected();
      await ask(rig, answer);
      expect(messagesOf(rig, chatOf(rig), "declined")).toEqual([]);
      expect(lastAgent(rig)?.text).not.toContain("I can tell you what's due");
      expect(handoffCodes(rig)).toHaveLength(1);
      expect(answer).toContain(handoffCodes(rig)[0]);
      expect(lastAgent(rig)?.text).not.toContain("I left out");
    }
  });

  it("links a refusal to the drafts it can't approve, and to What's due", async () => {
    const rig = await connected();
    await ask(rig, "Draft this week's announcement for HUM 150");
    const [draft] = Object.keys(rig.state().changes) as ChangeId[];
    await ask(rig, "approve them all");
    const lines = messagesOf(rig, chatOf(rig), "declined").at(-1)?.lines;
    expect(lines?.map((line) => line.source)).toEqual([
      { kind: "change", ref: draft },
      { kind: "due" },
    ]);
    expect(lines?.[0]).toMatchObject({
      title: "Monday screening moves to Hale Auditorium",
      detail: "HUM 150",
    });
  });

  it("refuses an answer line that links a draft outside the scope", async () => {
    const scope = scopeOf(await connected());
    const parsed = parseAgentEffect(
      {
        type: "decline",
        text: "No.",
        lines: [{ source: { kind: "change", ref: "not-a-draft" }, title: "A draft" }],
      },
      scope,
    );
    expect(parsed).toMatchObject({ ok: false, error: { kind: "out-of-scope" } });
  });

  it("offers what it can do when the plan is empty", async () => {
    const rig = await connected();
    const scope = scopeOf(rig);
    const said = [
      ...northStarStream(
        { request: "hello there", thread: { history: [] }, scope },
        scope.northStar!,
      ),
    ].at(-1) as { text: string; replies: readonly string[] };
    expect(said.text).toBe(
      "I didn't catch that. I can tell you what's due, find things in your courses, and start work in them.",
    );
    expect(said.replies).toHaveLength(3);
    for (const reply of said.replies) {
      const answered = await connected();
      await ask(answered, reply);
      expect(lastAgent(answered)?.text).not.toContain("I can tell you what's due");
    }
  });

  it("seeds no agent line that goes stale once a draft exists, or that uses an internal word", () => {
    const said = Object.values(seedThreads()).flatMap((thread) =>
      thread.messages.flatMap((message) => (message.type === "agent" ? [message.text] : [])),
    );
    expect(said.length).toBeGreaterThan(0);
    expect(said.filter((text) => /haven't drafted|write-back|writeback/i.test(text))).toEqual([]);
  });

  it("offers no example chips, because the composer starts empty and ready", () => {
    expect(composerHints({ kind: "north-star", content: null, canEdit: false }).examples).toEqual(
      [],
    );
  });
});

describe("North Star home", () => {
  it("starts with no messages and no fake history", async () => {
    const rig = await connected();
    expect(threadOf(rig, NORTH_STAR_THREAD).messages).toEqual([]);
  });

  it("stays empty, because each ask from it starts its own chat", async () => {
    const rig = await connected();
    const first = await startChat(rig, "What's due\n  this week?");
    const second = await startChat(rig, "What needs grading?");
    expect(first).not.toBe(second);
    expect(threadOf(rig, first)).toMatchObject({
      kind: "north-star-chat",
      school: null,
      course: null,
      title: "What's due this week?",
    });
    expect(messagesOf(rig, first, "agent").length).toBeGreaterThan(0);
    expect(threadOf(rig, second).title).toBe("What needs grading?");
    expect(threadOf(rig, NORTH_STAR_THREAD).messages).toEqual([]);
  });

  it("posts nothing when sent to directly", async () => {
    const rig = await connected();
    await rig.clock.run(rig.state().sendToAgent(NORTH_STAR_THREAD, "What's due this week?"));
    expect(threadOf(rig, NORTH_STAR_THREAD).messages).toEqual([]);
    expect(chats(rig)).toEqual([]);
  });

  it("leaves nothing behind with no AI key, and its chats hide", async () => {
    const rig = await connected({ noKey: true });
    expect(rig.state().startChat("What's due this week?")).toBeNull();
    expect(chats(rig)).toEqual([]);
    const home = threadOf(rig, NORTH_STAR_THREAD);
    const chat = { ...home, id: "t-chat" as ThreadId, kind: "north-star-chat" } as const;
    expect(withoutChatThreads([home, chat], false)).toEqual([]);
    expect(withoutChatThreads([home, chat], true)).toEqual([home, chat]);
    expect(isChatThread(home)).toBe(true);
  });

  const rebootedWith = async (
    messages: readonly ThreadMessage[],
    destination?: readonly ThreadMessage[],
  ) => {
    const first = await connected();
    const raw = JSON.parse(first.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "") as {
      state: { threads: Record<string, Thread> };
    };
    raw.state.threads[NORTH_STAR_THREAD] = { ...threadOf(first, NORTH_STAR_THREAD), messages };
    if (destination)
      raw.state.threads["t-e101-ann"] = {
        ...threadOf(first, "t-e101-ann" as ThreadId),
        messages: destination,
      };
    first.storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(raw));
    const reloaded = await makeStoreRig({
      storage: first.storage,
      vault: first.vault,
      clock: first.clock,
    });
    await reloaded.clock.run(reloaded.state().boot());
    return reloaded;
  };
  const at = "2026-10-30T15:42:00.000Z" as IsoTime;

  it("drops the old greeting from a saved workspace, with no chat made for it", async () => {
    const rig = await rebootedWith([{ type: "agent", text: "Ask me what's due.", at }]);
    expect(threadOf(rig, NORTH_STAR_THREAD).messages).toEqual([]);
    expect(chats(rig)).toEqual([]);
  });

  it("moves a saved conversation to a chat named by its first ask, and a course thread's link follows it", async () => {
    const conversation: readonly ThreadMessage[] = [
      { type: "agent", text: "Ask me what's due.", at },
      { type: "user", text: "Draft this  week's\nannouncement", at },
      { type: "agent", text: "Which course?", at },
    ];
    const rig = await rebootedWith(conversation, [
      { type: "handed-off", from: NORTH_STAR_THREAD, request: "Draft", at },
    ]);
    expect(threadOf(rig, NORTH_STAR_THREAD).messages).toEqual([]);
    const [chat, ...others] = chats(rig);
    expect(others).toEqual([]);
    expect(chat).toMatchObject({
      title: "Draft this week's announcement",
      school: null,
      course: null,
      messages: conversation,
    });
    expect(
      messagesOf(rig, "t-e101-ann" as ThreadId, "handed-off").map((message) => message.from),
    ).toEqual([chat?.id]);
  });

  it("drops a seeded question from a saved thread and keeps what the person typed", async () => {
    const typed: ThreadMessage = { type: "user", text: "What can you do here?", at };
    const rig = await rebootedWith(
      [],
      [
        { type: "user", text: "Draft this week's announcement for ENG 101.", at, seeded: true },
        typed,
      ],
    );
    expect(threadOf(rig, "t-e101-ann" as ThreadId).messages).toEqual([typed]);
  });

  it("moves it once, however many times the workspace boots", async () => {
    const rig = await rebootedWith([{ type: "user", text: "What's due this week?", at }]);
    const before = rig.state().threads;
    await rig.clock.run(rig.state().boot());
    const again = await makeStoreRig({ storage: rig.storage, vault: rig.vault, clock: rig.clock });
    await again.clock.run(again.state().boot());
    expect(chats(rig)).toHaveLength(1);
    expect(chats(again).map((chat) => chat.id)).toEqual(
      Object.values(before)
        .filter((thread) => thread.kind === "north-star-chat")
        .map((thread) => thread.id),
    );
    expect(threadOf(again, NORTH_STAR_THREAD).messages).toEqual([]);
  });

  it("appears in a saved workspace from before it, and the list takes its new name", async () => {
    const first = await connected();
    const raw = JSON.parse(first.storage.getItem(WORKSPACE_STORAGE_KEY) ?? "") as {
      state: { threads: Record<string, Thread> };
    };
    const { [NORTH_STAR_THREAD]: _gone, ...old } = raw.state.threads;
    raw.state.threads = {
      ...old,
      "t-queue": { ...(old["t-queue"] as Thread), title: "Grading queue" },
    };
    first.storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(raw));
    const reloaded = await makeStoreRig({
      storage: first.storage,
      vault: first.vault,
      clock: first.clock,
    });
    expect(reloaded.state().threads[NORTH_STAR_THREAD]).toBeUndefined();
    await reloaded.clock.run(reloaded.state().boot());
    expect(threadOf(reloaded, NORTH_STAR_THREAD).kind).toBe("north-star");
    expect(threadOf(reloaded, "t-queue" as ThreadId).title).toBe("Grading list");
  });
});

describe("threadForWork", () => {
  it("finds the seeded thread and creates the rest under the usual titles", async () => {
    const rig = await connected();
    const eng = courseByCode(rig, "ENG 101");
    expect(rig.state().threadForWork(eng, { kind: "announcement" })).toBe("t-e101-ann");
    expect(rig.state().threadForWork(eng, { kind: "replies" })).toBe("t-e101-mail");
    const assignment = allOf(rig, "assignments").find(
      (a) => a.course === eng.ref && a.shortTitle === "Essay 3 Outline",
    ) as { ref: LmsRef<"assignment"> };
    const id = rig.state().threadForWork(eng, { kind: "grading", assignment: assignment.ref });
    expect(threadOf(rig, id).title).toBe("Grade Essay 3 Outline");
    expect(rig.state().threadForWork(eng, { kind: "grading", assignment: assignment.ref })).toBe(
      id,
    );
  });
});

describe("answer lines", () => {
  it("knows which course a line opens, and shows nothing once a sync took it away", async () => {
    const rig = await connected();
    const assignment = allOf(rig, "assignments")[0];
    if (!assignment) throw new Error("No assignment.");
    const source = { kind: "assignment", ref: assignment.ref } as const;
    expect(selectSource(rig.state(), source)?.course).toBe(assignment.course);
    expect(selectSource(rig.state(), { kind: "assignment", ref: "gone" as never })).toBeNull();
    expect(selectSource(rig.state(), { kind: "due" })).toEqual({ course: null });
  });
});

describe("what a Next up row promises", () => {
  const stepsOf = (rig: StoreRig) =>
    planWork({
      groups: selectWhatsDue(rig.state(), rig.state().now()),
      extras: selectDueExtras(rig.state()),
      stages: selectWorkStages(rig.state()),
      expired: [],
      now: rig.state().now(),
    }).steps;
  const announcementOf = (rig: StoreRig) =>
    stepsOf(rig).find((step) => step.key === "announcement:t-h150-ann");

  it("a grade step counts the submissions to grade that came in late", async () => {
    const rig = await connected();
    const lateIn = (assignment: string) =>
      Object.values(rig.state().cache)
        .flatMap((cache) => cache.submissions)
        .filter((s) => s.assignment === assignment && s.workflow === "submitted" && s.lateDays > 0)
        .length;
    const grades = stepsOf(rig).flatMap((step) =>
      step.work.kind === "grade"
        ? [{ detail: step.detail, late: lateIn(step.work.item.assignment.ref) }]
        : [],
    );
    expect(grades.some((grade) => grade.late > 0)).toBe(true);
    for (const { detail, late } of grades) expect(detail.endsWith(`, ${late} late`)).toBe(late > 0);
  });

  it("an announcement nobody has drafted says so, and opening it makes the draft the row then offers to review", async () => {
    const rig = await connected();
    const before = announcementOf(rig);
    expect(before).toMatchObject({ verb: "Write", detail: "Not started" });
    if (before?.work.kind !== "announcement") throw new Error("No announcement step.");
    await rig.clock.run(
      rig.state().openAnnouncement(before.work.draft.thread.id, before.work.draft.course.ref),
    );
    expect(announcementOf(rig)).toMatchObject({ verb: "Review", detail: "AI draft. Not sent" });
  });

  it("a discarded draft goes back to needing a draft", async () => {
    const rig = await connected();
    const thread = "t-h150-ann" as ThreadId;
    const course = rig.state().threads[thread]?.course;
    if (!course) throw new Error("No course.");
    const id = await rig.clock.run(rig.state().openAnnouncement(thread, course));
    if (!id) throw new Error("Nothing drafted.");
    rig.state().dispatchUser(id, {
      type: "discard",
      at: new Date(rig.state().now()).toISOString() as IsoTime,
    });
    expect(announcementOf(rig)).toMatchObject({ verb: "Write", detail: "Not started" });
  });

  it("undoing a discard brings the draft back as it was, until another draft takes its place", async () => {
    const rig = await connected();
    const thread = "t-h150-ann" as ThreadId;
    const course = rig.state().threads[thread]?.course;
    if (!course) throw new Error("No course.");
    const id = await rig.clock.run(rig.state().openAnnouncement(thread, course));
    const before = id && rig.state().changes[id];
    if (!id || !before) throw new Error("Nothing drafted.");
    const discard = () =>
      rig.state().dispatchUser(id, {
        type: "discard",
        at: new Date(rig.state().now()).toISOString() as IsoTime,
      });
    discard();
    expect(rig.state().restoreChange(before)).toBe(true);
    expect(rig.state().changes[id]).toEqual(before);
    expect(announcementOf(rig)).toMatchObject({ verb: "Review", detail: "AI draft. Not sent" });

    discard();
    const next = await rig.clock.run(rig.state().openAnnouncement(thread, course));
    expect(next).not.toBe(id);
    expect(rig.state().restoreChange(before)).toBe(false);
    expect(rig.state().changes[id]?.state.tag).toBe("discarded");
  });

  it("drafting one reply leaves the other student's row saying it has no draft", async () => {
    const rig = await connected();
    const replies = stepsOf(rig).find(
      (step) => step.work.kind === "replies" && step.courseCode === "HUM 150",
    );
    if (replies?.work.kind !== "replies") throw new Error("No replies step.");
    expect(replies).toMatchObject({ verb: "Reply to", detail: "Not started" });
    const [ezra, amara] = replies.work.rows;
    await rig.clock.run(
      rig.state().openConversation("t-h150-mail" as ThreadId, ezra.conversation.ref),
    );
    const after = stepsOf(rig).filter(
      (step) => step.work.kind === "replies" && step.courseCode === "HUM 150",
    );
    expect(after.map((step) => [step.verb, step.title, step.detail])).toEqual([
      ["Review", ezra.conversation.from, "AI draft. Not sent"],
      ["Reply to", amara!.conversation.from, "Not started"],
    ]);
  });

  it("a grading thread's opening counts work to grade, and says where the missing students are", async () => {
    const rig = await connected();
    const thread = rig.state().threads["t-h150-seq" as ThreadId];
    const assignment = thread?.assignment;
    if (!assignment) throw new Error("No assignment.");
    const cache = Object.values(rig.state().cache).find((candidate) =>
      candidate.submissions.some((s) => s.assignment === assignment),
    );
    const submissions = cache?.submissions.filter((s) => s.assignment === assignment) ?? [];
    const absent = submissions
      .filter((s) => s.workflow === "missing")
      .map((s) => cache?.students.find((student) => student.ref === s.student)?.name);
    const open = selectQueueRows(rig.state(), assignment).filter((row) => row.open).length;
    expect(absent).toHaveLength(1);
    const said = thread?.messages.find((message) => message.type === "agent");
    expect(said?.type === "agent" && said.text).toContain(
      `**${open}** still need a grade (1 late).`,
    );
    expect(said?.type === "agent" && said.text).toContain(
      `${absent[0]} hasn't turned anything in. Missing work sits at the end of the list.`,
    );
    const listed = selectQueueRows(rig.state(), assignment, true);
    expect(listed.filter((row) => row.missing).map((row) => row.submission.studentName)).toEqual(
      absent,
    );
  });
});

describe("who hasn't turned work in", () => {
  const submissionsOf = (rig: StoreRig) =>
    Object.values(rig.state().cache).flatMap((cache) => cache.submissions);
  const assignmentNamed = (rig: StoreRig, title: string) => {
    const assignment = allOf(rig, "assignments").find((a) => a.shortTitle === title);
    if (!assignment) throw new Error(`No assignment ${title}.`);
    return assignment;
  };

  it("names each student with missing work, leaves out excused work, and links each to their submission", async () => {
    const rig = await connected();
    const speech = assignmentNamed(rig, "Speech 2");
    const [late, absent, excused] = submissionsOf(rig).filter((s) => s.assignment === speech.ref);
    if (!late || !absent || !excused) throw new Error("Speech 2 has three submissions.");
    const submissions = submissionsOf(rig).map((s) =>
      s === late || s === absent
        ? { ...s, workflow: "missing" as const }
        : s === excused
          ? { ...s, workflow: "excused" as const }
          : s,
    );
    const scope = scopeOf(rig, { submissions });
    const said = [
      ...northStarStream(
        { request: "Who has not submitted Speech 2?", thread: { history: [] }, scope },
        scope.northStar!,
      ),
    ].map((effect) => parseAgentEffect(effect, scope));
    const answer = said.at(-1);
    if (!answer?.ok || answer.value.type !== "say") throw new Error("North Star answers.");
    const missing = [late, absent].sort((a, b) => a.studentName.localeCompare(b.studentName));
    expect(answer.value.text).toBe("2 students haven't turned in **Speech 2** in **COMM 110**.");
    expect(answer.value.lines).toEqual(
      missing.map((s) => ({
        source: { kind: "submission", ref: s.ref },
        title: s.studentName,
        detail: "COMM 110, missing",
      })),
    );
    expect(said.every((effect) => effect.ok && ["work", "say"].includes(effect.value.type))).toBe(
      true,
    );
  });

  it("answers from the cache in a real chat, and drafts nothing", async () => {
    const rig = await connected();
    const essay = assignmentNamed(rig, "Essay 2");
    const missing = submissionsOf(rig).filter(
      (s) => s.assignment === essay.ref && s.workflow === "missing",
    );
    await ask(rig, "Who hasn't turned in Essay 2?");
    const answer = lastAgent(rig);
    expect(answer?.text).toBe(
      `${missing.length} student hasn't turned in **Essay 2** in **ENG 101**.`,
    );
    expect(answer?.lines?.map((line) => line.title)).toEqual(missing.map((s) => s.studentName));
    expect(selectThreadChanges(rig.state(), chatOf(rig))).toEqual([]);
  });

  it("asks which assignment when none is named, offering the ones with missing work", async () => {
    const rig = await connected();
    await ask(rig, "Who hasn't turned in their work?");
    const answer = lastAgent(rig);
    expect(answer?.text).toBe("Which assignment? These have the most missing work.");
    const [offered] = answer?.replies ?? [];
    if (!offered) throw new Error("An assignment is offered.");
    await ask(rig, offered);
    expect(lastAgent(rig)?.lines?.map(({ source }) => source.kind)).toEqual(["submission"]);
  });

  it("says nothing is missing yet when no one is past due", async () => {
    const rig = await connected();
    const outline = assignmentNamed(rig, "Essay 3 Outline");
    await ask(rig, "Who's missing Essay 3 Outline?");
    const answer = lastAgent(rig);
    expect(answer?.text).toMatch(
      /^Nothing is missing for \*\*Essay 3 Outline\*\* in \*\*ENG 101\*\*\. It's due /,
    );
    expect(answer?.lines?.map((line) => line.source)).toEqual([
      { kind: "assignment", ref: outline.ref },
    ]);
  });

  it("offers only the named course's assignments when no assignment is named", async () => {
    const rig = await connected();
    const hum = courseByCode(rig, "HUM 150");
    await ask(rig, "Who's missing work in HUM 150?");
    const offered = lastAgent(rig)?.replies ?? [];
    const titles = allOf(rig, "assignments")
      .filter((a) => a.course === hum.ref)
      .map((a) => `Who hasn't submitted ${a.shortTitle}?`);
    expect(offered.length).toBeGreaterThan(0);
    for (const reply of offered) expect(titles).toContain(reply);
  });

  it("leaves asks to draft or start work that mention missing work to those intents", async () => {
    const rig = await connected();
    const scope = scopeOf(rig);
    for (const request of [
      "Draft an announcement reminding students who haven't turned in Essay 2 for ENG 101",
      "Draft replies to students who haven't submitted Essay 2",
      "Start grading Essay 2 but skip students who haven't submitted",
    ]) {
      const said = [
        ...northStarStream({ request, thread: { history: [] }, scope }, scope.northStar!),
      ];
      expect(
        said.some((effect) => (effect as { type: string }).type === "handoff"),
        request,
      ).toBe(true);
    }
  });
});
