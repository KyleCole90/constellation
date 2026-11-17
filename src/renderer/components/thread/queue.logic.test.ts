import { describe, expect, it } from "vite-plus/test";

import { summarize, type ChangeRecord } from "~/shared/domain/change";
import { isoTime } from "~/shared/domain/ids";
import type { RowKey } from "~/renderer/stores/types";

import {
  assignmentChoices,
  batchChanges,
  filterRows,
  followWorkUrl,
  liveFilter,
  moreWords,
  moveCursor,
  parseThreadSearch,
  readWorkUrl,
  nameFillsStrip,
  neighbor,
  nextLabel,
  nextOpen,
  runOf,
  queueChips,
  queueProgress,
  rowLine,
  rowStatus,
  type ThreadSearch,
  type WorkView,
  rowsOutOfView,
  selectable,
  splitSelection,
  type WorkRow,
} from "./queue.logic";
import { approved, changeSummary, held, newDraft, sent } from "../../../../tests/fixtures/changes";
import { conversationRow, course, school, submissionRow } from "../../../../tests/fixtures/rows";
import { lmsRef } from "../../../../tests/fixtures/ids";

const row = submissionRow;
/** A row holding this change, summarized as the queue would. */
const holding = (record: ChangeRecord) => ({ change: record, summary: summarize(record) });

const ROWS = [
  row("none"),
  row("draft", holding(newDraft())),
  row("ready", { ...holding(approved()), school: school("rsu") }),
  row("stuck", holding(held())),
  row("sent", { ...holding(sent()), open: false }),
];
const keys = (rows: readonly WorkRow[]) => rows.map((r) => r.key);

describe("filterRows", () => {
  it.each([
    ["all", ["none", "draft", "ready", "stuck", "sent"]],
    ["needs-draft", ["none"]],
    ["ready-to-approve", ["draft"]],
    ["approved", ["ready"]],
    ["attention", ["stuck"]],
    ["school:rsu", ["ready"]],
  ] as const)("%s keeps only its own rows", (filter, expected) => {
    expect(keys(filterRows(ROWS, filter))).toEqual(expected);
  });
});

describe("queueChips", () => {
  it("offers a chip per school when the queue spans schools, counting open work", () => {
    const chips = queueChips(ROWS);
    expect(chips.map((chip) => chip.label)).toEqual([
      "All",
      "LCC",
      "RSU",
      "Not started",
      "AI draft, not sent",
      "Ready to send",
      "Needs attention",
    ]);
    expect(chips[0]?.count).toBe(4);
  });

  it("drops the school chips when one school holds all the work", () => {
    expect(
      queueChips([row("a"), row("b", holding(newDraft()))]).map((chip) => chip.label),
    ).not.toContain("LCC");
  });

  it("never offers a chip with nothing behind it", () => {
    const chips = queueChips([row("a"), row("b"), row("c", holding(newDraft()))]);
    expect(chips.map((chip) => [chip.label, chip.count])).toEqual([
      ["All", 3],
      ["Not started", 2],
      ["AI draft, not sent", 1],
    ]);
  });

  it("offers no chips when every open row is in the same state", () => {
    expect(queueChips([row("a"), row("b")])).toEqual([]);
    expect(queueChips([row("a"), row("sent", { ...holding(sent()), open: false })])).toEqual([]);
  });

  it("a draft's chip says what its rows say, and the words true of them all when authors differ", () => {
    const say = (label: string) =>
      row(label, { change: newDraft(), summary: changeSummary({ canApprove: true, label }) });
    const drafts = (...labels: string[]) =>
      queueChips([row("a"), ...labels.map(say)]).find((chip) => chip.filter === "ready-to-approve")
        ?.label;
    expect(drafts("AI draft. Not sent")).toBe("AI draft, not sent");
    expect(drafts("AI draft. Not sent", "Draft. Not sent")).toBe("Draft, not sent");
  });

  it("names a state with the word its row uses", () => {
    const labels = queueChips(ROWS).map((chip) => chip.label);
    expect(labels).toContain(summarize(approved()).label);
    expect(labels).toContain(rowStatus(row("none"), false).label);
  });

  it("a row whose student was asked to resubmit says so, and isn't Not started (#98)", () => {
    const asked = row("asked", { open: false, asked: isoTime("2026-11-14T15:00:00.000Z") });
    expect(rowStatus(asked, false).label).toMatch(/^Asked to resubmit · Nov 1[45]$/);
    expect(keys(filterRows([row("none"), asked], "needs-draft"))).toEqual(["none"]);
  });
});

