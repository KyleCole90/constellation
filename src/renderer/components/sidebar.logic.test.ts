import { describe, expect, it } from "vite-plus/test";

import type { IsoTime, LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import { withoutChatThreads } from "~/renderer/stores/selectors";
import type { Thread } from "~/renderer/stores/types";

import {
  chatsNewestFirst,
  courseChoiceAfterToggle,
  describeWaiting,
  jumpOrder,
  keptChat,
  onCoursePages,
  setupGroupLabel,
  stepThread,
  visibleThreads,
} from "./sidebar.logic";

const thread = (id: string): Thread & { kind: "general" } => ({
  id: id as ThreadId,
  school: null,
  course: null,
  kind: "general",
  title: id,
  messages: [],
  focus: null,
  updatedAt: "2026-10-30T00:00:00.000Z" as IsoTime,
});
const ids = (list: readonly Thread[]) => list.map((t) => t.id);
const FIVE = ["a", "b", "c", "d", "e"].map(thread);

describe("visibleThreads", () => {
  const labels = (entries: ReturnType<typeof visibleThreads>) =>
    entries.map((entry) => ("more" in entry ? `+${entry.more.length}` : entry.id));

  it("shows the first three of a long list and counts the rest", () => {
    expect(labels(visibleThreads(FIVE, null, false))).toEqual(["a", "b", "c", "+2"]);
  });

  it("keeps a thread past the cutoff in its place, with one count of every hidden thread below it", () => {
    expect(labels(visibleThreads(FIVE, "e" as ThreadId, false))).toEqual(["a", "b", "e", "+2"]);
    expect(labels(visibleThreads(FIVE, "d" as ThreadId, false))).toEqual(["a", "b", "d", "+2"]);
  });

  it("shows everything once the course is expanded", () => {
    expect(visibleThreads(FIVE, null, true)).toEqual(FIVE);
  });
});

describe("keptChat", () => {
  const chat = thread("chat");
  const handedOff: Thread = {
    ...thread("course-thread"),
    messages: [
      {
        type: "handed-off",
        from: chat.id,
        request: "Draft the announcement",
        at: "2026-10-30T00:00:00.000Z" as IsoTime,
      },
    ],
  };
  const threads = { [chat.id]: chat, [handedOff.id]: handedOff };

  it("keeps the chat a handed-off thread came from", () => {
    expect(keptChat({ threads }, handedOff.id)).toBe(chat.id);
  });

  it("keeps the latest chat that handed off when two did", () => {
    const later = thread("later-chat");
    const twice: Thread = {
      ...handedOff,
      messages: [
        ...handedOff.messages,
        {
          type: "handed-off",
          from: later.id,
          request: "Draft it again",
          at: "2026-10-31T00:00:00.000Z" as IsoTime,
        },
      ],
    };
    expect(keptChat({ threads: { ...threads, [twice.id]: twice } }, twice.id)).toBe(later.id);
  });

  it("keeps the chat whose card opened the thread when two chats handed off", () => {
    const later = thread("later-chat");
    const twice: Thread = {
      ...handedOff,
      messages: [
        ...handedOff.messages,
        {
          type: "handed-off",
          from: later.id,
          request: "Draft it again",
          at: "2026-10-31T00:00:00.000Z" as IsoTime,
        },
      ],
    };
    const state = { threads: { ...threads, [twice.id]: twice } };
    expect(keptChat(state, twice.id, chat.id)).toBe(chat.id);
    expect(keptChat(state, twice.id, "never-handed-off" as ThreadId)).toBe(later.id);
  });

  it("keeps the active thread otherwise", () => {
    expect(keptChat({ threads }, chat.id)).toBe(chat.id);
    expect(keptChat({ threads }, null)).toBe(null);
  });
});

describe("chatsNewestFirst", () => {
  it("keeps only chats, ordered by when each started, whatever happened in them since", () => {
    const chat = (id: string, startedAt: string, updatedAt: string): Thread => ({
      ...thread(id),
      kind: "north-star-chat",
      updatedAt: updatedAt as IsoTime,
      messages: [{ type: "user", text: id, at: startedAt as IsoTime }],
    });
    const older = chat("older", "2026-10-30T01:00:00.000Z", "2026-10-30T09:00:00.000Z");
    const newer = chat("newer", "2026-10-30T02:00:00.000Z", "2026-10-30T02:00:00.000Z");
    expect(ids(chatsNewestFirst([older, thread("home"), newer]))).toEqual(["newer", "older"]);
  });
});

describe("jumpOrder", () => {
  it("skips collapsed groups and stops at nine", () => {
    const many = Array.from({ length: 12 }, (_, i) => thread(`t${i}`));
    expect(
      jumpOrder([
        { collapsed: true, threads: FIVE },
        { collapsed: false, threads: many },
      ]),
    ).toHaveLength(9);
    expect(jumpOrder([{ collapsed: true, threads: FIVE }])).toEqual([]);
  });
});

describe("courseChoiceAfterToggle", () => {
  it("keeps an expand from elsewhere", () => {
    expect(courseChoiceAfterToggle(undefined, false)).toBe(true);
  });

  it("keeps a collapse of the course you're in", () => {
    expect(courseChoiceAfterToggle(undefined, true)).toBe(false);
    expect(courseChoiceAfterToggle(true, true)).toBe(false);
  });

  it("clears a choice that now matches where you are, so the course opens when you next arrive", () => {
    expect(courseChoiceAfterToggle(true, false)).toBeUndefined();
    expect(courseChoiceAfterToggle(false, true)).toBeUndefined();
  });
});

describe("onCoursePages", () => {
  const course = "lcc:course:5" as LmsRef<"course">;

  it("matches the course and its tabs but not a course whose ref starts the same", () => {
    expect(onCoursePages(course, `/courses/${encodeURIComponent(course)}`)).toBe(true);
    expect(onCoursePages(course, `/courses/${encodeURIComponent(course)}/gradebook`)).toBe(true);
    expect(onCoursePages(course, `/courses/${encodeURIComponent(course)}1`)).toBe(false);
  });
});

describe("stepThread", () => {
  const order = ["a", "b", "c"] as unknown as readonly ThreadId[];

  it("wraps at both ends", () => {
    expect(stepThread(order, "c" as ThreadId, 1)).toBe("a");
    expect(stepThread(order, "a" as ThreadId, -1)).toBe("c");
  });

  it("starts at the top from a screen that is not a thread", () => {
    expect(stepThread(order, null, 1)).toBe("a");
  });
});

describe("withoutChatThreads", () => {
  const chat = thread("chat");
  const grading: Thread = {
    ...thread("grading"),
    kind: "grading",
    school: "lcc" as SchoolId,
    course: "course" as LmsRef<"course">,
    assignment: "assignment" as LmsRef<"assignment">,
  };

  it("drops chat threads with AI off and keeps the work threads", () => {
    expect(withoutChatThreads([chat, grading], false)).toEqual([grading]);
  });

  it("keeps every thread with AI on", () => {
    expect(withoutChatThreads([chat, grading], true)).toEqual([chat, grading]);
  });
});

describe("describeWaiting", () => {
  const none = { attention: 0, ready: 0, approval: 0, grade: 0, unread: 0 };

  it("shows the total in the colour of the most urgent kind and spells out the parts", () => {
    expect(describeWaiting({ ...none, grade: 7, unread: 3 })).toEqual({
      count: 10,
      tone: "unread",
      label: "10 need you: 3 unread, 7 to grade",
    });
    expect(describeWaiting({ ...none, ready: 1, grade: 7, unread: 3 })).toEqual({
      count: 11,
      tone: "ready",
      label: "11 need you: 1 ready to send, 3 unread, 7 to grade",
    });
    expect(describeWaiting({ ...none, attention: 1, ready: 1 }).tone).toBe("attention");
  });

  it("says one kind plainly, with its own number first", () => {
    expect(describeWaiting({ ...none, unread: 3 })).toEqual({
      count: 3,
      tone: "unread",
      label: "3 unread",
    });
    expect(describeWaiting({ ...none, approval: 1 }).label).toBe("1 needs approval");
  });

  it("counts nothing when nothing is waiting", () => {
    expect(describeWaiting(none).count).toBe(0);
  });
});

describe("setupGroupLabel", () => {
  it("names the term when the courses share one", () => {
    expect(setupGroupLabel([{ termName: "Spring 2027" }, { termName: "Spring 2027" }])).toBe(
      "2 Spring 2027 courses to set up",
    );
    expect(setupGroupLabel([{ termName: "Spring 2027" }])).toBe("1 Spring 2027 course to set up");
  });

  it("leaves out a term with no name", () => {
    expect(setupGroupLabel([{ termName: "" }])).toBe("1 course to set up");
  });

  it("leaves the term out when they don't", () => {
    expect(setupGroupLabel([{ termName: "Spring 2027" }, { termName: "Summer 2027" }])).toBe(
      "2 courses to set up",
    );
  });
});
