import { describe, expect, it } from "vite-plus/test";

import {
  fieldText,
  type CourseCopyContent,
  type SetContent,
  type TextFixContent,
} from "~/shared/domain/change";
import type { CourseShell, SourceCourse } from "~/shared/domain/content";
import type { SchoolId } from "~/shared/domain/ids";
import { spliceAt } from "~/shared/domain/splice";
import type { LmsProvider, TermSetup } from "~/shared/providers/provider";

import { permitFor, unwrap } from "./provider-contract";
import { cartridgeContent, copyContent, termOf } from "./term";

export interface TermContractHarness {
  provider: LmsProvider;
  school: SchoolId;
  /** An empty, unpublished course for the new term. */
  shell: CourseShell;
  /** A course to copy from. */
  source: SourceCourse;
  /** Moves the clock the job runs on. */
  advance(ms: number): void;
  loseNext(): void;
  failNextMigration(stage: "pre_processing" | "running", message: string): void;
  writeCount(): number;
  /** Whether the LMS lists sample packages to import. Real Canvas has none until package upload (step 14). */
  offersPackages: boolean;
}

const MIGRATION_KEYS = new Set(["ref", "signature", "state", "completion", "message", "issues"]);
const ISSUE_KEYS = new Set(["severity", "text", "open", "fixUrl"]);
const expectOnlyKeys = (value: object, allowed: ReadonlySet<string>) =>
  expect(Object.keys(value).filter((key) => !allowed.has(key))).toEqual([]);

const setupOf = (provider: LmsProvider): TermSetup => {
  if (!provider.termSetup) throw new Error("this provider offers no term setup");
  return provider.termSetup;
};

/** What the writeback would see for the copy field after the job is created. */
const copyRemote = async (provider: LmsProvider, content: CourseCopyContent) => {
  const remote = await unwrap(provider.observe(content));
  if (remote.kind !== "course-copy") throw new Error("expected a course-copy remote");
  return remote;
};

