import { describe, expect, it } from "vite-plus/test";

import type { ChangeRecord } from "~/shared/domain/change";
import type { CopySource, CourseShell, Migration, SetContent } from "~/shared/domain/content";
import type { ChangeId, IsoDate, IsoTime, LmsRef, SchoolId, ThreadId } from "~/shared/domain/ids";
import type { Finding, FindingKey, FindingType } from "~/shared/domain/scan";
import {
  STEPS,
  canDropFix,
  copyMigration,
  isOpenRow,
  readinessOf,
  reconcile,
  reviewRows,
  stageOf,
  stepOf,
  type ChangeMap,
  type CourseSetup,
  type SetupLive,
  type SetupStage,
} from "~/shared/domain/setup";
import { draftOf, termName, type TermPlan } from "~/shared/domain/term";

import {
  AT,
  approved,
  conflicted,
  discarded,
  held,
  newDraft,
  sending,
  sent,
  step,
} from "./fixtures/changes";

const d = (text: string): IsoDate => text as IsoDate;
const id = (text: string): ChangeId => text as ChangeId;
const k = (text: string): FindingKey => text as FindingKey;
const PLAN: TermPlan = {
  oldTerm: {
    name: termName("Fall 2026"),
    start: d("2026-08-24"),
    end: d("2026-12-11"),
    days: [2, 4],
  },
  newTerm: {
    name: termName("Spring 2027"),
    start: d("2027-01-19"),
    end: d("2027-05-07"),
    days: [1, 3],
  },
  breaks: [],
};
const SOURCE: CopySource = {
  kind: "course",
  ref: "course:9" as LmsRef<"course">,
  label: "ENG 101",
  termName: "Fall 2026",
};
const FIX: SetContent = {
  kind: "item-set",
  target: "item:1" as LmsRef<"item">,
  where: "Week one",
  intent: { set: "item-published" },
};

const setup = (patch: Partial<CourseSetup> = {}): CourseSetup => ({
  course: "course:1" as LmsRef<"course">,
  school: "lcc" as SchoolId,
  thread: "thread:1" as ThreadId,
  shell: {} as CourseShell,
  source: SOURCE,
  plan: PLAN,
  copy: id("copy"),
  publish: null,
  scan: null,
  check: null,
  resolved: {},
  fixes: {},
  ...patch,
});
const finding = (
  key: string,
  fix: Finding["fix"] = FIX,
  type: FindingType = "unpublished-item",
): Finding => ({
  key: k(key),
  type,
  item: null,
  where: "Week one",
  quote: "Week one",
  why: "Because.",
  openUrl: null,
  fix,
});
const scanned = (findings: readonly Finding[]): CourseSetup["scan"] => ({
  copy: id("copy"),
  at: AT,
  version: "v1",
  findings,
});
const CHECK = { at: AT, version: "v1" };
const migration = (state: Migration["state"], patch: Partial<Migration> = {}): Migration => ({
  ref: "job:1" as LmsRef<"migration">,
  signature: "sig",
  state,
  completion: 40,
  message: null,
  issues: [],
  ...patch,
});
const live = (job: Migration | null): SetupLive => ({ migration: job, scan: null });

const chain = {
  draft: (name: string) => newDraft(name),
  approved: (name: string) => approved(newDraft(name)),
  sending: (name: string) => sending(approved(newDraft(name))),
  held: (name: string) =>
    held(
      step(sending(approved(newDraft(name))), {
        type: "field-outcomes",
        outcomes: { comment: { status: "unknown", since: AT } },
        at: AT,
      }),
    ),
  rejected: (name: string) => held(sending(approved(newDraft(name)))),
  conflicted: (name: string) => conflicted(sending(approved(newDraft(name)))),
  sent: (name: string) => sent(sending(approved(newDraft(name)))),
  discarded: (name: string) => discarded(newDraft(name)),
};
const mapOf = (...records: readonly ChangeRecord[]): ChangeMap =>
  Object.fromEntries(records.map((record) => [record.id, record]));
const COPY_SENT = chain.sent("copy");

describe("canDropFix", () => {
  it.each(["draft", "approved", "conflicted", "rejected"] as const)(
    "lets a %s change go, because nothing of it can land",
    (state) => {
      expect(canDropFix(chain[state]("fix"))).toBe(true);
    },
  );

  it.each(["sending", "held", "sent", "discarded"] as const)("keeps a %s change", (state) => {
    expect(canDropFix(chain[state]("fix"))).toBe(false);
  });
});

