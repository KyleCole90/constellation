import { hash53 } from "./approval";
import type {
  ContentItem,
  ContentLink,
  CourseContent,
  MigrationIssue,
  SetContent,
  SetIntent,
  TextFixContent,
} from "./content";
import type { Brand, LmsRef } from "./ids";
import { paragraphBounds, spliceAt } from "./splice";
import {
  breakHolding,
  dateOfTime,
  findDateMentions,
  meetingDayInside,
  mentionIsStale,
  moveOutOfBreak,
  rewriteMention,
  shiftDate,
  shiftOptionsOf,
  timeOnDate,
  type DateMention,
  type TermPlan,
} from "./term";

export type FindingType =
  | "plain-date"
  | "date-in-break"
  | "date-outside-term"
  | "old-term-name"
  | "old-course-link"
  | "broken-link"
  | "missing-file"
  | "lti-link"
  | "copied-announcement"
  | "foreign-contact"
  | "missing-statement"
  | "unpublished-item"
  | "empty-module"
  | "migration-issue";
export type FindingKey = Brand<string, "FindingKey">;

export interface Finding {
  /** Hash of type, item, and the passage's words and place among its twins. Stable across scans. */
  key: FindingKey;
  type: FindingType;
  item: LmsRef<"item"> | LmsRef<"module"> | null;
  where: string;
  quote: string;
  why: string;
  openUrl: string | null;
  /** The change's real content. Null means a person does this in the LMS. */
  fix: TextFixContent | SetContent | null;
}

export interface ScanContext {
  plan: TermPlan;
  issues: readonly MigrationIssue[];
  /** Text fixes this setup already sent. A year-less date in both terms can only be told apart by this. */
  written: readonly TextFixContent[];
  /** Replaces a foreign address. Null makes that finding manual. */
  contactEmail: string | null;
}

export type ScanRule = (content: CourseContent, ctx: ScanContext) => readonly Finding[];

const EMAIL = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g;

const keyOf = (type: FindingType, item: string | null, ...parts: readonly string[]): FindingKey =>
  hash53(JSON.stringify([type, item, ...parts])) as FindingKey;

const hasText = (item: ContentItem): boolean => item.type !== "file";
const textItems = (content: CourseContent): readonly ContentItem[] => content.items.filter(hasText);

const textFix = (
  item: ContentItem,
  index: number,
  length: number,
  after: string,
): TextFixContent => ({
  kind: "text-fix",
  target: item.ref,
  where: item.title,
  splice: spliceAt(item.body, index, length, after),
});
const setFix = (item: ContentItem, intent: SetIntent): SetContent => ({
  kind: "item-set",
  target: item.ref,
  where: item.title,
  intent,
});

const about = (
  item: ContentItem,
  rest: Pick<Finding, "key" | "type" | "quote" | "why" | "fix">,
): Finding => ({ item: item.ref, where: item.title, openUrl: item.openUrl, ...rest });

const indexesOf = (body: string, text: string): readonly number[] => {
  const found: number[] = [];
  if (text === "") return found;
  for (let at = body.indexOf(text); at !== -1; at = body.indexOf(text, at + text.length))
    found.push(at);
  return found;
};

/** Only a fix to these same words can change this key, so a landing beside the passage leaves it alone. */
const passageKey = (
  type: FindingType,
  item: ContentItem,
  index: number,
  length: number,
): FindingKey => {
  const text = item.body.slice(index, index + length);
  return keyOf(type, item.ref, text, String(indexesOf(item.body.slice(0, index), text).length));
};

/** One side of the context can change when a fix lands beside this one, so either side is enough. */
const wasWritten = (ctx: ScanContext, item: ContentItem, mention: DateMention): boolean =>
  ctx.written.some(({ target, splice: { prefix, after, suffix } }) => {
    if (target !== item.ref) return false;
    const starts = [
      ...indexesOf(item.body, prefix + after).map((at) => at + prefix.length),
      ...indexesOf(item.body, after + suffix),
    ];
    return starts.some(
      (start) => mention.index >= start && mention.index + mention.length <= start + after.length,
    );
  });

