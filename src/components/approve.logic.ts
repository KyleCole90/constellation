import { riskOf, type ChangeRecord } from "~/domain/change";

export interface RiskPrompt {
  title: string;
  body: string;
  /** What the person must type, exactly. The course code, because it is short, known, and names the thing at stake. */
  code: string;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Null when the click needs no second step. Pure, so the dialog's words are tested without a DOM. */
export const riskPrompt = (record: ChangeRecord): RiskPrompt | null => {
  const { content } = record;
  const remote = record.basis.remote;
  if (riskOf(record) === null || content.kind !== "course-copy" || remote.kind !== "course-copy")
    return null;
  const has = [
    remote.students > 0 ? plural(remote.students, "student") : null,
    remote.items > 0 ? plural(remote.items, "item") : null,
  ]
    .filter((part) => part !== null)
    .join(" and ");
  return {
    title: `${content.into.code} already has ${has}`,
    body: `The copy adds ${content.into.code}'s new content on top of what is there now. Nothing in the course is removed, and students who are enrolled will see the new items. Type ${content.into.code} to confirm.`,
    code: content.into.code,
  };
};