describe("stageOf", () => {
  const CLEAR = setup({ scan: scanned([]) });
  const OPEN = setup({ scan: scanned([finding("a", null)]), check: CHECK });
  const table: readonly [
    string,
    CourseSetup,
    ChangeMap,
    SetupLive | undefined,
    SetupStage["tag"],
  ][] = [
    ["no source", setup({ source: null, plan: null, copy: null }), {}, undefined, "source"],
    ["a source, no plan", setup({ plan: null, copy: null }), {}, undefined, "dates"],
    ["a plan, no copy", setup({ copy: null }), {}, undefined, "dates"],
    ["a discarded copy", setup(), mapOf(chain.discarded("copy")), undefined, "dates"],
    ["a draft copy", setup(), mapOf(chain.draft("copy")), undefined, "approve-copy"],
    ["an approved copy", setup(), mapOf(chain.approved("copy")), undefined, "approve-copy"],
    ["a copy sending", setup(), mapOf(chain.sending("copy")), undefined, "approve-copy"],
    ["a held copy", setup(), mapOf(chain.held("copy")), undefined, "approve-copy"],
    ["a conflicted copy", setup(), mapOf(chain.conflicted("copy")), undefined, "approve-copy"],
    ["sent, right after a reload", setup(), mapOf(COPY_SENT), undefined, "copying"],
    ["sent, job running", setup(), mapOf(COPY_SENT), live(migration("running")), "copying"],
    ["sent, job failed", setup(), mapOf(COPY_SENT), live(migration("failed")), "copy-failed"],
    [
      "sent, job done, no scan",
      setup(),
      mapOf(COPY_SENT),
      live(migration("completed")),
      "scanning",
    ],
    [
      "a scan of an earlier copy",
      setup({ scan: { ...scanned([]), copy: id("older") } as CourseSetup["scan"] }),
      mapOf(COPY_SENT),
      live(migration("completed")),
      "scanning",
    ],
    ["scanned, not checked", CLEAR, mapOf(COPY_SENT), undefined, "review"],
    ["checked, with an open row", OPEN, mapOf(COPY_SENT), undefined, "review"],
    [
      "checked and ready",
      setup({ scan: scanned([]), check: CHECK }),
      mapOf(COPY_SENT),
      undefined,
      "publish-check",
    ],
    [
      "publish sent",
      setup({ scan: scanned([]), check: CHECK, publish: id("pub") }),
      mapOf(COPY_SENT, chain.sent("pub")),
      undefined,
      "published",
    ],
  ];

  it.each(table)("%s", (_, state, changes, job, tag) => {
    expect(stageOf(state, changes, job).tag).toBe(tag);
  });

  it("carries the job's progress while copying", () => {
    expect(
      stageOf(
        setup(),
        mapOf(COPY_SENT),
        live(migration("running", { completion: 65, message: "Pages" })),
      ),
    ).toEqual({
      tag: "copying",
      job: { label: "Copying the course", completion: 65, message: "Pages" },
    });
  });

  it("carries the failed job", () => {
    const job = migration("failed", { message: "The package is damaged." });
    expect(stageOf(setup(), mapOf(COPY_SENT), live(job))).toEqual({
      tag: "copy-failed",
      migration: job,
    });
  });

  it("a copy drafted from other dates than the form holds is out of date until reviewed again", () => {
    const moved = { ...PLAN, newTerm: { ...PLAN.newTerm, end: d("2027-05-14") } };
    const copy = mapOf(chain.approved("copy"));
    expect(stageOf(setup({ draft: draftOf(moved) }), copy, undefined)).toEqual({
      tag: "approve-copy",
      copy: "copy",
      stale: true,
    });
    expect(stageOf(setup({ draft: draftOf(PLAN) }), copy, undefined)).toEqual({
      tag: "approve-copy",
      copy: "copy",
      stale: false,
    });
    expect(stageOf(setup({ draft: null }), copy, undefined)).toEqual({
      tag: "approve-copy",
      copy: "copy",
      stale: false,
    });
  });

  it("publish-check carries a live publish change and drops a discarded one", () => {
    const ready = setup({ scan: scanned([]), check: CHECK, publish: id("pub") });
    expect(stageOf(ready, mapOf(COPY_SENT, chain.draft("pub")), undefined)).toEqual({
      tag: "publish-check",
      publish: "pub",
    });
    expect(stageOf(ready, mapOf(COPY_SENT, chain.discarded("pub")), undefined)).toEqual({
      tag: "publish-check",
      publish: null,
    });
  });

  it("a row opening after the check sends the stage back to review", () => {
    const before = setup({ scan: scanned([]), check: CHECK });
    expect(stageOf(before, mapOf(COPY_SENT), undefined).tag).toBe("publish-check");
    expect(
      stageOf({ ...before, scan: scanned([finding("late", null)]) }, mapOf(COPY_SENT), undefined)
        .tag,
    ).toBe("review");
  });
});

