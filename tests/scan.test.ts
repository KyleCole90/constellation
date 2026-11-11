import { describe, expect, it } from "vite-plus/test";

import type {
  ContentItem,
  ContentLink,
  CourseContent,
  CourseModule,
  CourseShell,
  MigrationIssue,
  TextFixContent,
} from "~/shared/domain/content";
import type { IsoDate, IsoTime, LmsRef } from "~/shared/domain/ids";
import {
  RULES,
  scanCourse,
  type Finding,
  type FindingType,
  type ScanContext,
} from "~/shared/domain/scan";
import { spliceState } from "~/shared/domain/splice";
import type { TermPlan } from "~/shared/domain/term";

const d = (text: string): IsoDate => text as IsoDate;
const PLAN: TermPlan = {
  oldTerm: { name: "Fall 2026", start: d("2026-08-24"), end: d("2026-12-11"), days: [2, 4] },
  newTerm: { name: "Spring 2027", start: d("2027-01-19"), end: d("2027-05-07"), days: [1, 3] },
  breaks: [{ name: "Spring break", start: d("2027-03-08"), end: d("2027-03-12") }],
};
const CTX: ScanContext = {
  plan: PLAN,
  issues: [],
  written: [],
  contactEmail: "m.okafor@lakeshore.example",
};
const STATEMENT = {
  name: "Accessibility statement",
  mustInclude: ["accommodations", "Access Office"],
  text: "Accommodations are arranged through the Access Office.",
};
const TOOL = "tool:1" as LmsRef<"tool">;

const item = (patch: Partial<ContentItem> = {}): ContentItem => ({
  ref: "item:1" as LmsRef<"item">,
  type: "page",
  title: "Week one",
  body: "Plain words.",
  published: true,
  dueAt: null,
  openUrl: "https://lms.example/1",
  links: [],
  copied: false,
  ...patch,
});
const module_ = (patch: Partial<CourseModule> = {}): CourseModule => ({
  ref: "module:1" as LmsRef<"module">,
  title: "Unit 1",
  published: true,
  itemCount: 3,
  openUrl: "https://lms.example/m1",
  ...patch,
});
const course = (patch: Partial<CourseContent> = {}): CourseContent => ({
  shell: {} as CourseShell,
  version: "v1",
  items: [],
  modules: [],
  tools: [{ ref: TOOL, name: "Quiz tool", configured: true }],
  policy: { contactDomain: "lakeshore.example", statements: [] },
  ...patch,
});
const link = (patch: ContentLink): ContentLink => patch;
const issue = (open: boolean): MigrationIssue => ({
  severity: "warning",
  text: "A quiz question did not copy.",
  open,
  fixUrl: "https://lms.example/fix",
});
const on = (due: string): IsoTime => `${due}T23:59:00Z` as IsoTime;

interface RuleCase {
  positive: CourseContent;
  clean: CourseContent;
  ctx?: ScanContext;
  cleanCtx?: ScanContext;
  quote: string;
  fix: "text" | "set" | "manual";
}