describe("assignment choices", () => {
  const MIXED = [
    row("a1"),
    row("a2"),
    row("m1", {
      detail: "Memo",
      assignment: lmsRef<"assignment">("a-memo"),
      course: course({ code: "ENG 305" }),
    }),
    row("m2", {
      detail: "Memo",
      assignment: lmsRef<"assignment">("a-memo"),
      course: course({ code: "ENG 305" }),
      open: false,
    }),
  ];

  it("offers one choice per assignment, named by course and assignment, counting open work", () => {
    expect(assignmentChoices(MIXED).map((choice) => [choice.label, choice.count])).toEqual([
      ["HUM 150 Essay 2", 2],
      ["ENG 305 Memo", 1],
    ]);
    expect(queueChips(MIXED).some((chip) => chip.filter.startsWith("assignment:"))).toBe(false);
  });

  it("keeps an assignment filter live while that assignment has open work", () => {
    expect(liveFilter(MIXED, "assignment:a-memo")).toBe("assignment:a-memo");
    expect(
      liveFilter(
        MIXED.filter((r) => r.key !== "m1"),
        "assignment:a-memo",
      ),
    ).toBe("all");
  });

  it("keeps only that assignment's rows", () => {
    expect(keys(filterRows(MIXED, "assignment:a-memo"))).toEqual(["m1", "m2"]);
  });

  it("offers no assignment choice when every row shares one assignment", () => {
    expect(assignmentChoices(ROWS)).toEqual([]);
  });
});

describe("liveFilter", () => {
  const drafted = (key: string) => row(key, holding(newDraft()));

  it("keeps a filter that still has rows", () => {
    expect(liveFilter([row("a"), drafted("b")], "ready-to-approve")).toBe("ready-to-approve");
  });

  it("falls back to All once a filter's last row leaves it, so the list is never empty", () => {
    const rows = [row("a"), row("b")];
    const filter = liveFilter(rows, "ready-to-approve");
    expect(filter).toBe("all");
    expect(filterRows(rows, filter)).toHaveLength(2);
  });
});

describe("rowLine", () => {
  const grading = { course: lmsRef<"course">("c"), assignment: lmsRef<"assignment">("a") };

  it("adds nothing in a thread that names the course and the assignment", () => {
    expect(rowLine(row("a", { dueAt: isoTime("2026-10-26T12:00:00Z") }), grading)).toBe("");
  });

  it("keeps the subject in a replies thread, which only names the course", () => {
    expect(
      rowLine(conversationRow("a", { detail: "Screening time" }), {
        course: lmsRef<"course">("c"),
      }),
    ).toBe("Screening time");
  });

  it("ends with the labelled due date, after the course and the assignment, in a list across courses", () => {
    expect(rowLine(row("a", { dueAt: isoTime("2026-10-26T12:00:00Z") }), { course: null })).toBe(
      "HUM 150 · Essay 2 · Due Oct 26",
    );
  });
});