describe("stepOf", () => {
  const JOB = { label: "", completion: null, message: null };
  it.each<[SetupStage, string]>([
    [{ tag: "source" }, "Source"],
    [{ tag: "dates" }, "Dates"],
    [{ tag: "approve-copy", copy: id("copy"), stale: false }, "Dates"],
    [{ tag: "copying", job: JOB }, "Scan"],
    [{ tag: "copy-failed", migration: migration("failed") }, "Scan"],
    [{ tag: "scanning", job: JOB }, "Scan"],
    [{ tag: "review" }, "Review"],
    [{ tag: "publish-check", publish: null }, "Publish check"],
    [{ tag: "published" }, "End of term"],
  ])("%o is the step %s", (stage, name) => {
    expect(STEPS[stepOf(stage) - 1]).toBe(name);
  });

  it("the rail has the seven steps, in order", () => {
    expect(STEPS).toEqual([
      "Detect",
      "Source",
      "Dates",
      "Scan",
      "Review",
      "Publish check",
      "End of term",
    ]);
  });
});

describe("copyMigration", () => {
  const job = (ref: string, signature = "sig") =>
    migration("running", { ref: ref as LmsRef<"migration">, signature });

  it("finds no job before the first send, even one with the same words", () => {
    expect(copyMigration({ seen: null }, "sig", [job("a")])).toBeNull();
  });

  it("ignores a job present when the send started, so a retry does not read the failed one", () => {
    expect(copyMigration({ seen: { copy: ["a"] } }, "sig", [job("a")])).toBeNull();
    expect(copyMigration({ seen: { copy: ["a"] } }, "sig", [job("a"), job("b")])?.ref).toBe("b");
  });

  it("ignores a job with other words", () => {
    expect(copyMigration({ seen: {} }, "sig", [job("a", "other")])).toBeNull();
  });
});

