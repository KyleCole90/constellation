import { describe, expect, it } from "vite-plus/test";

import type { ChangeRecord, ChangeSummary } from "~/shared/domain/change";
import type { ChangeId, IsoTime } from "~/shared/domain/ids";
import type { ThreadMessage } from "~/renderer/stores/types";

import { boldRuns, buildTimeline, visibleMessages, walkStep } from "./timeline.logic";

const at = (minute: number) => `2026-10-30T10:0${minute}:00.000Z` as IsoTime;
const work = (minute: number, line: string): ThreadMessage => ({
  type: "work",
  lines: [line],
  at: at(minute),
});
const say = (minute: number, text: string): ThreadMessage => ({
  type: "agent",
  text,
  at: at(minute),
});
const change = (minute: number, id: string, target = id, kind = "grade") =>
  ({
    id,
    content: { kind, target },
    activity: [{ at: at(minute), actor: "agent", text: "Drafted" }],
  }) as unknown as ChangeRecord;
const focusOn = (id: string | null, expanded = false) => ({
  focus: id as ChangeId | null,
  expanded,
});
const filed = (message: ThreadMessage, id: string): ThreadMessage => ({
  ...message,
  change: id as ChangeId,
});

describe("visibleMessages", () => {
  const notice: ThreadMessage = { type: "notice", text: "Couldn't read the LMS.", at: at(3) };
  const messages = [
    work(1, "a"),
    say(2, "done"),
    notice,
    { type: "user", text: "hi", at: at(4) },
    { type: "refusal", text: "no", at: at(5) },
  ] as const;

  it("shows only notices with AI off", () => {
    expect(visibleMessages(messages, false, false)).toEqual([notice]);
  });

  it("shows everything with AI on", () => {
    expect(visibleMessages(messages, true, false)).toEqual(messages);
  });

  it("drops the lead-in once the thread has a draft, and keeps what really happened", () => {
    const leadIn: ThreadMessage = { ...say(0, "Open one and I'll draft a reply."), seeded: true };
    const typed: ThreadMessage = { type: "user", text: "Make it shorter", at: at(1) };
    const answer = say(2, "Shorter now.");
    expect(visibleMessages([leadIn, typed, answer], true, false)).toEqual([leadIn, typed, answer]);
    expect(visibleMessages([leadIn, typed, answer], true, true)).toEqual([typed, answer]);
  });
});

describe("buildTimeline", () => {
  it("groups handoffs in a row, and a message between them splits the group", () => {
    const handoff = (minute: number, to: string) =>
      ({
        type: "handoff",
        to,
        course: "c",
        brief: "b",
        at: at(minute),
      }) as unknown as ThreadMessage;
    const items = buildTimeline(
      [handoff(1, "a"), handoff(1, "b"), say(2, "done"), handoff(3, "c")],
      [],
      focusOn(null),
    );
    expect(items.map((item) => item.type)).toEqual(["handoffs", "message", "handoffs"]);
    expect(items[0]).toMatchObject({ messages: [{ to: "a" }, { to: "b" }] });
  });

  it("collapses a run of work lines into one block", () => {
    const items = buildTimeline([work(1, "a"), work(1, "b"), say(2, "done")], [], focusOn(null));
    expect(items.map((item) => item.type)).toEqual(["work", "message"]);
    expect(items[0]).toMatchObject({ lines: ["a", "b"] });
  });

  it("a change splits work lines on either side of it", () => {
    const items = buildTimeline([work(1, "a"), work(3, "b")], [change(2, "c")], focusOn("c"));
    expect(items.map((item) => item.type)).toEqual(["work", "change", "work"]);
  });

  it("a change that ties a message goes before its reply", () => {
    const items = buildTimeline([say(2, "here it is")], [change(2, "c")], focusOn("c"));
    expect(items.map((item) => item.type)).toEqual(["change", "message"]);
  });

  const types = (items: ReturnType<typeof buildTimeline>) =>
    items.map((item) => (item.type === "message" ? item.message.type : item.type));
  const banner = (minute: number) =>
    ({
      type: "handed-off",
      from: "chat",
      request: "Draft it",
      at: at(minute),
    }) as unknown as ThreadMessage;
  const user = (minute: number): ThreadMessage => ({
    type: "user",
    text: "make it shorter",
    at: at(minute),
  });

  it("the ask and the reading stay above the draft they led to when the clock doesn't move", () => {
    const items = buildTimeline(
      [banner(2), work(2, "read"), say(2, "here it is")],
      [change(2, "c")],
      focusOn("c"),
    );
    expect(types(items)).toEqual(["handed-off", "work", "change", "agent"]);
  });

  it("a follow-up stays below a draft that ties it when the clock doesn't move", () => {
    const items = buildTimeline(
      [user(2), work(2, "read"), say(2, "here it is"), user(2), say(2, "shorter now")],
      [change(2, "c")],
      focusOn("c"),
    );
    expect(types(items)).toEqual(["user", "work", "change", "agent", "user", "agent"]);
  });

  const mixed = [
    say(1, "thread level"),
    filed(work(2, "read Stella"), "stella"),
    filed(work(3, "read Priya"), "priya"),
    filed(say(4, "for Priya"), "priya"),
    filed(say(5, "for Stella"), "stella"),
  ];
  const both = [change(2, "stella"), change(3, "priya")];
  const shownText = (items: ReturnType<typeof buildTimeline>) =>
    JSON.stringify(items.filter((item) => item.type !== "earlier"));

  it("another student's lines never show under the focused card", () => {
    const items = buildTimeline(mixed, both, focusOn("stella"));
    expect(shownText(items)).toContain("for Stella");
    expect(shownText(items)).not.toContain("Priya");
  });

  it("everything else collapses behind one quiet row that counts students", () => {
    const items = buildTimeline(mixed, both, focusOn("stella"));
    expect(items.filter((item) => item.type === "earlier")).toEqual([
      { type: "earlier", key: "earlier", label: "Earlier: 1 student", expanded: false },
    ]);
  });

  it("the thread's own messages show with nothing in focus", () => {
    const items = buildTimeline(mixed, both, focusOn(null));
    expect(items.map((item) => item.type)).toEqual(["message", "earlier"]);
    expect(items.at(-1)).toMatchObject({ label: "Earlier: 2 students" });
  });

  it("expanding brings it all back in place, with the row still there to close it", () => {
    const items = buildTimeline(mixed, both, focusOn("stella", true));
    expect(items.find((item) => item.type === "earlier")).toMatchObject({ expanded: true });
    expect(shownText(items)).toContain("for Priya");
    expect(items.filter((item) => item.type === "change")).toHaveLength(2);
  });

  it("a thread with one change and its messages has no earlier row", () => {
    expect(
      buildTimeline([filed(say(2, "hi"), "c")], [change(1, "c")], focusOn("c")).map(
        (item) => item.type,
      ),
    ).toEqual(["change", "message"]);
  });

  it("two drafts for one student count once, and announcements count as posts", () => {
    expect(
      buildTimeline(
        [],
        [change(1, "a", "maya"), change(2, "b", "maya"), change(3, "c")],
        focusOn("c"),
      ).find((item) => item.type === "earlier"),
    ).toMatchObject({ label: "Earlier: 1 student" });
    expect(
      buildTimeline(
        [],
        [
          change(1, "a", "course", "announcement"),
          change(2, "b", "course", "announcement"),
          change(3, "c", "course", "announcement"),
        ],
        focusOn("c"),
      ).find((item) => item.type === "earlier"),
    ).toMatchObject({ label: "Earlier: 2 posts" });
  });
});

