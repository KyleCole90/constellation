import type { ChangeRecord, ChangeSummary } from "~/shared/domain/change";
import type { ChangeId } from "~/shared/domain/ids";
import type { ThreadMessage } from "~/renderer/stores/types";

export type TimelineItem =
  | { type: "message"; key: string; message: Exclude<ThreadMessage, { type: "work" | "handoff" }> }
  | {
      type: "handoffs";
      key: string;
      messages: readonly Extract<ThreadMessage, { type: "handoff" }>[];
    }
  | { type: "work"; key: string; lines: readonly string[] }
  | { type: "change"; key: string; change: ChangeRecord }
  | { type: "earlier"; key: "earlier"; label: string; expanded: boolean };

export interface TimelineScope {
  focus: ChangeId | null;
  expanded: boolean;
}

/** Announcements share a target, so they count one by one. Two drafts for one student are still one student. */
const earlierLabel = (hidden: readonly ChangeRecord[]): string => {
  if (hidden.length === 0) return "Earlier";
  const posts = hidden.every((change) => change.content.kind === "announcement");
  const count = posts ? hidden.length : new Set(hidden.map((change) => change.content.target)).size;
  return `Earlier: ${count} ${posts ? "post" : "student"}${count === 1 ? "" : "s"}`;
};

export const visibleMessages = (
  messages: readonly ThreadMessage[],
  ai: boolean,
  hasDraft: boolean,
): readonly ThreadMessage[] =>
  ai
    ? hasDraft
      ? messages.filter((message) => !message.seeded)
      : messages
    : messages.filter((message) => message.type === "notice");

export const liveReplies = (
  message: ThreadMessage,
  messages: readonly ThreadMessage[],
): readonly string[] =>
  message.type === "agent" && message === messages.at(-1) ? (message.replies ?? []) : [];

const LEADS_TO_A_CHANGE: ReadonlySet<ThreadMessage["type"]> = new Set([
  "user",
  "work",
  "handed-off",
]);

/**
 * Chat and changes in the order they happened, for the change in focus. Messages that belong to the whole thread
 * always show. Everything filed under another change goes behind one row, placed where the first of it happened.
 */
export const buildTimeline = (
  messages: readonly ThreadMessage[],
  changes: readonly ChangeRecord[],
  scope: TimelineScope,
): readonly TimelineItem[] => {
  const leadUp = new Set<ThreadMessage>();
  messages.forEach((message, order) => {
    const before = messages[order - 1];
    if (
      LEADS_TO_A_CHANGE.has(message.type) &&
      (before?.at !== message.at || (before && leadUp.has(before)))
    )
      leadUp.add(message);
  });
  const dated = [
    ...changes.map((change, order) => ({
      at: change.activity[0]?.at ?? "",
      rank: 1,
      order,
      change,
      message: null,
    })),
    ...messages.map((message, order) => ({
      at: message.at,
      rank: leadUp.has(message) ? 0 : 2,
      order,
      change: null,
      message,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.rank - b.rank || a.order - b.order);

  const outside = (entry: (typeof dated)[number]): boolean =>
    entry.change
      ? entry.change.id !== scope.focus
      : entry.message?.change !== undefined && entry.message.change !== scope.focus;
  const label = earlierLabel(changes.filter((change) => change.id !== scope.focus));

  const items: TimelineItem[] = [];
  let placed = false;
  for (const entry of dated) {
    if (outside(entry)) {
      if (!placed) items.push({ type: "earlier", key: "earlier", label, expanded: scope.expanded });
      placed = true;
      if (!scope.expanded) continue;
    }
    if (entry.change) {
      items.push({ type: "change", key: entry.change.id, change: entry.change });
      continue;
    }
    const { message } = entry;
    if (!message) continue;
    if (message.type === "work") {
      const last = items.at(-1);
      if (last?.type === "work")
        items[items.length - 1] = { ...last, lines: [...last.lines, ...message.lines] };
      else items.push({ type: "work", key: `m${entry.order}`, lines: message.lines });
    } else if (message.type === "handoff") {
      const last = items.at(-1);
      if (last?.type === "handoffs")
        items[items.length - 1] = { ...last, messages: [...last.messages, message] };
      else items.push({ type: "handoffs", key: `m${entry.order}`, messages: [message] });
    } else {
      items.push({ type: "message", key: `m${entry.order}`, message });
    }
  }
  return items;
};

/** Agent text carries **bold** and nothing else. Odd pieces are the bold ones. */
export const boldRuns = (text: string): readonly { text: string; bold: boolean }[] =>
  text
    .split("**")
    .map((piece, index) => ({ text: piece, bold: index % 2 === 1 }))
    .filter((run) => run.text.length > 0);

export type WalkStep =
  | "open-next"
  | "review"
  | "focus-approve"
  | "approve-and-send"
  | "send"
  | "none";

/**
 * Where ⌘↵ goes. On anything an agent touched it walks up to approval and stops on the button: the chord never
 * approves it, and only pressing the button does. A grade only you have edited needs none of that, so one chord approves and sends it, unless `sendsOnChord` stops a zero or an empty comment.
 * A change with a banner needs a decision, so the chord leaves it alone rather than guessing a recovery.
 */
export const walkStep = (input: {
  busy: boolean;
  summary: ChangeSummary | null;
  panel: "source" | "writeback" | "batch" | null;
  chordSends: boolean;
}): WalkStep => {
  const { busy, summary, panel, chordSends } = input;
  // Sent comes first. The sync that follows a send keeps busy set, and it shouldn't hold up moving on.
  if (summary?.sentAt) return "open-next";
  if (busy || summary?.tone === "working") return "none";
  if (!summary) return "open-next";
  // The source and batch panels can cover the card, and the chord sends only what is on screen.
  if (chordSends && summary.canApprove && (panel === null || panel === "writeback"))
    return "approve-and-send";
  if (panel !== "writeback") return "review";
  if (summary.canApprove) return "focus-approve";
  return summary.canSend && summary.banner === null ? "send" : "none";
};
