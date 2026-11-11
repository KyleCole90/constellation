import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SetupRail, SetupScreen } from "~/components/setup/SetupScreen";
import { ReviewCard } from "~/components/setup/ReviewCard";
import { DueOffers } from "~/components/screens/DueOffers";
import { SidebarOffers } from "~/components/Sidebar";
import { ThreadActionsContext, type ThreadActions } from "~/components/thread/context";
import { summarize } from "~/domain/change";
import type { Migration } from "~/domain/content";
import type { ChangeId, IsoTime, LmsRef } from "~/domain/ids";
import { isOpenRow, reviewRows } from "~/domain/setup";
import { setupGroupKey } from "~/components/sidebar.logic";
import type { WorkspaceStore } from "~/stores/workspace";

import { clickWitness } from "./fixtures/changes";
import { LCC, RSU } from "./fixtures/rig";
import { makeStoreRig, type StoreRig } from "./fixtures/store-rig";
import { planFor, termOf } from "./fixtures/term";

const holder = vi.hoisted(() => ({ store: null as unknown }));

// A server render has no subscriptions, so the hook reads the rig's store directly. Each render below shows one moment of the flow.
vi.mock("~/stores/workspace", async (actual) => {
  const module = await actual<typeof import("~/stores/workspace")>();
  const store = () => holder.store as WorkspaceStore;
  return {
    ...module,
    workspaceStore: store,
    useWorkspace: (selector: (state: ReturnType<WorkspaceStore["getState"]>) => unknown) =>
      selector(store().getState()),
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));

let rig: StoreRig;
const COURSE_CODE = "ENG 101";

const threadActions = (rigThread: ThreadActions["threadId"]): ThreadActions => ({
  threadId: rigThread,
  rows: [],
  batch: [],
  busy: new Set(),
  drafting: new Set(),
  next: null,
  send: () => undefined,
  openRow: () => undefined,
  messageRow: () => undefined,
  focus: () => undefined,
  draftRows: async () => undefined,
  setUi: () => undefined,
});
const inThread = (thread: ThreadActions["threadId"], ...children: readonly ReactNode[]) =>
  renderToString(
    createElement(ThreadActionsContext.Provider, { value: threadActions(thread) }, ...children),
  );
const shown = (html: string, testId: string) => html.includes(`data-testid="${testId}"`);
const shownAll = (html: string, testIds: readonly string[]) =>
  testIds.filter((testId) => !shown(html, testId));

const offered = () => {
  const shell = rig.state().newCourses[LCC]?.find((entry) => entry.code === COURSE_CODE);
  if (!shell) throw new Error("Not offered.");
  return shell;
};
const setup = (course: LmsRef<"course">) => {
  const found = rig.state().setups[course];
  if (!found) throw new Error("No setup.");
  return found;
};
const screen = (course: LmsRef<"course">) => {
  const thread = rig.state().threads[setup(course).thread];
  if (!thread) throw new Error("No thread.");
  return inThread(
    thread.id,
    createElement(SetupRail, { thread }),
    createElement(SetupScreen, { thread }),
  );
};
const approve = (id: ChangeId) => {
  const record = rig.state().changes[id];
  if (!record) throw new Error("No change.");
  const at = new Date(rig.state().now()).toISOString() as IsoTime;
  const result = rig
    .state()
    .dispatchUser(id, { type: "approve", witness: clickWitness(record), at });
  if (!result.ok) throw new Error(result.error);
};
const until = (holds: () => boolean) =>
  rig.clock.run(
    (async () => {
      for (let step = 0; step < 2000; step++) {
        if (holds()) return;
        await rig.clock.sleep(50);
      }
      throw new Error("It never happened.");
    })(),
  );

const toDraft = async () => {
  const shell = offered();
  rig.state().startSetup(shell.ref);
  await rig.clock.run(rig.state().loadSetupOptions(LCC));
  const source = rig
    .state()
    .setupOptions[LCC]?.sources.find(
      (entry) => entry.code === COURSE_CODE && entry.termName === "Fall 2026",
    );
  if (!source) throw new Error("No source.");
  return { shell, source };
};
const toCopy = async () => {
  const { shell, source } = await toDraft();
  rig.state().chooseSource(shell.ref, {
    kind: "course",
    ref: source.ref,
    label: source.code,
    termName: source.termName,
  });
  await rig.clock.run(rig.state().confirmDates(shell.ref, planFor(termOf(source), shell)));
  const copy = setup(shell.ref).copy;
  if (!copy) throw new Error("No copy.");
  return { course: shell.ref, copy };
};
const toReview = async () => {
  const { course, copy } = await toCopy();
  approve(copy);
  await rig.clock.run(rig.state().sendChanges([copy]));
  await until(() => setup(course).scan !== null && !rig.state().working[setup(course).thread]);
  return course;
};
const rowsOf = (course: LmsRef<"course">) => reviewRows(setup(course), rig.state().changes);
const reviewWith = (course: LmsRef<"course">, opened: string) =>
  inThread(
    setup(course).thread,
    createElement(ReviewCard, {
      course,
      school: LCC,
      thread: setup(course).thread,
      rows: rowsOf(course),
      opened,
      onOpen: () => undefined,
    }),
  );

beforeEach(async () => {
  rig = await makeStoreRig();
  await rig.connectAll();
  holder.store = rig.store;
});

describe("the offer", () => {
  const sidebarOffers = () =>
    renderToString(createElement(SidebarOffers, { school: LCC, activeThread: null }));

  it("folds into one row in the sidebar, names the course once opened, and stays on the Due banner once started, with Continue and Cancel", () => {
    const shells = rig.state().newCourses[LCC] ?? [];
    const folded = sidebarOffers();
    expect(folded).toContain(
      `${shells.length} Spring 2027 course${shells.length === 1 ? "" : "s"} to set up`,
    );
    expect(folded).not.toContain('data-testid="setup-offer"');
    rig.state().setPrefs({ expandedThreads: { [setupGroupKey(LCC)]: true } });
    const opened = sidebarOffers();
    expect(opened).toContain(`>${COURSE_CODE}<`);
    expect(opened).toContain(">Empty<");
    expect(opened).toContain(">Set up<");
    const due = renderToString(createElement(DueOffers));
    expect(due).toContain("Set up this course");
    expect(due).toContain(COURSE_CODE);
    rig.state().startSetup(offered().ref);
    const started = renderToString(createElement(DueOffers));
    expect(started).toContain(`>${COURSE_CODE}<`);
    expect(started).toContain("Choosing a source");
    expect(started).toContain("Continue setup");
    expect(started).toContain("Cancel setup");
  });

  it("keeps a setup under way in view while the rest stay folded", () => {
    rig.state().startSetup(offered().ref);
    const html = sidebarOffers();
    expect(html).toContain(`data-course="${offered().ref}"`);
    expect(html).toContain("Choosing a source");
    expect(html).toContain("to set up");
  });
});

describe("each stage's screen", () => {
  it("source lists courses, samples, and the file input, with the rail on step 2", async () => {
    const { shell, source } = await toDraft();
    const html = screen(shell.ref);
    expect(
      shownAll(html, [
        "setup-rail",
        "setup-step-1",
        "setup-step-7",
        `source-course-${source.code}`,
        "source-sample-0",
        "cartridge-input",
      ]),
    ).toEqual([]);
    expect(html).toMatch(/data-testid="setup-step-2" data-state="current"/);
    expect(html).toContain('accept=".imscc"');
  });

  it("dates shows every control and the shift table, for a course source", async () => {
    const { shell, source } = await toDraft();
    rig.state().chooseSource(shell.ref, {
      kind: "course",
      ref: source.ref,
      label: source.code,
      termName: source.termName,
    });
    const html = screen(shell.ref);
    expect(
      shownAll(html, [
        "dates-card",
        "day-old-0",
        "day-new-6",
        "add-break",
        "review-copy",
        "shift-row",
      ]),
    ).toEqual([]);
  });

  it("the copy shows its preview, and Send only once it is approved", async () => {
    const { course, copy } = await toCopy();
    expect(shown(screen(course), "copy-send")).toBe(false);
    approve(copy);
    expect(screen(course)).toMatch(/<button[^>]*data-testid="copy-send"/);
    expect(screen(course)).not.toMatch(/<button[^>]*data-testid="copy-send"[^>]* disabled=""/);
  });

  it("the copy preview lists where every due date lands", async () => {
    const { source } = await toDraft();
    const { course } = await toCopy();
    const card = screen(course).split('data-testid="copy-card"')[1] ?? "";
    expect(card.split('data-testid="shift-row"')).toHaveLength(source.dated.length + 1);
    expect(card).toContain("Moved out of Spring break");
  });

  it("an occupied destination warns before the approval", async () => {
    const shell = rig.state().newCourses[RSU]?.find((entry) => entry.code === "HUM 150");
    if (!shell) throw new Error("Not offered.");
    rig.state().startSetup(shell.ref);
    rig.state().chooseSource(shell.ref, { kind: "cartridge", name: "x.imscc", kb: 1, hint: null });
    expect(shown(screen(shell.ref), "occupied-warning")).toBe(true);
  });

  it("copying shows progress, and a failed job shows its message, its issues, and Copy again", async () => {
    const { course, copy } = await toCopy();
    approve(copy);
    await rig.clock.run(rig.state().sendChanges([copy]));
    const running = screen(course);
    expect(shown(running, "copy-progress")).toBe(true);
    expect(shown(running, "finding-row")).toBe(false);
    const migration: Migration = {
      ref: "job" as Migration["ref"],
      signature: "s",
      state: "failed",
      completion: 40,
      message: "The package is damaged.",
      issues: [{ severity: "error", text: "Missing manifest", open: true, fixUrl: null }],
    };
    rig.store.setState({ setupLive: { [course]: { migration, scan: null } } });
    const failed = screen(course);
    expect(shownAll(failed, ["copy-failed", "copy-again"])).toEqual([]);
    expect(failed).toContain("The package is damaged.");
    expect(failed).toContain("Missing manifest");
  });

  it("review groups rows, and an opened row offers its actions", async () => {
    const course = await toReview();
    const html = screen(course);
    expect(shownAll(html, ["finding-row", "finding-toggle", "batch-approve", "run-check"])).toEqual(
      [],
    );
    expect(shown(html, "batch-send")).toBe(false);
    const fix = rowsOf(course).find(
      (row) =>
        row.change && summarize(row.change).canApprove && row.change.content.kind === "text-fix",
    );
    if (!fix) throw new Error("No fix to open.");
    expect(html).toContain(`data-testid="finding-group-${fix.finding?.type}"`);
    expect(
      shownAll(reviewWith(course, fix.key), ["finding-approve", "finding-edit", "finding-dismiss"]),
    ).toEqual([]);
  });

  it("a manual row offers I handled it, and a dismissed row offers Restore", async () => {
    const course = await toReview();
    const manual = rowsOf(course).find((row) => row.status === "manual");
    if (!manual) throw new Error("No manual row.");
    expect(shown(reviewWith(course, manual.key), "finding-handled")).toBe(true);
    expect(rig.state().dismissFinding(course, manual.key, "No need")).toBeNull();
    const html = reviewWith(course, manual.key);
    expect(shown(html, "finding-restore")).toBe(true);
    expect(html).toContain("No need");
  });

  it("the check names what is left, and offers no publish while anything is", async () => {
    const course = await toReview();
    await rig.clock.run(rig.state().runPublishCheck(course));
    const html = screen(course);
    expect(shown(html, "readiness")).toBe(true);
    expect(shown(html, "prepare-publish")).toBe(false);
  });

  it("ready, publish, and the template each show their change, with publish only once approved", async () => {
    const course = await toReview();
    for (let round = 0; round < 12; round++) {
      const open = rowsOf(course).filter(isOpenRow);
      if (open.length === 0) break;
      for (const row of open)
        if (row.status !== "fix") rig.state().dismissFinding(course, row.key, null);
      const fixes = open.flatMap((row) =>
        row.status === "fix" && row.change ? [row.change.id] : [],
      );
      for (const id of fixes) approve(id);
      await rig.clock.run(rig.state().sendChanges(fixes));
    }
    await rig.clock.run(rig.state().runPublishCheck(course));
    const ready = screen(course);
    expect(shownAll(ready, ["readiness", "prepare-publish"])).toEqual([]);
    expect(ready).toContain("Pass");

    const proposed = await rig.clock.run(rig.state().proposePublish(course));
    if (!proposed.ok) throw new Error(proposed.error);
    expect(shown(screen(course), "publish-send")).toBe(false);
    approve(proposed.value);
    expect(shown(screen(course), "publish-send")).toBe(true);
    expect(screen(course)).not.toMatch(/<button[^>]*data-testid="publish-send"[^>]* disabled=""/);
    await rig.clock.run(rig.state().sendChanges([proposed.value]));

    const done = screen(course);
    expect(shown(done, "published-card")).toBe(true);
    expect(shown(done, "save-template")).toBe(false);
    expect(done).toMatch(/data-testid="setup-step-7" data-state="upcoming"/);
    expect(done).toMatch(/\d+ fix(es)? sent/);
    const template = await rig.clock.run(rig.state().proposeTemplate(course));
    if (!template.ok) throw new Error(template.error);
    expect(shown(screen(course), "template-approve")).toBe(true);
    expect(shown(screen(course), "template-send")).toBe(false);
  });
});