describe("reconcile", () => {
  const withFix = (record: ChangeRecord, patch: Partial<CourseSetup> = {}): CourseSetup =>
    setup({ fixes: { [k("a")]: record.id }, ...patch });
  const DISMISSED = { [k("a")]: { at: AT, how: "dismissed", reason: "Not needed." } } as const;

  it("creates a change for a new finding with a fix", () => {
    expect(reconcile(setup(), [finding("a")], {})).toEqual({
      create: [finding("a")],
      discard: [],
      fixes: {},
    });
  });

  it("creates nothing for a manual finding", () => {
    expect(reconcile(setup(), [finding("a", null)], {}).create).toEqual([]);
  });

  it("creates nothing for a dismissed or handled finding", () => {
    expect(reconcile(setup({ resolved: DISMISSED }), [finding("a")], {}).create).toEqual([]);
    expect(
      reconcile(
        setup({ resolved: { [k("a")]: { at: AT, how: "handled", reason: null } } }),
        [finding("a")],
        {},
      ).create,
    ).toEqual([]);
  });

  describe.each(["draft", "approved", "sending", "held", "conflicted"] as const)(
    "a %s change whose finding is still there",
    (state) => {
      it("keeps its link and creates nothing, so a rerun cannot draft it twice", () => {
        const record = chain[state]("fix");
        expect(reconcile(withFix(record), [finding("a")], mapOf(record))).toEqual({
          create: [],
          discard: [],
          fixes: { a: "fix" },
        });
      });
    },
  );

  it("drafts again when the earlier change was discarded and the finding is still there", () => {
    const record = chain.discarded("fix");
    expect(reconcile(withFix(record), [finding("a")], mapOf(record))).toEqual({
      create: [finding("a")],
      discard: [],
      fixes: {},
    });
  });

  it("drafts again when the linked record no longer exists", () => {
    expect(
      reconcile(setup({ fixes: { [k("a")]: id("gone") } }), [finding("a")], {}).create,
    ).toEqual([finding("a")]);
  });

  it.each(["draft", "approved", "conflicted"] as const)(
    "discards a moot %s change, whose finding is gone",
    (state) => {
      const record = chain[state]("fix");
      expect(reconcile(withFix(record), [], mapOf(record))).toEqual({
        create: [],
        discard: ["fix"],
        fixes: {},
      });
    },
  );

  it.each(["sending", "held"] as const)(
    "never discards a %s change, which may still land",
    (state) => {
      const record = chain[state]("fix");
      expect(reconcile(withFix(record), [], mapOf(record))).toEqual({
        create: [],
        discard: [],
        fixes: { a: "fix" },
      });
      expect(
        reconcile(withFix(record, { resolved: DISMISSED }), [finding("a")], mapOf(record)),
      ).toEqual({ create: [], discard: [], fixes: { a: "fix" } });
    },
  );

  it("retires a sent fix whose passage is found again, keeps it as the record, and drafts the passage anew", () => {
    const record = chain.sent("fix");
    const found = finding("a");
    expect(reconcile(withFix(record), [found], mapOf(record))).toEqual({
      create: [found],
      discard: [],
      fixes: { "a:fix": "fix" },
    });
  });

  it("creates nothing more once a retired fix has its new draft", () => {
    const record = chain.sent("fix");
    const next = chain.draft("next");
    expect(
      reconcile(
        setup({ fixes: { [k("a:fix")]: record.id, [k("a")]: next.id } }),
        [finding("a")],
        mapOf(record, next),
      ),
    ).toEqual({ create: [], discard: [], fixes: { "a:fix": "fix", a: "next" } });
  });

  it("leaves a sent fix alone when the finding found again is dismissed or has no fix to draft", () => {
    const record = chain.sent("fix");
    expect(
      reconcile(withFix(record, { resolved: DISMISSED }), [finding("a")], mapOf(record)),
    ).toEqual({ create: [], discard: [], fixes: { a: "fix" } });
    expect(reconcile(withFix(record), [finding("a", null)], mapOf(record))).toEqual({
      create: [],
      discard: [],
      fixes: { a: "fix" },
    });
  });

  it("keeps a sent change whose finding is gone, as the record of the fix", () => {
    const record = chain.sent("fix");
    expect(reconcile(withFix(record), [], mapOf(record))).toEqual({
      create: [],
      discard: [],
      fixes: { a: "fix" },
    });
  });

  it("drops the link of a discarded change whose finding is gone", () => {
    const record = chain.discarded("fix");
    expect(reconcile(withFix(record), [], mapOf(record))).toEqual({
      create: [],
      discard: [],
      fixes: {},
    });
  });

  it.each(["draft", "approved", "conflicted"] as const)(
    "discards a %s change on a dismissed finding, and does not draft it again",
    (state) => {
      const record = chain[state]("fix");
      expect(
        reconcile(withFix(record, { resolved: DISMISSED }), [finding("a")], mapOf(record)),
      ).toEqual({ create: [], discard: ["fix"], fixes: {} });
    },
  );

  it("drafts a restored finding again once its dismissal is deleted", () => {
    const record = chain.discarded("fix");
    expect(
      reconcile(withFix(record, { resolved: {} }), [finding("a")], mapOf(record)).create,
    ).toEqual([finding("a")]);
  });

  it("is idempotent once the store has applied its result", () => {
    const record = chain.draft("fix");
    const first = reconcile(
      setup({ fixes: { [k("a")]: record.id } }),
      [finding("a")],
      mapOf(record),
    );
    expect(reconcile(setup({ fixes: first.fixes }), [finding("a")], mapOf(record))).toEqual(first);
  });
});

