import type { ChangeId } from "~/shared/domain/ids";
import type { ChangeContent, ChangeSummary } from "~/shared/domain/change";

export type BatchPhase = "review" | "sending" | "outcome";

const settled = (summary: ChangeSummary): boolean =>
  summary.sentAt !== null || summary.tone === "attention";

/**
 * Derived, so a reload mid-batch lands in the right phase without anything stored.
 * A busy item counts as sending only until it settles: the send call goes on to sync its schools after every item has landed.
 */
export const batchPhase = (
  items: readonly { summary: ChangeSummary; busy: boolean }[],
): BatchPhase => {
  if (items.some(({ summary, busy }) => summary.tone === "working" || (busy && !settled(summary))))
    return "sending";
  return items.some(({ summary }) => settled(summary)) ? "outcome" : "review";
};

export const outcomeSummary = (summaries: readonly ChangeSummary[]): string => {
  const sent = summaries.filter((summary) => summary.sentAt !== null).length;
  const waiting = summaries.filter((summary) => summary.waitingOnReconnect).length;
  const attention = summaries.filter(
    (summary) => summary.tone === "attention" && !summary.waitingOnReconnect,
  ).length;
  const ready = summaries.filter((summary) => summary.tone === "ready").length;
  const parts = [
    sent > 0 && `${sent} sent`,
    attention > 0 && `${attention} needs attention`,
    waiting > 0 && `${waiting} waiting on reconnect`,
    ready > 0 && `${ready} ready to send`,
  ];
  return parts.filter(Boolean).join(", ");
};

/**
 * What Retry failed sends: anything left waiting once its school is back, and any hold where trying again can help.
 * An unconfirmed write could post twice and a refused one would be refused again, so each of those opens on its own.
 */
export const retryTargets = (
  items: readonly { id: ChangeId; summary: ChangeSummary }[],
): readonly ChangeId[] =>
  items
    .filter(
      ({ summary }) =>
        summary.canSend &&
        !summary.waitingOnReconnect &&
        summary.banner !== "forbidden" &&
        summary.banner !== "in-doubt" &&
        summary.banner !== "rejected",
    )
    .map(({ id }) => id);

/** "Lakeshore", from "Lakeshore Community College": a person says the short name. */
export const laneMessage = (schoolName: string, until: number, now: number): string => {
  const seconds = Math.max(Math.ceil((until - now) / 1000), 1);
  return `${schoolName.split(" ")[0] ?? schoolName} asked us to slow down, resuming in ${seconds}s`;
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The draft with this student's name blanked, so two drafts that differ only by name compare equal. Drafts address a student by first name. */
const draftKey = (student: string, content: ChangeContent): string | null => {
  if (content.kind !== "grade" || !content.comment?.trim()) return null;
  const names = [student, student.split(" ")[0] ?? student].map(escape);
  const name = new RegExp(`(?<![\\p{L}\\p{N}])(${names.join("|")})(?![\\p{L}\\p{N}])`, "gu");
  return JSON.stringify([
    content.outOf,
    content.points,
    content.override,
    content.rubric?.map((r) => [r.criterion, r.points]),
    content.comment.replace(name, "{name}"),
  ]);
};

/** Grade drafts that carry the same scores and the same feedback, one list per repeated draft. */
export const identicalDrafts = <T extends { student: string; content: ChangeContent }>(
  drafts: readonly T[],
): readonly (readonly T[])[] => {
  const groups = new Map<string, T[]>();
  for (const draft of drafts) {
    const key = draftKey(draft.student, draft.content);
    if (key !== null) groups.set(key, [...(groups.get(key) ?? []), draft]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
};

export const identicalNote = (students: readonly string[]): string =>
  `${students.slice(0, -1).join(", ")} and ${students.at(-1)} have identical drafts`;
