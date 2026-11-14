import { describe, expect, it } from "vite-plus/test";

import type { ChangeRecord, ChangeSummary } from "~/shared/domain/change";
import type { SourceCourse } from "~/shared/domain/content";
import type { ChangeId, IsoDate, LmsRef } from "~/shared/domain/ids";
import type { Finding, FindingKey } from "~/shared/domain/scan";
import type { CourseSetup, ReviewRow } from "~/shared/domain/setup";
import { draftOf, draftTerm, termName, type PlanDraft, type TermPlan } from "~/shared/domain/term";

import {
  batchOf,
  courseName,
  dayMapWords,
  checkPlan,
  guessedEnd,
  groupRows,
  formPlan,
  typedPlan,
  occupiedWords,
  packageTermWords,
  publishedWords,
  readinessTable,
  rowWord,
  selectableKeys,
  sourceChoices,
  toggleNewDay,
} from "./setup.logic";

const summary = (patch: Partial<ChangeSummary>) =>
  ({
    label: "Needs approval",
    tone: "approval",
    recovery: "none",
    approvalReset: null,
    canApprove: false,
    canSend: false,
    ...patch,
  }) as ChangeSummary;
const change = (id: string) =>
  ({
    id: id as ChangeId,
    content: { kind: "text-fix" },
    basis: { remote: { kind: "text-fix" } },
  }) as ChangeRecord;
const finding = (type: Finding["type"], where = "Syllabus") => ({ type, where }) as Finding;
const row = (key: string, patch: Partial<ReviewRow> = {}): ReviewRow => ({
  key: key as FindingKey,
  finding: finding("plain-date"),
  status: "fix",
  change: null,
  summary: null,
  resolution: null,
  ...patch,
});
const pending = (key: string, can: Partial<ChangeSummary>) =>
  row(key, { change: change(`c-${key}`), summary: summary(can) });
const date = (text: string) => text as IsoDate;
const term = (start: string, end: string) => ({
  name: "T",
  start: date(start),
  end: date(end),
  days: [1 as const],
});
const draft = (patch: Partial<PlanDraft> = {}): PlanDraft => ({
  oldTerm: term("2026-01-01", "2026-05-01"),
  newTerm: term("2026-08-01", "2026-12-01"),
  breaks: [],
  ...patch,
});
const plan = (): TermPlan => ({
  oldTerm: { ...term("2026-01-01", "2026-05-01"), name: termName("T") },
  newTerm: { ...term("2026-08-01", "2026-12-01"), name: termName("T") },
  breaks: [],
});
const shell = {
  code: "BIO 101",
  termName: "Fall",
  startAt: date("2026-08-24"),
  endAt: date("2026-12-11"),
  studentCount: 0,
  itemCount: 0,
} as CourseSetup["shell"];
const source = (ref: string, template: boolean, code = ref) =>
  ({
    ref: ref as LmsRef<"course">,
    code,
    termName: "Spring",
    startAt: date("2026-01-12"),
    endAt: date("2026-05-08"),
    meetingDays: [2, 4],
    template,
  }) as unknown as SourceCourse;

describe("meeting days", () => {
  it("clicking Monday then Wednesday turns Tue/Thu into Mon/Wed", () => {
    const first = toggleNewDay([2, 4], 1, [2, 4]);
    expect(toggleNewDay(first, 3, [2, 4])).toEqual([1, 3]);
    expect(dayMapWords([2, 4], [1, 3])).toBe("Tuesday becomes Monday, Thursday becomes Wednesday.");
  });
  it("clicking a chosen day removes it, and the next click adds instead of moving", () => {
    const fewer = toggleNewDay([2, 4], 4, [2, 4]);
    expect(fewer).toEqual([2]);
    expect(toggleNewDay(fewer, 5, [2, 4])).toEqual([2, 5]);
  });
  it("adds rather than moves when the old term names no days", () => {
    expect(toggleNewDay([], 2, [])).toEqual([2]);
    expect(toggleNewDay([1], 3, [])).toEqual([1, 3]);
  });
  it("says the days stay when nothing moved", () => {
    expect(dayMapWords([2, 4], [2, 4])).toBe("Meeting days stay the same.");
  });
  it("says why the days matter while either side has none", () => {
    expect(dayMapWords([], [])).toMatch(/^Each due date moves from an old meeting day/);
    expect(dayMapWords([2], [])).toBe(dayMapWords([], []));
  });
});