/** A Record, so a new finding type fails to compile here until it has both fixtures. */
const CASES: Readonly<Record<FindingType, RuleCase>> = {
  "plain-date": {
    positive: course({ items: [item({ body: "Week 3, Oct 12: bring a draft." })] }),
    clean: course({ items: [item({ body: "Week 3, Mar 15: bring a draft." })] }),
    quote: "Oct 12",
    fix: "text",
  },
  "date-in-break": {
    positive: course({ items: [item({ dueAt: on("2027-03-10") })] }),
    clean: course({ items: [item({ dueAt: on("2027-03-15") })] }),
    quote: "2027-03-10",
    fix: "set",
  },
  "date-outside-term": {
    positive: course({ items: [item({ dueAt: on("2027-06-01") })] }),
    clean: course({ items: [item({ dueAt: on("2027-05-07") })] }),
    quote: "2027-06-01",
    fix: "set",
  },
  "old-term-name": {
    positive: course({ items: [item({ body: "Welcome to Fall 2026." })] }),
    clean: course({ items: [item({ body: "Welcome to Spring 2027." })] }),
    quote: "Fall 2026",
    fix: "text",
  },
  "old-course-link": {
    positive: course({
      items: [
        item({
          body: "See https://lms.example/old/5 now.",
          links: [
            link({
              text: "Rubric",
              url: "https://lms.example/old/5",
              points: "other-course",
              replacement: "https://lms.example/new/5",
            }),
          ],
        }),
      ],
    }),
    clean: course({
      items: [
        item({
          body: "See https://lms.example/new/5 now.",
          links: [
            link({ text: "Rubric", url: "https://lms.example/new/5", points: "this-course" }),
          ],
        }),
      ],
    }),
    quote: "Rubric",
    fix: "text",
  },
  "broken-link": {
    positive: course({
      items: [item({ links: [link({ text: "Reading", url: "/gone", points: "missing-page" })] })],
    }),
    clean: course({
      items: [item({ links: [link({ text: "Reading", url: "/here", points: "this-course" })] })],
    }),
    quote: "Reading",
    fix: "manual",
  },
  "missing-file": {
    positive: course({
      items: [item({ links: [link({ text: "notes.pdf", url: "/f/9", points: "missing-file" })] })],
    }),
    clean: course({
      items: [
        item({ links: [link({ text: "Article", url: "https://example.org", points: "web" })] }),
      ],
    }),
    quote: "notes.pdf",
    fix: "manual",
  },
  "lti-link": {
    positive: course({
      tools: [{ ref: TOOL, name: "Quiz tool", configured: false }],
      items: [item({ links: [link({ text: "Quiz 1", url: "/t/1", points: "tool", tool: TOOL })] })],
    }),
    clean: course({
      items: [item({ links: [link({ text: "Quiz 1", url: "/t/1", points: "tool", tool: TOOL })] })],
    }),
    quote: "Quiz 1",
    fix: "manual",
  },
  "copied-announcement": {
    positive: course({
      items: [item({ type: "announcement", title: "Welcome back", copied: true })],
    }),
    clean: course({ items: [item({ type: "announcement", title: "Hello", copied: false })] }),
    quote: "Welcome back",
    fix: "set",
  },
  "foreign-contact": {
    positive: course({ items: [item({ body: "Write to r.vance@northgate.example any time." })] }),
    clean: course({
      items: [
        item({
          body: "Write to m.okafor@lakeshore.example or m.okafor@mail.lakeshore.example any time.",
        }),
      ],
    }),
    quote: "r.vance@northgate.example",
    fix: "text",
  },
  "missing-statement": {
    positive: course({
      policy: { contactDomain: "lakeshore.example", statements: [STATEMENT] },
      items: [item({ type: "syllabus", body: "Course goals." })],
    }),
    clean: course({
      policy: { contactDomain: "lakeshore.example", statements: [STATEMENT] },
      items: [item({ type: "syllabus", body: "ACCOMMODATIONS through the access office." })],
    }),
    quote: STATEMENT.name,
    fix: "text",
  },
  "unpublished-item": {
    positive: course({ items: [item({ title: "Draft page", published: false })] }),
    clean: course({ items: [item()] }),
    quote: "Draft page",
    fix: "set",
  },
  "empty-module": {
    positive: course({ modules: [module_({ title: "Unit 9", itemCount: 0 })] }),
    clean: course({ modules: [module_()] }),
    quote: "Unit 9",
    fix: "manual",
  },
  "migration-issue": {
    positive: course(),
    clean: course(),
    ctx: { ...CTX, issues: [issue(true)] },
    cleanCtx: { ...CTX, issues: [issue(false)] },
    quote: "A quiz question did not copy.",
    fix: "manual",
  },
};

const fixKind = (finding: Finding): RuleCase["fix"] => {
  if (finding.fix === null) return "manual";
  return finding.fix.kind === "text-fix" ? "text" : "set";
};

