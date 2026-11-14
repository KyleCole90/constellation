import { VAULT_PLACE } from "~/renderer/desktop";
import type { ChangeRecord, LmsError } from "~/shared/domain/change";
import type { IsoTime, SchoolId } from "~/shared/domain/ids";
import { summarizeFor } from "~/renderer/stores/selectors";
import type { ConnectionRecord } from "~/renderer/stores/types";

import type { BadgeTone, StatusIcon } from "../ui/badge";

export type ConnectionStatus =
  | "connected"
  | "expired"
  | "disconnected"
  | "syncing"
  | "sync-failed"
  | "offline";
export type ConnectionAction =
  | "connect"
  | "reconnect"
  | "sync"
  | "replace"
  | "disconnect"
  | "remove";

const SCOPE_VERBS: readonly (readonly [verb: string, words: RegExp])[] = [
  ["read", /^Read your/],
  ["grade", /grades/],
  ["message", /messages/],
  ["announce", /^Post announcements/],
  ["copy", /^Copy/],
  ["publish", /^Publish/],
];

/** Built from what the token really holds, so a school without a permission never claims it. */
export const scopeSummary = (scopes: readonly string[]): string => {
  const verbs = SCOPE_VERBS.filter(([, words]) => scopes.some((scope) => words.test(scope)))
    .map(([verb]) => verb)
    .join(", ");
  return verbs.charAt(0).toUpperCase() + verbs.slice(1);
};

/** The one reading of a connection. Settings and the sidebar both go through it, so they can't disagree. */
export const connectionStatus = (
  record: ConnectionRecord | undefined,
  syncing: boolean,
  online = true,
): ConnectionStatus => {
  if (!record || record.status === "disconnected") return "disconnected";
  if (record.status === "expired") return "expired";
  // The app opens from saved state, so the school's data is still there; only reaching it waits (D28).
  if (!online) return "offline";
  if (syncing) return "syncing";
  return record.syncError ? "sync-failed" : "connected";
};

interface StatusView {
  label: string;
  badge: BadgeTone;
  icon?: StatusIcon;
  needsAttention: boolean;
  needsToken: boolean;
  actions: readonly ConnectionAction[];
}

export const STATUS_VIEW: Readonly<Record<ConnectionStatus, StatusView>> = {
  connected: {
    label: "Connected",
    badge: "success",
    icon: "connected",
    needsAttention: false,
    needsToken: false,
    actions: ["sync", "replace", "disconnect"],
  },
  expired: {
    label: "Token expired",
    badge: "danger",
    icon: "disconnected",
    needsAttention: true,
    needsToken: true,
    actions: ["reconnect", "disconnect"],
  },
  disconnected: {
    label: "Not connected",
    badge: "danger",
    icon: "disconnected",
    needsAttention: false,
    needsToken: true,
    actions: ["remove", "connect"],
  },
  syncing: {
    label: "Syncing",
    badge: "info",
    needsAttention: false,
    needsToken: false,
    actions: ["sync", "replace", "disconnect"],
  },
  // Disconnecting is local. Syncing and a new token both need the school.
  offline: {
    label: "Offline",
    badge: "warning",
    icon: "disconnected",
    needsAttention: false,
    needsToken: false,
    actions: ["disconnect"],
  },
  "sync-failed": {
    label: "Sync failed",
    badge: "danger",
    icon: "error",
    needsAttention: true,
    needsToken: false,
    actions: ["sync", "replace", "disconnect"],
  },
};

export const ACTION_LABEL: Readonly<Record<ConnectionAction, string>> = {
  connect: "Connect",
  reconnect: "Reconnect",
  sync: "Sync now",
  replace: "Replace token",
  disconnect: "Disconnect",
  remove: "Remove school",
};

/** A school with drafts is never removed, so no draft points at a school that is gone. */
export const cardActions = (
  status: ConnectionStatus,
  hasDrafts: boolean,
): readonly ConnectionAction[] =>
  STATUS_VIEW[status].actions.filter((action) => action !== "remove" || !hasDrafts);

export const waitingCount = (
  changes: readonly ChangeRecord[],
  school: SchoolId,
  status: ConnectionRecord["status"],
): number =>
  changes.filter(
    (change) => change.school === school && summarizeFor(change, status).waitingOnReconnect,
  ).length;

export const waitingWords = (count: number): string => {
  if (count === 0) return "No changes are waiting on this school.";
  return count === 1
    ? "1 change is waiting. Reconnecting does not send it by itself."
    : `${count} changes are waiting. Reconnecting does not send them by itself.`;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;

export const ageWords = (now: number, at: IsoTime): string => {
  const age = now - new Date(at).getTime();
  if (age < MINUTE) return "just now";
  if (age < HOUR) return plural(Math.floor(age / MINUTE), "minute");
  if (age < DAY) return plural(Math.floor(age / HOUR), "hour");
  return plural(Math.floor(age / DAY), "day");
};

export const savedWords = (at: IsoTime): string =>
  `Token saved ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

export const syncWords = (now: number, at: IsoTime | null): string =>
  at === null ? "Not synced yet" : `Synced ${ageWords(now, at)}`;

export const syncFailureWords = (
  error: LmsError["kind"] | null,
  now: number,
  at: IsoTime | null,
): string => {
  const why =
    error === "rate_limited"
      ? "The school asked for fewer requests."
      : "The school couldn't be reached.";
  return at === null
    ? `${why} Nothing has been read yet.`
    : `${why} What you see is from ${ageWords(now, at)}.`;
};

export const courseWords = (count: number): string =>
  count === 1 ? "1 course found" : `${count} courses found`;

export const readingWords = (count: number): string =>
  count === 1 ? "Reading your course" : `Reading your ${count} courses`;

/** What a sync is on: the course list, each course's details, then the new shells to set up. */
export const syncProgressWords = (
  progress: { courses: readonly unknown[]; read: readonly unknown[] } | undefined,
): string =>
  !progress
    ? "Listing your courses"
    : progress.read.length < progress.courses.length
      ? `Read ${progress.read.length} of ${progress.courses.length} courses`
      : "Checking for new courses";

export const STAGE_WORDS = {
  saving: `Saving to ${VAULT_PLACE}`,
  checking: "Checking your token",
  reading: "Reading your courses",
} as const;