const plainDate: ScanRule = (content, ctx) => {
  const options = shiftOptionsOf(ctx.plan);
  return textItems(content).flatMap((item) =>
    findDateMentions(item.body, ctx.plan.oldTerm)
      .filter((mention) => mentionIsStale(mention, ctx.plan) && !wasWritten(ctx, item, mention))
      .flatMap((mention) => {
        const { date, movedFrom } = moveOutOfBreak(shiftDate(mention.date, options), ctx.plan);
        const after = rewriteMention(mention, date);
        if (after === mention.text) return [];
        const key = passageKey("plain-date", item, mention.index, mention.length);
        if (mention.range)
          return [
            about(item, {
              key,
              type: "plain-date",
              quote: mention.text,
              why: `"${mention.text}" starts a date range from the old term, so a person has to rewrite it.`,
              fix: null,
            }),
          ];
        const why = `"${mention.text}" is a date from ${ctx.plan.oldTerm.name}.${movedFrom ? ` Moved out of ${movedFrom.name}.` : ""}`;
        return [
          about(item, {
            key,
            type: "plain-date",
            quote: mention.text,
            why,
            fix: textFix(item, mention.index, mention.length, after),
          }),
        ];
      }),
  );
};

const dateInBreak: ScanRule = (content, { plan }) =>
  content.items.flatMap((item) => {
    if (item.dueAt === null) return [];
    const day = dateOfTime(item.dueAt);
    const held = breakHolding(day, plan);
    if (!held) return [];
    const { date, movedFrom } = moveOutOfBreak(day, plan);
    const fix = movedFrom
      ? setFix(item, { set: "due-at", at: timeOnDate(item.dueAt, date) })
      : null;
    return [
      about(item, {
        key: keyOf("date-in-break", item.ref),
        type: "date-in-break",
        quote: day,
        why: movedFrom
          ? `Due during ${held.name}. Moved out of ${held.name}.`
          : `Due during ${held.name}, and the term has no other class day.`,
        fix,
      }),
    ];
  });

const dateOutsideTerm: ScanRule = (content, { plan }) =>
  content.items.flatMap((item) => {
    if (item.dueAt === null) return [];
    const day = dateOfTime(item.dueAt);
    if ((day >= plan.newTerm.start && day <= plan.newTerm.end) || breakHolding(day, plan))
      return [];
    const inside = meetingDayInside(day, plan);
    const fix = inside ? setFix(item, { set: "due-at", at: timeOnDate(item.dueAt, inside) }) : null;
    return [
      about(item, {
        key: keyOf("date-outside-term", item.ref),
        type: "date-outside-term",
        quote: day,
        why: `Due outside ${plan.newTerm.name}.`,
        fix,
      }),
    ];
  });

const isWholeWords = (body: string, index: number, length: number): boolean =>
  !/\w/.test(body.charAt(index - 1)) && !/\w/.test(body.charAt(index + length));

const oldTermName: ScanRule = (content, { plan: { oldTerm, newTerm } }) => {
  if (oldTerm.name === newTerm.name) return [];
  const type = "old-term-name";
  const why = `Still says ${oldTerm.name}.`;
  const inNewName = newTerm.name.indexOf(oldTerm.name);
  const isNewName = (body: string, index: number): boolean =>
    inNewName !== -1 && index >= inNewName && body.startsWith(newTerm.name, index - inNewName);
  return textItems(content).flatMap((item) => [
    ...indexesOf(item.body, oldTerm.name)
      .filter(
        (index) =>
          isWholeWords(item.body, index, oldTerm.name.length) && !isNewName(item.body, index),
      )
      .map((index) =>
        about(item, {
          key: passageKey(type, item, index, oldTerm.name.length),
          type,
          quote: oldTerm.name,
          why,
          fix: textFix(item, index, oldTerm.name.length, newTerm.name),
        }),
      ),
    ...(item.title.includes(oldTerm.name)
      ? [
          about(item, {
            key: keyOf(type, item.ref, "title", item.title),
            type,
            quote: item.title,
            why: `The title still says ${oldTerm.name}.`,
            fix: null,
          }),
        ]
      : []),
  ]);
};