describe("every rule through RULES", () => {
  it.each(Object.keys(CASES) as FindingType[])(
    "%s finds its case and stays quiet on the clean one",
    (type) => {
      const { positive, clean, ctx = CTX, cleanCtx = CTX, quote, fix } = CASES[type];
      const found = RULES[type](positive, ctx);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ type, quote });
      expect(fixKind(found[0] as Finding)).toBe(fix);
      expect(RULES[type](clean, cleanCtx)).toEqual([]);
    },
  );
});

const textFixOf = (finding: Finding | undefined): TextFixContent => {
  if (finding?.fix?.kind !== "text-fix") throw new Error("Expected a text fix.");
  return finding.fix;
};
const landed = (body: string, fix: TextFixContent): string => {
  const { prefix, before, after, suffix } = fix.splice;
  return body.replace(prefix + before + suffix, prefix + after + suffix);
};
const scanBody = (body: string, ctx: ScanContext = CTX): readonly Finding[] =>
  scanCourse(course({ items: [item({ body })] }), ctx);

describe("what a fix says", () => {
  it("rewrites a plain date through the shift and the break move, in its own format", () => {
    expect(
      textFixOf(
        RULES["plain-date"](
          course({ items: [item({ body: "Due Tuesday, October 13." })] }),
          CTX,
        )[0],
      ).splice.after,
    ).toBe("Monday, March 15");
  });

  it("says when a plain date was moved out of a break", () => {
    expect(
      RULES["plain-date"](course({ items: [item({ body: "Due Oct 12." })] }), CTX)[0]?.why,
    ).toContain("Moved out of Spring break");
  });

  it("leaves a range for a person", () => {
    expect(
      RULES["plain-date"](course({ items: [item({ body: "Trip on Oct 12-14." })] }), CTX)[0]?.fix,
    ).toBeNull();
  });

  it("moves a due date out of the break and keeps its time", () => {
    expect(RULES["date-in-break"](CASES["date-in-break"].positive, CTX)[0]?.fix).toMatchObject({
      kind: "item-set",
      intent: { set: "due-at", at: "2027-03-15T23:59:00Z" },
    });
  });

  it("flags a due date in a break once, not also as outside the term", () => {
    const stretched = {
      ...PLAN,
      breaks: [{ name: "Late break", start: d("2027-05-03"), end: d("2027-05-20") }],
    };
    const content = course({ items: [item({ dueAt: on("2027-05-15") })] });
    expect(RULES["date-outside-term"](content, { ...CTX, plan: stretched })).toEqual([]);
    expect(RULES["date-in-break"](content, { ...CTX, plan: stretched })).toHaveLength(1);
  });

  it("brings a date outside the term to the nearest class day", () => {
    expect(
      RULES["date-outside-term"](course({ items: [item({ dueAt: on("2027-01-04") })] }), CTX)[0]
        ?.fix,
    ).toMatchObject({ intent: { at: "2027-01-20T23:59:00Z" } });
    expect(
      RULES["date-outside-term"](course({ items: [item({ dueAt: on("2027-06-01") })] }), CTX)[0]
        ?.fix,
    ).toMatchObject({ intent: { at: "2027-05-05T23:59:00Z" } });
  });

  it("an old term name in a title has no text fix", () => {
    const found = RULES["old-term-name"](
      course({ items: [item({ title: "Fall 2026 calendar" })] }),
      CTX,
    );
    expect(found.map((finding) => finding.fix)).toEqual([null]);
  });

  it("an old course link with no replacement is manual", () => {
    const content = course({
      items: [
        item({
          body: "See /old/5.",
          links: [
            link({ text: "Rubric", url: "/old/5", points: "other-course", replacement: null }),
          ],
        }),
      ],
    });
    expect(RULES["old-course-link"](content, CTX)[0]?.fix).toBeNull();
  });

  it("every copy of an old link in a body is its own passage", () => {
    const url = "https://lms.example/old/5";
    const content = course({
      items: [
        item({
          body: `${url} and again ${url}`,
          links: [link({ text: "Rubric", url, points: "other-course", replacement: "/new/5" })],
        }),
      ],
    });
    expect(RULES["old-course-link"](content, CTX)).toHaveLength(2);
  });

  it("an address with no local replacement is manual", () => {
    expect(
      RULES["foreign-contact"](CASES["foreign-contact"].positive, { ...CTX, contactEmail: null })[0]
        ?.fix,
    ).toBeNull();
  });

  it("foreign office hours quote the whole paragraph, and raise no second row for the address", () => {
    const paragraph = "Office hours: Tuesdays 2 to 4 in Hale 210, or r.vance@northgate.example.";
    const found = RULES["foreign-contact"](
      course({ items: [item({ body: `Intro.\n\n${paragraph}` })] }),
      CTX,
    );
    expect(found.map((finding) => finding.quote)).toEqual([paragraph]);
    expect(found[0]?.fix).toBeNull();
  });

  it("a missing statement inserts its text at the end of the syllabus", () => {
    const fix = textFixOf(RULES["missing-statement"](CASES["missing-statement"].positive, CTX)[0]);
    expect(landed("Course goals.", fix)).toBe(`Course goals.\n\n${STATEMENT.text}`);
  });

  it("a course with no syllabus still reports a missing statement, as manual", () => {
    expect(
      RULES["missing-statement"](
        course({ policy: { contactDomain: "x.example", statements: [STATEMENT] } }),
        CTX,
      )[0],
    ).toMatchObject({ item: null, fix: null });
  });

  it("an unpublished module is manual", () => {
    expect(
      RULES["unpublished-item"](course({ modules: [module_({ published: false })] }), CTX)[0],
    ).toMatchObject({ type: "unpublished-item", fix: null });
  });

  it("a migration issue opens its fix link", () => {
    expect(RULES["migration-issue"](course(), { ...CTX, issues: [issue(true)] })[0]?.openUrl).toBe(
      "https://lms.example/fix",
    );
  });
});