describe("queueProgress", () => {
  it("a grading list counts grades, requests to resubmit, and what's left, each by name (#122)", () => {
    const asked = (key: string) =>
      row(key, { open: false, asked: isoTime("2026-11-14T12:00:00Z") });
    expect(queueProgress([asked("a"), asked("b"), row("c")]).label).toBe(
      "0 graded · 2 asked to resubmit · 1 to grade",
    );
    expect(queueProgress(ROWS)).toEqual({
      label: "1 graded · 4 to grade",
      place: null,
      done: "1 graded",
      fraction: 1 / 5,
    });
  });

  it("a grading list calls missing work missing, never work to grade (#151)", () => {
    const missing = (key: string) => row(key, { missing: true });
    expect(queueProgress([missing("a"), missing("b")]).label).toBe("0 graded · 2 missing");
    expect(queueProgress([row("a", { open: false }), missing("b"), row("c")]).label).toBe(
      "1 graded · 1 missing · 1 to grade",
    );
  });

  it("a message queue counts replies sent", () => {
    expect(queueProgress([conversationRow("a")]).label).toBe("0 of 1 sent");
    expect(queueProgress([conversationRow("a", { open: false }), conversationRow("b")]).label).toBe(
      "1 of 2 sent",
    );
  });

  it("a draft doesn't count as progress", () => {
    const drafted = conversationRow("a", { change: newDraft("c") });
    expect(queueProgress([drafted, conversationRow("b")]).label).toBe("0 of 2 sent");
  });

  it("an empty queue has no fraction to divide", () => {
    expect(queueProgress([]).fraction).toBe(0);
  });

  it("with a current row, its place in the queue stands apart from what's been graded", () => {
    const rows = [row("a"), row("b"), row("c", { open: false })];
    expect(queueProgress(rows, "b")).toMatchObject({ place: "2 of 3", done: "1 graded" });
    expect(queueProgress(rows, "gone").place).toBeNull();
  });
});

describe("nameFillsStrip", () => {
  it("only a name too long to share the strip takes all of it", () => {
    expect(nameFillsStrip("Bartholomew Montgomery")).toBe(false);
    expect(nameFillsStrip("Arjun Venkataraghavan-Subramaniam Krishnamurthy")).toBe(true);
  });
});

describe("rowsOutOfView", () => {
  const view = { top: 100, bottom: 200 };
  const rows = [
    { top: 60, bottom: 100 },
    { top: 100, bottom: 140 },
    { top: 140, bottom: 180 },
    { top: 180, bottom: 220 },
    { top: 220, bottom: 260 },
  ];

  it("counts a row showing only a sliver as hidden", () => {
    expect(rowsOutOfView(view, rows)).toEqual({ above: 1, below: 2 });
    expect(rowsOutOfView({ top: 101, bottom: 300 }, rows.slice(1))).toEqual({ above: 0, below: 0 });
    expect(rowsOutOfView({ top: 120, bottom: 300 }, rows)).toEqual({ above: 2, below: 0 });
  });

  it("says what's left to see, and nothing once everything shows", () => {
    expect(moreWords({ above: 0, below: 1 })).toBe("1 more below");
    expect(moreWords({ above: 2, below: 1 })).toBe("1 more below");
    expect(moreWords({ above: 2, below: 0 })).toBe("2 more above");
    expect(moreWords({ above: 0, below: 0 })).toBeNull();
  });
});

describe("neighbor and nextOpen", () => {
  it("neighbor stops at the ends rather than wrapping", () => {
    expect(neighbor(ROWS, "none", -1)).toBeNull();
    expect(neighbor(ROWS, "none", 1)?.key).toBe("draft");
  });

  it("nextOpen skips a sent row and wraps round to the start", () => {
    expect(nextOpen(ROWS, "stuck")?.key).toBe("none");
  });

  it("nextOpen is null once no other row has work left", () => {
    expect(nextOpen([row("a"), row("b", { open: false })], "a")).toBeNull();
  });
});