/** One row per link target in an item. Pointing at the same dead target twice is one thing to fix. */
const linksOf = (
  item: ContentItem,
  wanted: (link: ContentLink) => boolean,
): readonly ContentLink[] => [
  ...new Map(item.links.filter(wanted).map((link) => [link.url, link])).values(),
];

const manualLinks =
  (
    type: FindingType,
    wanted: (link: ContentLink) => boolean,
    why: (link: ContentLink) => string,
  ): ScanRule =>
  (content) =>
    content.items.flatMap((item) =>
      linksOf(item, wanted).map((link) =>
        about(item, {
          key: keyOf(type, item.ref, link.url),
          type,
          quote: link.text,
          why: why(link),
          fix: null,
        }),
      ),
    );

const oldCourseLink: ScanRule = (content) => {
  const type = "old-course-link";
  const why = "Points at the old course.";
  return content.items.flatMap((item) =>
    linksOf(item, (link) => link.points === "other-course").flatMap((link) => {
      const replacement = link.points === "other-course" ? link.replacement : null;
      const places = replacement === null ? [] : indexesOf(item.body, link.url);
      if (places.length === 0 || replacement === null)
        return [
          about(item, {
            key: keyOf(type, item.ref, link.url),
            type,
            quote: link.text,
            why,
            fix: null,
          }),
        ];
      return places.map((index) =>
        about(item, {
          key: passageKey(type, item, index, link.url.length),
          type,
          quote: link.text,
          why,
          fix: textFix(item, index, link.url.length, replacement),
        }),
      );
    }),
  );
};

const ltiLink: ScanRule = (content, ctx) => {
  const ready = new Set(content.tools.filter((tool) => tool.configured).map((tool) => tool.ref));
  const needsLink = (link: ContentLink) => link.points === "tool" && !ready.has(link.tool);
  return manualLinks(
    "lti-link",
    needsLink,
    (link) => `The tool behind "${link.text}" has to be linked again in this course.`,
  )(content, ctx);
};

const copiedAnnouncement: ScanRule = (content) =>
  content.items
    .filter((item) => item.type === "announcement" && item.copied)
    .map((item) =>
      about(item, {
        key: keyOf("copied-announcement", item.ref),
        type: "copied-announcement",
        quote: item.title,
        why: "Came over from the old course, and students would see it as new.",
        fix: setFix(item, { set: "item-deleted" }),
      }),
    );

const isLocalDomain = (domain: string, home: string): boolean => {
  const lower = domain.toLowerCase();
  const local = home.toLowerCase();
  return lower === local || lower.endsWith(`.${local}`);
};

const foreignContact: ScanRule = (content, ctx) => {
  const type = "foreign-contact";
  const home = content.policy.contactDomain;
  return textItems(content).flatMap((item) => {
    const foreign = [...item.body.matchAll(EMAIL)].filter(
      (match) => !isLocalDomain(match[1] ?? "", home),
    );
    const officeHours = new Map<number, Finding>();
    const emails = foreign.flatMap((match) => {
      const index = match.index;
      const address = match[0];
      const { start, end } = paragraphBounds(item.body, index, index + address.length);
      const paragraph = item.body.slice(start, end);
      if (/office hours/i.test(paragraph)) {
        officeHours.set(
          start,
          about(item, {
            key: passageKey(type, item, start, paragraph.length),
            type,
            quote: paragraph,
            why: "Office hours from another school.",
            fix: null,
          }),
        );
        return [];
      }
      const fix =
        ctx.contactEmail === null ? null : textFix(item, index, address.length, ctx.contactEmail);
      return [
        about(item, {
          key: passageKey(type, item, index, address.length),
          type,
          quote: address,
          why: `An address outside ${home}.`,
          fix,
        }),
      ];
    });
    return [...officeHours.values(), ...emails];
  });
};

