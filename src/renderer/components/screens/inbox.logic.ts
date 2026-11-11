import type { LmsRef, SchoolId } from "~/shared/domain/ids";
import type { School } from "~/shared/domain/lms";
import type { Capabilities } from "~/shared/providers/provider";
import type { InboxRow } from "~/renderer/stores/selectors";

import type { SchoolFilter } from "./due.logic";

export type InboxStatus = "all" | "needs-reply" | "waiting";

export const INBOX_STATUSES: readonly { status: InboxStatus; label: string }[] = [
  { status: "all", label: "All" },
  { status: "needs-reply", label: "Needs reply" },
  { status: "waiting", label: "Waiting on approval" },
];

/** A reply already in progress isn't waiting on anyone to start it. */
const holds = (row: InboxRow, status: InboxStatus): boolean => {
  switch (status) {
    case "all":
      return true;
    case "needs-reply":
      return row.last?.mine === false && (row.summary === null || row.summary.sentAt !== null);
    case "waiting":
      return row.summary?.canApprove === true;
  }
};

export const filterInbox = (
  rows: readonly InboxRow[],
  status: InboxStatus,
  school: SchoolFilter,
): readonly InboxRow[] =>
  rows.filter((row) => holds(row, status) && (school === "all" || row.school.id === school));

export const statusCount = (rows: readonly InboxRow[], status: InboxStatus): number =>
  rows.filter((row) => holds(row, status)).length;

/** One plain line for each connected school whose LMS has no messages to show. An unconnected school has nothing to say yet. */
export const messagingNotes = (
  schools: readonly School[],
  capabilitiesFor: (school: SchoolId) => Pick<Capabilities, "messaging"> | null,
): readonly string[] =>
  schools.flatMap((school) =>
    capabilitiesFor(school.id)?.messaging === false
      ? [
          `${school.name} doesn't offer messaging through its LMS, so its conversations can't show here.`,
        ]
      : [],
  );

export const preview = (row: InboxRow): string => {
  const text = row.last?.text ?? "";
  return row.last?.mine ? `You: ${text}` : text;
};

export interface InboxSearch {
  conversation?: LmsRef<"conversation">;
}

export const parseInboxSearch = (search: Record<string, unknown>): InboxSearch =>
  typeof search.conversation === "string" && search.conversation
    ? // The inbox's rows decide whether the conversation is there.
      { conversation: search.conversation as LmsRef<"conversation"> }
    : {};

/**
 * What Messages does when its URL settles. `arrived` is true until the URL moves after the screen mounts.
 * A link that names nothing keeps what was open and writes it in, so Back can return to it; a URL that moved since (Back, Forward) opens what it names.
 */
export const followInboxUrl = <K extends string>(
  arrived: boolean,
  url: K | undefined,
  open: K | null,
): { write: K } | { open: K | null } | null => {
  if (url === (open ?? undefined)) return null;
  if (arrived && url === undefined && open !== null) return { write: open };
  return { open: url ?? null };
};