describe("the plan a form opens with", () => {
  it("fills the old term from a course source and defaults new days to the old ones", () => {
    const opened = formPlan({ plan: null, shell, source: null }, source("a", false));
    expect(opened.oldTerm).toEqual({
      name: "Spring",
      start: "2026-01-12",
      end: "2026-05-08",
      days: [2, 4],
    });
    expect(opened.newTerm).toEqual({
      name: "Fall",
      start: "2026-08-24",
      end: "2026-12-11",
      days: [2, 4],
    });
  });
  it("keeps a plan already confirmed over the source", () => {
    const confirmed = plan();
    expect(formPlan({ plan: confirmed, shell, source: null }, source("a", false))).toEqual(
      draftOf(confirmed),
    );
  });
  it("reopens with what was last typed over a confirmed plan", () => {
    const typed = draft({
      breaks: [{ name: "Break", start: date("2026-10-01"), end: date("2026-10-02") }],
    });
    expect(formPlan({ plan: plan(), draft: typed, shell, source: null }, null)).toEqual(typed);
  });
  it("leaves the old term blank for a package with no hint, and the form refuses it", () => {
    const opened = formPlan(
      { plan: null, shell, source: { kind: "cartridge", name: "x.imscc", kb: 1, hint: null } },
      null,
    );
    expect(problemsOf(opened)).toContain("Fill in the old term's dates.");
  });
});

describe("a package's own term", () => {
  const hint = { ...term("2026-01-20", "2026-05-08"), name: termName("Spring 2026"), dated: [] };
  const cartridge = { kind: "cartridge", name: "x.imscc", kb: 1, hint } as const;
  it("says nothing when the old term matches the package", () => {
    expect(packageTermWords(cartridge, draftTerm(hint))).toBeNull();
  });
  it("names the package's term when the typed dates or days differ", () => {
    expect(packageTermWords(cartridge, term("2026-08-24", "2026-12-11"))).toBe(
      "This package comes from Spring 2026, Jan 20, 2026 to May 8, 2026, meeting Mo. The old term here doesn't match, so every shifted date would be off.",
    );
    expect(packageTermWords(cartridge, { ...draftTerm(hint), days: [2] })).not.toBeNull();
  });
  it("checks only what a package says, when its export leaves the end and days out", () => {
    const partial = {
      ...cartridge,
      hint: { name: null, start: date("2026-01-20"), end: "", days: [], dated: [] },
    } as const;
    expect(packageTermWords(partial, term("2026-01-20", "2026-05-08"))).toBeNull();
    expect(packageTermWords(partial, term("2026-01-12", "2026-05-08"))).toBe(
      "This package comes from a term starting Jan 20, 2026. The old term here doesn't match, so every shifted date would be off.",
    );
  });
  it("says nothing when the package's term isn't known", () => {
    expect(
      packageTermWords({ ...cartridge, hint: null }, term("2026-08-24", "2026-12-11")),
    ).toBeNull();
  });
});

const problemsOf = (draft: Parameters<typeof checkPlan>[0]): readonly string[] => {
  const checked = checkPlan(draft);
  return checked.ok ? [] : checked.error;
};

describe("checking the Dates form", () => {
  it("names an unfinished break before the plan's own rules, which would read a blank name", () => {
    const blank = { name: "", start: "", end: "" } as const;
    expect(problemsOf(draft({ breaks: [blank] }))).toEqual([
      "Finish break 1: it needs a name, a start, and an end.",
    ]);
  });
  it("passes on the plan's rule for a break outside the term", () => {
    expect(
      problemsOf(
        draft({
          breaks: [{ name: "Fall break", start: date("2027-01-01"), end: date("2027-01-02") }],
        }),
      ),
    ).toEqual(["Fall break is not inside the new term."]);
  });
  it("hands back the plan once every field is filled and the dates make sense", () => {
    const breaks = [{ name: "Break", start: date("2026-10-01"), end: date("2026-10-02") }];
    expect(checkPlan(draft({ breaks }))).toEqual({ ok: true, value: { ...plan(), breaks } });
  });
  it("reads a blank term name as no name, so nothing searches for it", () => {
    const checked = checkPlan(
      draft({ oldTerm: { ...term("2026-01-01", "2026-05-01"), name: " " } }),
    );
    expect(checked.ok && checked.value.oldTerm.name).toBeNull();
  });
});