const missingStatement: ScanRule = (content) => {
  const syllabus = content.items.find((item) => item.type === "syllabus") ?? null;
  const body = syllabus?.body.toLowerCase() ?? "";
  return content.policy.statements
    .filter(
      (statement) => !statement.mustInclude.every((phrase) => body.includes(phrase.toLowerCase())),
    )
    .map((statement) => {
      const shared = {
        key: keyOf("missing-statement", syllabus?.ref ?? null, statement.name),
        type: "missing-statement",
        quote: statement.name,
        why: `The school requires the ${statement.name} in the syllabus.`,
      } as const;
      if (!syllabus) return { ...shared, item: null, where: "Syllabus", openUrl: null, fix: null };
      const after = syllabus.body === "" ? statement.text : `\n\n${statement.text}`;
      return about(syllabus, { ...shared, fix: textFix(syllabus, syllabus.body.length, 0, after) });
    });
};

const unpublishedItem: ScanRule = (content) => [
  ...content.items
    .filter((item) => !item.published)
    .map((item) =>
      about(item, {
        key: keyOf("unpublished-item", item.ref),
        type: "unpublished-item",
        quote: item.title,
        why: "Students cannot see this yet.",
        fix: setFix(item, { set: "item-published" }),
      }),
    ),
  ...content.modules
    .filter((module) => !module.published)
    .map((module): Finding => ({
      key: keyOf("unpublished-item", module.ref),
      type: "unpublished-item",
      item: module.ref,
      where: module.title,
      quote: module.title,
      why: "Students cannot see this module yet.",
      openUrl: module.openUrl,
      fix: null,
    })),
];

const emptyModule: ScanRule = (content) =>
  content.modules
    .filter((module) => module.itemCount === 0)
    .map((module): Finding => ({
      key: keyOf("empty-module", module.ref),
      type: "empty-module",
      item: module.ref,
      where: module.title,
      quote: module.title,
      why: "This module has nothing in it.",
      openUrl: module.openUrl,
      fix: null,
    }));

const migrationIssue: ScanRule = (_, ctx) =>
  [
    ...new Map(
      ctx.issues
        .filter((issue) => issue.open)
        .map((issue) => [`${issue.severity}:${issue.text}`, issue]),
    ).values(),
  ].map((issue): Finding => ({
    key: keyOf("migration-issue", null, issue.severity, issue.text),
    type: "migration-issue",
    item: null,
    where: "Copy report",
    quote: issue.text,
    why: `The copy reported this as ${issue.severity === "error" ? "an error" : `a ${issue.severity}`}.`,
    openUrl: issue.fixUrl,
    fix: null,
  }));

export const RULES: Readonly<Record<FindingType, ScanRule>> = {
  "plain-date": plainDate,
  "date-in-break": dateInBreak,
  "date-outside-term": dateOutsideTerm,
  "old-term-name": oldTermName,
  "old-course-link": oldCourseLink,
  "broken-link": manualLinks(
    "broken-link",
    (link) => link.points === "missing-page",
    (link) => `"${link.text}" points at a page that is not in this course.`,
  ),
  "missing-file": manualLinks(
    "missing-file",
    (link) => link.points === "missing-file",
    (link) => `"${link.text}" points at a file that is not in this course.`,
  ),
  "lti-link": ltiLink,
  "copied-announcement": copiedAnnouncement,
  "foreign-contact": foreignContact,
  "missing-statement": missingStatement,
  "unpublished-item": unpublishedItem,
  "empty-module": emptyModule,
  "migration-issue": migrationIssue,
};

export const FINDING_TYPES = Object.keys(RULES) as readonly FindingType[];
export const isFindingType = (value: unknown): value is FindingType =>
  typeof value === "string" && Object.hasOwn(RULES, value);

export const scanCourse = (content: CourseContent, ctx: ScanContext): readonly Finding[] =>
  Object.values(RULES).flatMap((rule) => rule(content, ctx));
