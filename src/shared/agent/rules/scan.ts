import type { ContentItem } from "~/shared/domain/content";
import type { Finding } from "~/shared/domain/scan";

import type { AgentScope } from "../agent";

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const lastParagraph = (body: string): string =>
  body
    .split("\n\n")
    .filter((part) => part.trim() !== "")
    .at(-1)
    ?.trim() ?? "";

const workLines = (
  items: readonly ContentItem[],
  modules: number,
  plan: AgentScope["scan"] extends (infer S) | undefined
    ? S extends { plan: infer P }
      ? P
      : never
    : never,
): readonly string[] => {
  const of = (type: ContentItem["type"]) => items.filter((item) => item.type === type).length;
  const dated = items.filter((item) => item.dueAt !== null).length;
  const links = items.reduce((sum, item) => sum + item.links.length, 0);
  return [
    ...(of("syllabus") > 0 ? ["Read the syllabus"] : []),
    ...(of("page") > 0 ? [`Read ${count(of("page"), "page")}`] : []),
    ...(of("announcement") > 0 ? [`Read ${count(of("announcement"), "announcement")}`] : []),
    ...(dated > 0 ? [`Checked ${count(dated, "due date")} against ${plan.newTerm.name}`] : []),
    ...(links > 0 ? [`Followed ${count(links, "link")}`] : []),
    ...(modules > 0 ? [`Looked in ${count(modules, "module")}`] : []),
  ];
};

/** Wording per finding where the rule's words are too terse for a person who has not seen the rule. */
const wordsFor = (
  finding: Finding,
  item: ContentItem,
  home: string,
): { quote: string; why: string; after: string | null } | null => {
  const after = finding.fix?.kind === "text-fix" ? finding.fix.splice.after : null;
  switch (finding.type) {
    case "foreign-contact":
      if (finding.fix)
        return {
          quote: finding.quote,
          why: `${finding.quote} is an address at another school, so a student writing there would reach the wrong inbox. I would put your ${home} address here instead.`,
          after,
        };
      return {
        quote: finding.quote,
        why: "These office hours come from a course at another school. The day, room, and address all need rewriting for this one.",
        after: null,
      };
    case "missing-statement": {
      const quote = lastParagraph(item.body);
      if (quote === "" || after === null) return null;
      return {
        quote,
        why: `This school requires the ${finding.quote} in every syllabus, and this one does not have it. I drafted the standard text to go after the last paragraph.`,
        after,
      };
    }
    case "plain-date":
    case "date-in-break":
    case "date-outside-term":
    case "old-term-name":
    case "old-course-link":
    case "broken-link":
    case "missing-file":
    case "lti-link":
    case "copied-announcement":
    case "unpublished-item":
    case "empty-module":
    case "migration-issue":
      return item.body.includes(finding.quote)
        ? { quote: finding.quote, why: finding.why, after }
        : null;
  }
};

export function* scanCourseStream(scope: AgentScope): Generator<unknown, void> {
  const { scan } = scope;
  if (!scan) {
    yield {
      type: "say",
      text: "Open a course that is being set up for the new term, and I'll look it over.",
    };
    return;
  }
  const { content, findings, plan } = scan;
  for (const line of workLines(content.items, content.modules.length, plan))
    yield { type: "work", line };
  for (const finding of findings) {
    const item = content.items.find((entry) => entry.ref === finding.item);
    if (!item) continue;
    const words = wordsFor(finding, item, content.policy.contactDomain);
    if (!words) continue;
    yield { type: "finding", findingType: finding.type, item: item.ref, ...words };
  }
  const fixable = findings.filter((finding) => finding.fix !== null).length;
  const manual = findings.length - fixable;
  if (findings.length === 0) {
    yield {
      type: "say",
      text: `I looked over ${content.shell.code} and found nothing that needs changing for ${plan.newTerm.name}.`,
    };
    return;
  }
  yield {
    type: "say",
    text: `I found ${count(findings.length, "thing")} to look at in ${content.shell.code}. ${fixable} ${fixable === 1 ? "fix" : "fixes"} drafted for your approval, and ${manual} for you to do in the LMS yourself.`,
  };
}