describe("a package that leaves its end out", () => {
  const hint = { name: null, start: date("2026-01-12"), end: "" as const, days: [2 as const] };
  const spring = { start: date("2027-01-11"), end: date("2027-05-14") };
  it("ends as long after its start as the new term runs, so each due date keeps its week", () => {
    expect(guessedEnd({ ...hint, dated: [] }, spring)).toBe("2026-05-15");
  });
  it("never ends before its last due day", () => {
    const late = [{ title: "Final", due: date("2026-06-02") }];
    expect(guessedEnd({ ...hint, dated: late }, spring)).toBe("2026-06-02");
  });
  it("guesses nothing when the package states its end or the new term has no dates", () => {
    expect(guessedEnd({ ...hint, end: date("2026-05-08"), dated: [] }, spring)).toBeNull();
    expect(guessedEnd({ ...hint, dated: [] }, { start: "", end: "" })).toBeNull();
    expect(guessedEnd(null, spring)).toBeNull();
  });
  it("fills the old term's end when Dates opens on such a package", () => {
    const opened = formPlan(
      {
        plan: null,
        shell: { ...shell, startAt: spring.start, endAt: spring.end },
        source: { kind: "cartridge", name: "x.imscc", kb: 1, hint: { ...hint, dated: [] } },
      },
      null,
    );
    expect(opened.oldTerm).toMatchObject({ name: "", start: "2026-01-12", end: "2026-05-15" });
  });

  const undated = { ...shell, startAt: null, endAt: null };
  const cartridge = {
    kind: "cartridge",
    name: "x.imscc",
    kb: 1,
    hint: { ...hint, dated: [] },
  } as const;
  /** The form's edit loop: a change applies to what was typed, and the form shows that with its blanks filled. */
  const edit = (
    setup: Pick<CourseSetup, "plan" | "draft" | "shell" | "source">,
    patch: Partial<PlanDraft["newTerm"]>,
  ) => {
    const typed = typedPlan(setup, null);
    return { ...setup, draft: { ...typed, newTerm: { ...typed.newTerm, ...patch } } };
  };

  it("guesses the old end once the teacher types the new term's dates", () => {
    const opened = { plan: null, shell: undated, source: cartridge };
    expect(formPlan(opened, null).oldTerm.end).toBe("");
    const typed = edit(edit(opened, { start: spring.start }), { end: spring.end });
    expect(formPlan(typed, null).oldTerm.end).toBe("2026-05-15");
    expect(formPlan(edit(typed, { end: date("2027-05-28") }), null).oldTerm.end).toBe("2026-05-29");
  });
  it("keeps an old end the teacher typed when the new term's dates change", () => {
    const opened = { plan: null, shell: undated, source: cartridge };
    const typed = typedPlan(opened, null);
    const kept = {
      ...opened,
      draft: {
        ...typed,
        oldTerm: { ...typed.oldTerm, end: date("2026-05-01") },
        newTerm: { ...typed.newTerm, ...spring },
      },
    };
    expect(formPlan(kept, null).oldTerm.end).toBe("2026-05-01");
  });
  it("fills the new term from the course's own dates when the course gets them after Dates opened", () => {
    const typed = edit({ plan: null, shell: undated, source: cartridge }, { name: "Spring 2027" });
    const dated = formPlan(
      { ...typed, shell: { ...shell, startAt: spring.start, endAt: spring.end } },
      null,
    );
    expect(dated.newTerm).toMatchObject({ name: "Spring 2027", ...spring });
    expect(dated.oldTerm.end).toBe("2026-05-15");
  });
});