describe("reviewRows", () => {
  const statusOf = (state: CourseSetup, changes: ChangeMap) =>
    reviewRows(state, changes).map((row) => row.status);

  it("a manual finding asks a person", () => {
    expect(statusOf(setup({ scan: scanned([finding("a", null)]) }), {})).toEqual(["manual"]);
  });

  it("a finding with a live change is a fix, with the change's summary", () => {
    const record = chain.approved("fix");
    const [row] = reviewRows(
      setup({ scan: scanned([finding("a")]), fixes: { [k("a")]: record.id } }),
      mapOf(record),
    );
    expect(row).toMatchObject({ status: "fix", change: { id: "fix" }, summary: { tone: "ready" } });
  });

  it("a sent fix whose finding remains says still-here", () => {
    const record = chain.sent("fix");
    expect(
      statusOf(
        setup({ scan: scanned([finding("a")]), fixes: { [k("a")]: record.id } }),
        mapOf(record),
      ),
    ).toEqual(["still-here"]);
  });

  it("a fix sent after the scan read the course says checking, and keeps the course from passing", () => {
    const record = chain.sent("fix");
    if (record.state.tag !== "sent") throw new Error("Not sent.");
    const before = new Date(Date.parse(record.state.at) - 1000).toISOString() as IsoTime;
    const rows = reviewRows(
      setup({ scan: { ...scanned([finding("a")])!, at: before }, fixes: { [k("a")]: record.id } }),
      mapOf(record),
    );
    expect(rows.map((row) => row.status)).toEqual(["checking"]);
    expect(rows.every(isOpenRow)).toBe(true);
  });

  it("a sent fix whose finding is gone stays as fixed", () => {
    const record = chain.sent("fix");
    const [row] = reviewRows(
      setup({ scan: scanned([]), fixes: { [k("a")]: record.id } }),
      mapOf(record),
    );
    expect(row).toMatchObject({ status: "fixed", finding: null, change: { id: "fix" } });
  });

  it("shows how a finding was resolved", () => {
    const resolved = {
      [k("a")]: { at: AT, how: "dismissed", reason: "No." },
      [k("b")]: { at: AT, how: "handled", reason: null },
    } as const;
    expect(
      statusOf(setup({ scan: scanned([finding("a"), finding("b", null)]), resolved }), {}),
    ).toEqual(["dismissed", "handled"]);
  });

  it("a discarded change leaves no change on the row", () => {
    const record = chain.discarded("fix");
    const [row] = reviewRows(
      setup({ scan: scanned([finding("a")]), fixes: { [k("a")]: record.id } }),
      mapOf(record),
    );
    expect(row).toMatchObject({ status: "fix", change: null, summary: null });
  });

  it("has no rows before a scan", () => {
    expect(reviewRows(setup(), {})).toEqual([]);
  });
});

describe("readinessOf", () => {
  const rowsOf = (
    findings: readonly Finding[],
    patch: Partial<CourseSetup> = {},
    changes: ChangeMap = {},
  ) => reviewRows(setup({ scan: scanned(findings), ...patch }), changes);

  it("is ready with no rows", () => {
    expect(readinessOf([])).toEqual({
      ready: true,
      groups: { dates: 0, "empty-modules": 0, unpublished: 0, findings: 0 },
    });
  });

  it("counts open rows in their groups", () => {
    const rows = rowsOf([
      finding("a", null, "date-outside-term"),
      finding("b", null, "date-in-break"),
      finding("c", null, "plain-date"),
      finding("d", null, "empty-module"),
      finding("e", null, "unpublished-item"),
      finding("f", null, "lti-link"),
    ]);
    expect(readinessOf(rows)).toEqual({
      ready: false,
      groups: { dates: 3, "empty-modules": 1, unpublished: 1, findings: 1 },
    });
  });

  it("is not ready while a fix waits on approval, and not when a sent fix did not take", () => {
    const draft = chain.draft("fix");
    expect(
      readinessOf(rowsOf([finding("a")], { fixes: { [k("a")]: draft.id } }, mapOf(draft))).ready,
    ).toBe(false);
    const done = chain.sent("fix");
    expect(
      readinessOf(rowsOf([finding("a")], { fixes: { [k("a")]: done.id } }, mapOf(done))).ready,
    ).toBe(false);
  });

  it("is ready once every finding is fixed, dismissed, or handled", () => {
    const done = chain.sent("fix");
    const resolved = {
      [k("b")]: { at: AT, how: "dismissed", reason: "No." },
      [k("c")]: { at: AT, how: "handled", reason: "I re-linked it." },
    } as const;
    expect(
      readinessOf(
        rowsOf(
          [finding("b"), finding("c", null)],
          { resolved, fixes: { [k("a")]: done.id } },
          mapOf(done),
        ),
      ).ready,
    ).toBe(true);
  });

  it("a fix still sending counts as open even with its finding gone", () => {
    const moving = chain.sending("fix");
    expect(
      readinessOf(rowsOf([], { fixes: { [k("a")]: moving.id } }, mapOf(moving))),
    ).toMatchObject({ ready: false, groups: { findings: 1 } });
  });
});