describe("a course's To grade in the Grading list (#48)", () => {
  const music = course({ ref: lmsRef<"course">("c-music"), code: "MUS 101" });
  const rows = [row("a", { course: music }), row("b", { course: music }), row("c")];

  it("narrows the list to that course, with a chip that names it and All to undo it", () => {
    const filter = liveFilter(rows, "course:c-music");
    expect(filter).toBe("course:c-music");
    expect(keys(filterRows(rows, filter))).toEqual(["a", "b"]);
    expect(queueChips(rows, filter).map((chip) => [chip.label, chip.count])).toEqual([
      ["All", 3],
      ["MUS 101", 2],
    ]);
  });

  it("shows no course chip unless the course is the filter", () => {
    expect(queueChips(rows).some((chip) => chip.filter.startsWith("course:"))).toBe(false);
  });
});

describe("nextLabel (#48)", () => {
  it("names the work when the next row is the same student as the one just sent, so it can't read as pointing back (#81)", () => {
    const composition = row("Stephanie Charles", { detail: "Composition" });
    expect(nextLabel(composition, true, row("Stephanie Charles"))).toBe(
      "Draft next: Stephanie's Composition",
    );
    expect(nextLabel(composition, true, row("Jean Tuttle"))).toBe("Draft next: Stephanie Charles");
  });

  it("says a draft will start when Next would ask Claude for one", () => {
    expect(nextLabel(row("Jean Tuttle"), true)).toBe("Draft next: Jean Tuttle");
  });

  it("is plain Next when nothing would be drafted", () => {
    expect(nextLabel(row("Jean Tuttle"), false)).toBe("Next: Jean Tuttle");
    const drafted = row("Jean Tuttle", { change: newDraft() });
    expect(nextLabel(drafted, true)).toBe("Next: Jean Tuttle");
  });

  it("is plain Next when the next work is one Claude can't read, which opens the hand form (#71)", () => {
    expect(nextLabel(row("Shelly Cole", { draftable: false }), true)).toBe("Next: Shelly Cole");
  });
});

describe("runOf", () => {
  const list = [row("a"), row("b"), row("c"), row("d"), row("e", { open: false })];
  it("walks the ticked rows in list order, not tick order", () => {
    const run = runOf(list, ["d", "b"]);
    expect(run.find((r) => r.open)?.key).toBe("b");
    expect(nextOpen(run, "b")?.key).toBe("d");
  });

  it("is every shown row when nothing open is ticked", () => {
    expect(keys(runOf(list, []))).toEqual(keys(list));
    expect(keys(runOf(list, ["e", "gone"]))).toEqual(keys(list));
  });

  it("keeps a sent ticked row while another is open, so the count and arrows hold their place", () => {
    const run = runOf([row("a", { open: false }), row("b"), row("c")], ["c", "a"]);
    expect(queueProgress(run, "a").place).toBe("1 of 2");
    expect(neighbor(run, "a", 1)?.key).toBe("c");
    expect(nextOpen(run, "a")?.key).toBe("c");
  });
});

describe("moveCursor", () => {
  it("clamps at both ends and starts at the top", () => {
    expect(moveCursor(-1, 1, 3)).toBe(0);
    expect(moveCursor(2, 1, 3)).toBe(2);
    expect(moveCursor(0, -1, 3)).toBe(0);
    expect(moveCursor(0, 1, 0)).toBe(-1);
  });
});

describe("splitSelection", () => {
  it("rows with no draft go to Draft, drafted ones to Review, and sent ones to neither", () => {
    const { toDraft, toReview } = splitSelection(ROWS, ["none", "draft", "sent"]);
    expect(keys(toDraft)).toEqual(["none"]);
    expect(keys(toReview)).toEqual(["draft"]);
  });

  it("a row still drafting goes to neither, even once its draft has landed", () => {
    const { toDraft, toReview, drafting } = splitSelection(
      ROWS,
      ["none", "draft", "ready"],
      new Set(["none", "draft"]),
    );
    expect(keys(toDraft)).toEqual([]);
    expect(keys(toReview)).toEqual(["ready"]);
    expect(keys(drafting)).toEqual(["none", "draft"]);
  });
});