describe("destination and source lists", () => {
  it("says a course's code and title once when they match", () => {
    expect(courseName({ code: "live-source", title: "live-source" })).toBe("live-source");
    expect(courseName({ code: "BIO 101", title: "Biology" })).toBe("BIO 101 Biology");
  });
  it("warns only for a course with students or items", () => {
    expect(occupiedWords({ code: "BIO", studentCount: 0, itemCount: 0 })).toBeNull();
    expect(occupiedWords({ code: "BIO", studentCount: 1, itemCount: 4 })).toContain(
      "BIO already has 1 student and 4 items",
    );
  });
  it("lists the same code first, then templates, then the rest, and leaves out the course being set up", () => {
    const refs = sourceChoices(
      [
        source("a", false),
        source("self", false, "ENG 101"),
        source("b", true),
        source("previous", false, "ENG 101"),
        source("template", true, "ENG 101"),
      ],
      "self" as LmsRef<"course">,
      "ENG 101",
    ).map((entry) => entry.ref);
    expect(refs).toEqual(["template", "previous", "b", "a"]);
  });
});

describe("review rows", () => {
  it("groups by finding type and puts a fix the scan no longer finds under fixed", () => {
    const groups = groupRows([
      row("a"),
      row("b", { finding: finding("broken-link") }),
      row("c"),
      row("d", { finding: null, status: "fixed" }),
    ]);
    expect(groups.map((group) => [group.type, group.rows.length])).toEqual([
      ["plain-date", 2],
      ["broken-link", 1],
      ["fixed", 1],
    ]);
  });
  it("says needs approval again after an edit it can approve, and passage moved over any other state", () => {
    expect(rowWord({ status: "checking" }, summary({}))).toEqual({
      label: "Checking",
      tone: "working",
    });
    expect(
      rowWord({ status: "fix" }, summary({ approvalReset: "edited", canApprove: true })).label,
    ).toBe("Needs approval again");
    expect(
      rowWord(
        { status: "fix" },
        summary({ approvalReset: "edited", label: "In progress", tone: "todo" }),
      ).label,
    ).toBe("In progress");
    expect(
      rowWord({ status: "fix" }, summary({ recovery: "rescan", approvalReset: "edited" })).label,
    ).toBe("Passage moved");
    expect(rowWord({ status: "fix" }, summary({ label: "Sending", tone: "working" }))).toEqual({
      label: "Sending",
      tone: "working",
    });
  });
});

describe("the batch bar", () => {
  const rows = [
    pending("draft", { canApprove: true }),
    pending("other", { canApprove: true }),
    pending("ok", { canSend: true }),
    row("manual", { status: "manual" }),
  ];

  it("approves only checked drafts", () => {
    expect(batchOf(rows, ["draft", "manual"]).approve.map((record) => record.id)).toEqual([
      "c-draft",
    ]);
  });
  it("sends an approved fix nobody checked, so one approved on its row can leave", () => {
    expect(batchOf(rows, ["draft"]).send).toEqual(["c-ok"]);
  });
  it("sends only the checked approved fixes when any are checked", () => {
    const both = [...rows, pending("ok2", { canSend: true })];
    expect(batchOf(both, ["ok2"]).send).toEqual(["c-ok2"]);
  });
  it("offers a checkbox only on a fix that can still be approved or sent", () => {
    expect(selectableKeys(rows)).toEqual(["draft", "other", "ok"]);
  });
});

describe("the readiness table", () => {
  it("names what is left per group and counts a settled row as passing", () => {
    const table = readinessTable([
      row("a"),
      row("b", { finding: finding("empty-module"), status: "manual" }),
      row("c", { finding: finding("unpublished-item"), status: "dismissed" }),
    ]);
    expect(table.map(({ label, left }) => [label, left.map((entry) => entry.key)])).toEqual([
      ["Dates outside the term", ["a"]],
      ["Unresolved findings", []],
      ["Empty modules", ["b"]],
      ["Unpublished items", []],
    ]);
  });
});

describe("the published card", () => {
  it("says what happened to the findings, not what awaited approval", () => {
    const rows = [
      row("a", { status: "fixed" }),
      row("b", { status: "fixed" }),
      row("c", { status: "handled" }),
      row("d", { status: "dismissed" }),
    ];
    expect(publishedWords(rows)).toBe("2 fixes sent, 1 handled in the LMS, and 1 dismissed.");
  });

  it("names a single outcome alone", () => {
    expect(publishedWords([row("a", { status: "fixed" })])).toBe("1 fix sent.");
  });

  it("says nothing when the scan found nothing", () => {
    expect(publishedWords([])).toBeNull();
  });
});