/** A provider that offers term setup passes this too: the fake, and real Canvas over recorded HTTP. */
export const runTermSetupContract = (
  name: string,
  makeHarness: () => Promise<TermContractHarness>,
): void => {
  describe(`term setup contract: ${name}`, () => {
    const copied = async (harness: TermContractHarness) => {
      const { provider, school, shell, source } = harness;
      const content = copyContent(shell, source);
      const outcomes = await provider.apply(await permitFor(provider, content, ["copy"], school));
      expect(outcomes.copy?.status).toBe("landed");
      harness.advance(60_000);
      const jobs = await unwrap(setupOf(provider).migrations(shell.ref));
      expect(jobs.map((job) => job.state)).toEqual(["completed"]);
      return { ...harness, content, job: jobs[0] };
    };

    it("courses() never lists an unpublished new course, and newCourses() does", async () => {
      const { provider, shell } = await makeHarness();
      expect((await unwrap(provider.courses())).map((course) => course.ref)).not.toContain(
        shell.ref,
      );
      expect((await unwrap(setupOf(provider).newCourses())).map((course) => course.ref)).toContain(
        shell.ref,
      );
    });

    it("a copy job moves through its states as the clock moves, and content lands once at completion", async () => {
      const harness = await makeHarness();
      const { provider, school, shell, source } = harness;
      const setup = setupOf(provider);
      expect((await unwrap(setup.courseContent(shell.ref))).items).toEqual([]);
      const content = copyContent(shell, source);
      await provider.apply(await permitFor(provider, content, ["copy"], school));
      const first = await unwrap(setup.migrations(shell.ref));
      expect(first).toHaveLength(1);
      expect(["queued", "preparing", "running"]).toContain(first[0]?.state);
      for (const job of first) expectOnlyKeys(job, MIGRATION_KEYS);
      harness.advance(2000);
      const mid = await unwrap(setup.migrations(shell.ref));
      expect(mid[0]?.state).toBe("running");
      expect(mid[0]?.completion).toBeGreaterThan(0);
      expect(mid[0]?.completion).toBeLessThan(100);
      expect((await unwrap(setup.courseContent(shell.ref))).items).toEqual([]);
      harness.advance(60_000);
      const done = await unwrap(setup.migrations(shell.ref));
      expect(done[0]?.state).toBe("completed");
      expect(done[0]?.completion).toBe(100);
      const landed = await unwrap(setup.courseContent(shell.ref));
      expect(landed.items.length).toBeGreaterThan(0);
      expect(landed.items.every((item) => item.copied)).toBe(true);
      harness.advance(60_000);
      expect((await unwrap(setup.courseContent(shell.ref))).items).toHaveLength(
        landed.items.length,
      );
    });

    it("a finished job's issues come back in neutral terms", async () => {
      const { job } = await copied(await makeHarness());
      expect(job?.issues.length).toBeGreaterThan(0);
      for (const issue of job?.issues ?? []) {
        expectOnlyKeys(issue, ISSUE_KEYS);
        expect(["todo", "warning", "error"]).toContain(issue.severity);
      }
    });

    it("a job that fails reports failed with its message, and lands nothing", async () => {
      const harness = await makeHarness();
      const { provider, school, shell, source } = harness;
      harness.failNextMigration("running", "The import timed out.");
      await provider.apply(await permitFor(provider, copyContent(shell, source), ["copy"], school));
      harness.advance(60_000);
      const jobs = await unwrap(setupOf(provider).migrations(shell.ref));
      expect(jobs.map((job) => job.state)).toEqual(["failed"]);
      expect(jobs[0]?.message).toBe("The import timed out.");
      expect((await unwrap(setupOf(provider).courseContent(shell.ref))).items).toEqual([]);
    });

    it("a lost response still creates exactly one job, and observe shows it under the copy's own text", async () => {
      const harness = await makeHarness();
      const { provider, school, shell, source } = harness;
      const content = copyContent(shell, source);
      const permit = await permitFor(provider, content, ["copy"], school);
      harness.loseNext();
      const outcomes = await provider.apply(permit);
      expect(outcomes.copy?.status).toBe("unknown");
      expect(await unwrap(setupOf(provider).migrations(shell.ref))).toHaveLength(1);
      const remote = await copyRemote(provider, content);
      expect(remote.migrations).toHaveLength(1);
      expect(remote.migrations[0]?.mine).toBe(true);
      expect(remote.migrations[0]?.text).toBe(fieldText(content, "copy"));
    });

    it("a deleted item observes as deleted rather than not found", async () => {
      const harness = await copied(await makeHarness());
      const { provider, school, shell } = harness;
      const landed = await unwrap(setupOf(provider).courseContent(shell.ref));
      const announcement = landed.items.find((item) => item.type === "announcement");
      if (!announcement) throw new Error("the copy brought no announcement");
      const content: SetContent = {
        kind: "item-set",
        target: announcement.ref,
        where: announcement.title,
        intent: { set: "item-deleted" },
      };
      const before = await unwrap(provider.observe(content));
      expect(before).toEqual({ kind: "item-set", targetVersion: "present", value: "present" });
      const outcomes = await provider.apply(await permitFor(provider, content, ["value"], school));
      expect(outcomes.value?.status).toBe("landed");
      expect(await unwrap(provider.observe(content))).toEqual({
        kind: "item-set",
        targetVersion: "deleted",
        value: "deleted",
      });
      expect(
        (await unwrap(setupOf(provider).courseContent(shell.ref))).items.map((item) => item.ref),
      ).not.toContain(announcement.ref);
    });

    it("a link in two places keeps pointing at the old course until the last place is fixed", async () => {
      const harness = await copied(await makeHarness());
      const { provider, school, shell } = harness;
      const landed = await unwrap(setupOf(provider).courseContent(shell.ref));
      const page = landed.items.find((item) =>
        item.links.some((link) => link.points === "other-course" && link.replacement !== null),
      );
      const old = page?.links.find(
        (link) => link.points === "other-course" && link.replacement !== null,
      );
      if (!page || old?.points !== "other-course" || old.replacement === null)
        throw new Error("the copy brought no link that can be repointed");
      const fixFirst = async (replaced: string, after: string) => {
        const { items } = await unwrap(setupOf(provider).courseContent(shell.ref));
        const body = items.find((item) => item.ref === page.ref)?.body ?? "";
        const fix: TextFixContent = {
          kind: "text-fix",
          target: page.ref,
          where: page.title,
          splice: spliceAt(
            body,
            replaced === "" ? body.length : body.indexOf(replaced),
            replaced.length,
            after,
          ),
        };
        await provider.apply(await permitFor(provider, fix, ["text"], school));
        return (
          (await unwrap(setupOf(provider).courseContent(shell.ref))).items
            .find((item) => item.ref === page.ref)
            ?.links.map((link) => link.url) ?? []
        );
      };
      await fixFirst("", ` Again at ${old.url}`);
      const afterOne = await fixFirst(old.url, old.replacement);
      expect(afterOne).toContain(old.url);
      expect(afterOne).toContain(old.replacement);
      expect(await fixFirst(old.url, old.replacement)).not.toContain(old.url);
    });

    it("a fix that repoints a link changes what the next read says the link points at", async () => {
      const harness = await copied(await makeHarness());
      const { provider, school, shell } = harness;
      const landed = await unwrap(setupOf(provider).courseContent(shell.ref));
      const page = landed.items.find((item) =>
        item.links.some((link) => link.points === "other-course" && link.replacement !== null),
      );
      const old = page?.links.find(
        (link) => link.points === "other-course" && link.replacement !== null,
      );
      if (!page || old?.points !== "other-course" || old.replacement === null)
        throw new Error("the copy brought no link that can be repointed");
      const fix: TextFixContent = {
        kind: "text-fix",
        target: page.ref,
        where: page.title,
        splice: spliceAt(page.body, page.body.indexOf(old.url), old.url.length, old.replacement),
      };
      await provider.apply(await permitFor(provider, fix, ["text"], school));
      const after = await unwrap(setupOf(provider).courseContent(shell.ref));
      const links = after.items.find((item) => item.ref === page.ref)?.links ?? [];
      expect(links.map((link) => link.url)).not.toContain(old.url);
      expect(links.find((link) => link.url === old.replacement)?.points).not.toBe("other-course");
    });

    it("apply writes only the field the permit names, and only the passage the fix names", async () => {
      const harness = await copied(await makeHarness());
      const { provider, school, shell } = harness;
      const landed = await unwrap(setupOf(provider).courseContent(shell.ref));
      const page = landed.items.find(
        (item) => item.type === "page" && item.body.includes("Fall 2026"),
      );
      if (!page) throw new Error("the copy brought no page naming the old term");
      const index = page.body.indexOf("Fall 2026");
      const fix: TextFixContent = {
        kind: "text-fix",
        target: page.ref,
        where: page.title,
        splice: spliceAt(page.body, index, "Fall 2026".length, "Spring 2027"),
      };
      const others = landed.items.filter((item) => item.ref !== page.ref).map((item) => item.body);
      const writes = harness.writeCount();
      const outcomes = await provider.apply(await permitFor(provider, fix, ["text"], school));
      expect(Object.keys(outcomes)).toEqual(["text"]);
      expect(outcomes.text?.status).toBe("landed");
      expect(harness.writeCount()).toBe(writes + 1);
      const after = await unwrap(setupOf(provider).courseContent(shell.ref));
      const rewritten = after.items.find((item) => item.ref === page.ref);
      expect(rewritten?.body).toBe(
        page.body.slice(0, index) + "Spring 2027" + page.body.slice(index + "Fall 2026".length),
      );
      expect(after.items.filter((item) => item.ref !== page.ref).map((item) => item.body)).toEqual(
        others,
      );
    });

    it("publishing the course is a setting, after which courses() lists it", async () => {
      const harness = await copied(await makeHarness());
      const { provider, school, shell } = harness;
      const content: SetContent = {
        kind: "item-set",
        target: shell.stateTarget,
        where: shell.code,
        intent: { set: "course-published" },
      };
      expect(await unwrap(provider.observe(content))).toEqual({
        kind: "item-set",
        targetVersion: "present",
        value: "unpublished",
      });
      const outcomes = await provider.apply(await permitFor(provider, content, ["value"], school));
      expect(outcomes.value?.status).toBe("landed");
      expect((await unwrap(provider.courses())).map((course) => course.ref)).toContain(shell.ref);
      expect(
        (await unwrap(setupOf(provider).newCourses())).map((course) => course.ref),
      ).not.toContain(shell.ref);
    });

    it("a package nobody uploaded fails the copy and creates no job", async () => {
      const harness = await makeHarness();
      const { provider, school, shell, source } = harness;
      const content = cartridgeContent(shell, "nobody-uploaded-this.imscc", termOf(source));
      const outcomes = await provider.apply(await permitFor(provider, content, ["copy"], school));
      expect(outcomes.copy?.status).toBe("failed");
      if (outcomes.copy?.status === "failed") expect(outcomes.copy.error.kind).toBe("rejected");
      expect(await unwrap(setupOf(provider).migrations(shell.ref))).toEqual([]);
    });

    it("the sample packages are listed, and the copy sources list templates first", async () => {
      const { provider, offersPackages } = await makeHarness();
      const packages = await unwrap(setupOf(provider).samplePackages());
      expect(packages.length > 0).toBe(offersPackages);
      for (const pkg of packages) expect(pkg.name.endsWith(".imscc")).toBe(true);
      const sources = await unwrap(setupOf(provider).copySources());
      const firstPlain = sources.findIndex((source) => !source.template);
      const lastTemplate = sources.map((source) => source.template).lastIndexOf(true);
      if (firstPlain !== -1 && lastTemplate !== -1) expect(lastTemplate).toBeLessThan(firstPlain);
    });
  });
};