describe("selectable", () => {
  it("with AI on every open row can be picked, so a blank one can be drafted", () => {
    expect(keys(ROWS.filter((r) => selectable(r, true)))).toEqual([
      "none",
      "draft",
      "ready",
      "stuck",
    ]);
  });

  it("with AI off a blank row has nothing to batch, so only drafted rows can be picked", () => {
    expect(keys(ROWS.filter((r) => selectable(r, false)))).toEqual(["draft", "ready", "stuck"]);
  });
});

describe("batchChanges", () => {
  const rows = [
    row("a", { change: newDraft("c1") }),
    row("b"),
    row("c", { change: newDraft("c3") }),
  ];

  it("a batch holds only selected rows that have a change", () => {
    expect(batchChanges(rows, ["a", "b", "c"])).toEqual(["c1", "c3"]);
  });

  it("deselecting a row takes it out of the batch", () => {
    expect(batchChanges(rows, ["c"])).toEqual(["c3"]);
  });
});

describe("missing work", () => {
  const rows = [
    row("submitted"),
    row("fiona", { missing: true }),
    row("bo", { missing: true, change: newDraft(), open: false }),
  ];

  it("a Missing chip narrows to students still to settle", () => {
    expect(queueChips(rows).find((chip) => chip.filter === "missing")?.count).toBe(1);
    expect(keys(filterRows(rows, "missing"))).toEqual(["fiona"]);
  });

  it("a missing row reads as not started until a draft exists", () => {
    expect(rowStatus(rows[1]!, false).label).toBe("Not started");
  });
});

describe("followWorkUrl", () => {
  const list = { view: "list" } as const;
  const batch = { view: "batch" } as const;
  const hannah = { row: "sub-hannah" as RowKey };
  const rowAt = (raw: string) => (raw === hannah.row ? hannah.row : null);
  const follow = (url: ThreadSearch, view: WorkView, moved: boolean, reviewable: boolean) =>
    followWorkUrl(url, rowAt, view, moved, reviewable);

  it("makes opening the batch or a row a new entry, so Back returns to what was before", () => {
    expect(follow(list, batch, false, true)).toEqual({ write: batch, replace: false });
    expect(follow(batch, hannah, false, true)).toEqual({ write: hannah, replace: false });
  });

  it("shows what Back or Forward lands on", () => {
    expect(follow(batch, hannah, true, true)).toEqual({ show: batch });
    expect(follow(list, batch, true, true)).toEqual({ show: list });
    expect(follow(hannah, list, true, true)).toEqual({ show: hannah });
  });

  it("gives a URL that names nothing what is showing, in place", () => {
    expect(follow({}, hannah, true, true)).toEqual({ write: hannah, replace: true });
    expect(follow({ row: "not-a-row" }, hannah, true, true)).toEqual({
      write: hannah,
      replace: true,
    });
  });

  it("replaces a batch with nothing left to review instead of reopening it", () => {
    expect(follow(batch, list, true, false)).toEqual({ write: list, replace: true });
  });

  it("does nothing once the URL and the screen agree", () => {
    expect(follow(hannah, { ...hannah }, true, true)).toBeNull();
  });

  it("does nothing when the screen still names a row the workspace lost, as after a reset", () => {
    const gone = { row: "sub-gone" as RowKey };
    expect(follow({ row: "sub-gone" }, gone, false, true)).toBeNull();
    expect(follow({ row: "sub-gone" }, gone, true, true)).toBeNull();
  });

  it("reads a row the thread can't show as naming nothing", () => {
    expect(readWorkUrl({ row: "sub-hannah" }, rowAt)).toEqual(hannah);
    expect(readWorkUrl({ row: "not-a-row" }, rowAt)).toBeNull();
    expect(readWorkUrl({ view: "batch" }, rowAt)).toEqual(batch);
    expect(readWorkUrl({}, rowAt)).toBeNull();
  });

  it("reads a row before a view and drops anything else", () => {
    expect(parseThreadSearch({ row: "sub-1", view: "batch" })).toEqual({ row: "sub-1" });
    expect(parseThreadSearch({ view: "other" })).toEqual({});
  });
});