describe("boldRuns", () => {
  it("marks the text between double asterisks as bold", () => {
    expect(boldRuns("a **b** c")).toEqual([
      { text: "a ", bold: false },
      { text: "b", bold: true },
      { text: " c", bold: false },
    ]);
  });
});

describe("walkStep", () => {
  const summary = (patch: Partial<ChangeSummary>) =>
    ({
      tone: "approval",
      canApprove: false,
      canSend: false,
      banner: null,
      sentAt: null,
      ...patch,
    }) as ChangeSummary;

  it("nothing open means open the next row", () => {
    expect(walkStep({ busy: false, summary: null, panel: null, chordSends: false })).toBe(
      "open-next",
    );
  });

  it("a draft with the panel elsewhere opens the review", () => {
    expect(
      walkStep({
        busy: false,
        summary: summary({ canApprove: true }),
        panel: "source",
        chordSends: false,
      }),
    ).toBe("review");
  });

  it("a draft on the card or under review stops at the Approve button and never approves", () => {
    for (const panel of [null, "writeback"] as const)
      expect(
        walkStep({ busy: false, summary: summary({ canApprove: true }), panel, chordSends: false }),
      ).toBe("focus-approve");
  });

  it("a grade only you have edited approves and sends from the card or the preview", () => {
    for (const panel of [null, "writeback"] as const)
      expect(
        walkStep({ busy: false, summary: summary({ canApprove: true }), panel, chordSends: true }),
      ).toBe("approve-and-send");
  });

  it("a hand grade under the source or batch panel opens the review, because the card may be covered", () => {
    for (const panel of ["source", "batch"] as const)
      expect(
        walkStep({ busy: false, summary: summary({ canApprove: true }), panel, chordSends: true }),
      ).toBe("review");
  });

  it("a hand grade with blanks still opens the review", () => {
    expect(
      walkStep({
        busy: false,
        summary: summary({ canApprove: false }),
        panel: null,
        chordSends: true,
      }),
    ).toBe("review");
  });

  it("an approved change sends from the card or the preview", () => {
    for (const panel of [null, "writeback"] as const)
      expect(
        walkStep({
          busy: false,
          summary: summary({ canSend: true, tone: "ready" }),
          panel,
          chordSends: false,
        }),
      ).toBe("send");
  });

  it("a change with a banner waits for a decision", () => {
    expect(
      walkStep({
        busy: false,
        summary: summary({ canSend: true, banner: "in-doubt" }),
        panel: "writeback",
        chordSends: false,
      }),
    ).toBe("none");
  });

  it("a sent change moves on", () => {
    expect(
      walkStep({
        busy: false,
        summary: summary({ sentAt: at(1) }),
        panel: "writeback",
        chordSends: false,
      }),
    ).toBe("open-next");
  });

  it("a sent change moves on even while the sync after the send is still running", () => {
    expect(
      walkStep({
        busy: true,
        summary: summary({ sentAt: at(1) }),
        panel: "writeback",
        chordSends: false,
      }),
    ).toBe("open-next");
  });

  it("does nothing mid-send", () => {
    expect(
      walkStep({
        busy: true,
        summary: summary({ canSend: true }),
        panel: "writeback",
        chordSends: false,
      }),
    ).toBe("none");
    expect(
      walkStep({
        busy: false,
        summary: summary({ tone: "working" }),
        panel: "writeback",
        chordSends: false,
      }),
    ).toBe("none");
  });
});
