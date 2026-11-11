import { describe, expect, it } from "vite-plus/test";

import type { IsoTime, SchoolId } from "~/shared/domain/ids";
import type { ConnectionRecord } from "~/renderer/stores/types";

import {
  STATUS_VIEW,
  ageWords,
  cardActions,
  connectionStatus,
  savedWords,
  scopeSummary,
  syncFailureWords,
  syncWords,
  waitingWords,
} from "./connection.logic";

const record = (patch: Partial<ConnectionRecord>): ConnectionRecord => ({
  school: "lcc" as SchoolId,
  status: "connected",
  connectedAt: null,
  accountName: null,
  scopes: [],
  lastSyncedAt: null,
  syncError: null,
  ...patch,
});
const ago = (ms: number) => new Date(1_000_000_000 - ms).toISOString() as IsoTime;

describe("scopeSummary", () => {
  it("names only the permissions the token holds", () => {
    expect(
      scopeSummary([
        "Read your courses, rosters, and submissions",
        "Post grades and comments",
        "Reply to messages",
        "Post announcements",
        "Copy content into a course",
        "Check on a copy",
        "Publish a course and edit its syllabus",
      ]),
    ).toBe("Read, grade, message, announce, copy, publish");
    expect(
      scopeSummary(["Read your courses, rosters, and submissions", "Post announcements"]),
    ).toBe("Read, announce");
  });
});

describe("connectionStatus", () => {
  it("has no record, or a disconnected one, as not connected even mid-sync", () => {
    expect(connectionStatus(undefined, false)).toBe("disconnected");
    expect(connectionStatus(record({ status: "disconnected" }), true)).toBe("disconnected");
  });

  it("lets an expired token outrank a sync error and a running sync", () => {
    expect(connectionStatus(record({ status: "expired", syncError: "auth_expired" }), true)).toBe(
      "expired",
    );
  });

  it("lets a running sync outrank the last sync's failure, then reports the failure", () => {
    expect(connectionStatus(record({ syncError: "unavailable" }), true)).toBe("syncing");
    expect(connectionStatus(record({ syncError: "unavailable" }), false)).toBe("sync-failed");
  });

  it("is connected when nothing is wrong", () => {
    expect(connectionStatus(record({}), false)).toBe("connected");
  });
});

describe("what each status offers", () => {
  it("an expired school offers Reconnect and no sync, since a sync can't work", () => {
    expect(STATUS_VIEW.expired.actions).toEqual(["reconnect", "disconnect"]);
  });

  it("a school with no token offers Remove school and Connect", () => {
    expect(cardActions("disconnected", false)).toEqual(["remove", "connect"]);
  });

  it("a school with no token keeps its drafts by not offering Remove school", () => {
    expect(cardActions("disconnected", true)).toEqual(["connect"]);
  });

  it("only an expired or failing school asks for attention", () => {
    expect(
      Object.entries(STATUS_VIEW)
        .filter(([, view]) => view.needsAttention)
        .map(([status]) => status)
        .sort(),
    ).toEqual(["expired", "sync-failed"]);
  });

  it("only an expired or absent token gets a sidebar Connect row", () => {
    expect(
      Object.entries(STATUS_VIEW)
        .filter(([, view]) => view.needsToken)
        .map(([status]) => status)
        .sort(),
    ).toEqual(["disconnected", "expired"]);
  });
});

describe("words", () => {
  it("counts waiting changes and says reconnecting does not send them", () => {
    expect(waitingWords(0)).toBe("No changes are waiting on this school.");
    expect(waitingWords(1)).toBe("1 change is waiting. Reconnecting does not send it by itself.");
    expect(waitingWords(3)).toBe(
      "3 changes are waiting. Reconnecting does not send them by itself.",
    );
  });

  it("gives an age in the largest whole unit", () => {
    expect(ageWords(1_000_000_000, ago(5_000))).toBe("just now");
    expect(ageWords(1_000_000_000, ago(60_000))).toBe("1 minute ago");
    expect(ageWords(1_000_000_000, ago(5 * 3_600_000))).toBe("5 hours ago");
    expect(ageWords(1_000_000_000, ago(2 * 86_400_000))).toBe("2 days ago");
  });

  it("describes a saved token by its date alone", () => {
    expect(savedWords("2026-10-30T12:00:00.000Z" as IsoTime)).toBe("Token saved Oct 30");
  });

  it("says when a school has never synced", () => {
    expect(syncWords(0, null)).toBe("Not synced yet");
  });

  it("gives a failed sync's reason and how old the data is", () => {
    expect(syncFailureWords("unavailable", 1_000_000_000, ago(120_000))).toBe(
      "The school couldn't be reached. What you see is from 2 minutes ago.",
    );
    expect(syncFailureWords("rate_limited", 0, null)).toBe(
      "The school asked for fewer requests. Nothing has been read yet.",
    );
  });
});