describe("keys", () => {
  const BODY = "Quiz on Oct 12 in class.\n\nExam on Nov 3 in the hall.";

  it("stay the same for one passage when a neighbor passage is fixed", () => {
    const [quiz, exam] = scanBody(BODY);
    const after = scanBody(landed(BODY, textFixOf(quiz)));
    expect(after.map((finding) => finding.key)).toEqual([exam?.key]);
    expect(spliceState(landed(BODY, textFixOf(quiz)), textFixOf(exam).splice)).toBe("ready");
  });

  it("stay the same when words change elsewhere in the same paragraph", () => {
    const long = "Quiz on Oct 12 in class, and a lot more words follow here.";
    const [before] = scanBody(long);
    const [after] = scanBody(long.replace("a lot more words", "several other words"));
    expect(after?.key).toBe(before?.key);
  });

  it("stay the same when a fix lands right beside the passage", () => {
    const body = "Oct 12 and Oct 20 are the exams.";
    const [first, second] = scanBody(body);
    expect(scanBody(landed(body, textFixOf(first))).map((finding) => finding.key)).toEqual([
      second?.key,
    ]);
  });

  it("repeat across two scans of the same course", () => {
    expect(scanBody(BODY).map((finding) => finding.key)).toEqual(
      scanBody(BODY).map((finding) => finding.key),
    );
  });

  it("are unique across twin passages with the same words around them", () => {
    const twins = "Due Oct 12 at noon.\n\nDue Oct 12 at noon.";
    const keys = scanBody(twins).map((finding) => finding.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("stay unique when the copy report repeats itself, as one row", () => {
    expect(scanCourse(course(), { ...CTX, issues: [issue(true), issue(true)] })).toHaveLength(1);
  });

  it("differ by type and by item", () => {
    const body = "Fall 2026, Oct 12";
    const first = scanCourse(course({ items: [item({ body })] }), CTX);
    const second = scanCourse(
      course({ items: [item({ body, ref: "item:2" as LmsRef<"item"> })] }),
      CTX,
    );
    expect(new Set([...first, ...second].map((finding) => finding.key)).size).toBe(4);
  });
});

describe("a rescan after a fix lands", () => {
  it("drops a fixed plain date", () => {
    const body = "Due Oct 12.";
    const [finding] = scanBody(body);
    expect(scanBody(landed(body, textFixOf(finding)))).toEqual([]);
  });

  it("does not shift a year-less date again between same-season terms, once it knows what it wrote", () => {
    const spring: TermPlan = {
      ...PLAN,
      oldTerm: { name: "Spring 2026", start: d("2026-01-20"), end: d("2026-05-08"), days: [2, 4] },
      newTerm: { ...PLAN.newTerm, days: [2, 4] },
    };
    const ctx = { ...CTX, plan: spring };
    const body = "Paper due Feb 10 in class.";
    const fix = textFixOf(scanBody(body, ctx)[0]);
    const after = landed(body, fix);
    expect(scanBody(after, ctx)).toHaveLength(1);
    expect(scanBody(after, { ...ctx, written: [fix] })).toEqual([]);
  });

  it("still knows what it wrote after a fix lands right beside it", () => {
    const spring: TermPlan = {
      ...PLAN,
      oldTerm: { name: "Spring 2026", start: d("2026-01-20"), end: d("2026-05-08"), days: [2, 4] },
      newTerm: { ...PLAN.newTerm, days: [2, 4] },
    };
    const ctx = { ...CTX, plan: spring };
    const body = "Paper due Feb 10 and Feb 12 in class.";
    const firstFix = textFixOf(scanBody(body, ctx)[0]);
    const once = landed(body, firstFix);
    const secondFix = textFixOf(scanBody(once, { ...ctx, written: [firstFix] })[0]);
    expect(scanBody(landed(once, secondFix), { ...ctx, written: [firstFix, secondFix] })).toEqual(
      [],
    );
  });

  it("does not read the new term's name as the old one when the new name contains it", () => {
    const plan: TermPlan = {
      ...PLAN,
      oldTerm: { ...PLAN.oldTerm, name: "Spring 2027" },
      newTerm: { ...PLAN.newTerm, name: "Spring 2027 Online" },
    };
    const ctx = { ...CTX, plan };
    expect(
      scanBody("Welcome to Spring 2027 Online.", ctx).filter(
        (finding) => finding.type === "old-term-name",
      ),
    ).toEqual([]);
    expect(
      scanBody("Welcome to Spring 2027.", ctx).filter(
        (finding) => finding.type === "old-term-name",
      ),
    ).toHaveLength(1);
  });
});

describe("scanCourse", () => {
  it("runs every rule over a course that plants them all", () => {
    const content = course({
      policy: { contactDomain: "lakeshore.example", statements: [STATEMENT] },
      tools: [{ ref: TOOL, name: "Quiz tool", configured: false }],
      modules: [module_({ itemCount: 0 })],
      items: [
        item({
          type: "syllabus",
          title: "Syllabus",
          body: "Fall 2026 starts Oct 12. Write r.vance@northgate.example. See /old/5.",
          published: false,
          dueAt: on("2027-03-10"),
          links: [
            link({ text: "Rubric", url: "/old/5", points: "other-course", replacement: "/new/5" }),
            link({ text: "Reading", url: "/gone", points: "missing-page" }),
            link({ text: "notes.pdf", url: "/f/9", points: "missing-file" }),
            link({ text: "Quiz", url: "/t/1", points: "tool", tool: TOOL }),
          ],
        }),
        item({
          ref: "item:2" as LmsRef<"item">,
          type: "announcement",
          title: "Welcome",
          copied: true,
          dueAt: on("2027-06-01"),
        }),
      ],
    });
    const types = new Set(
      scanCourse(content, { ...CTX, issues: [issue(true)] }).map((finding) => finding.type),
    );
    expect([...types].sort()).toEqual((Object.keys(RULES) as FindingType[]).sort());
  });
});
