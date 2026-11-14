import type { ChangeRecord, CourseCopyContent, TextFixContent } from "~/shared/domain/change";
import type { CourseContent, CourseShell, Migration, SourceCourse } from "~/shared/domain/content";
import type { ChangeId, LmsRef, SchoolId } from "~/shared/domain/ids";
import { scanCourse, type Finding, type FindingType } from "~/shared/domain/scan";
import { shiftOptionsOf, termName, type TermDates, type TermPlan } from "~/shared/domain/term";
import {
  FALL_2026,
  SPRING_2027,
  SPRING_2027_BREAKS,
} from "~/shared/providers/fake-canvas/seed-term";
import type { TermSetup } from "~/shared/providers/provider";

import { unwrap } from "./provider-contract";
import { makeRig } from "./rig";

const CONTACT: Readonly<Record<string, string>> = {
  lcc: "kyle@lakeshore.edu",
  rsu: "kyle@riverbend.edu",
};

/** The plan a person would confirm: the source's term into the shell's, meeting days kept, the seeded break. Where the LMS hides the new term's dates, the person types Spring 2027's. */
export const planFor = (oldTerm: TermDates, shell: CourseShell): TermPlan => ({
  oldTerm,
  newTerm: {
    name: termName(shell.termName),
    start: shell.startAt ?? SPRING_2027([]).start,
    end: shell.endAt ?? SPRING_2027([]).end,
    days: oldTerm.days,
  },
  breaks: SPRING_2027_BREAKS,
});
/** The source's term as the Dates step holds it. Where the LMS hides its dates, the person types Fall 2026's. */
export const termOf = (source: SourceCourse): TermDates => ({
  name: termName(source.termName),
  start: source.startAt ?? FALL_2026([]).start,
  end: source.endAt ?? FALL_2026([]).end,
  days: source.meetingDays,
});

export const copyContent = (
  shell: CourseShell,
  source: SourceCourse,
  plan = planFor(termOf(source), shell),
): CourseCopyContent => ({
  kind: "course-copy",
  target: shell.copyTarget,
  into: { code: shell.code, title: shell.title },
  source: {
    kind: "course",
    ref: source.ref,
    label: `${source.code}, ${source.termName}`,
    termName: source.termName,
  },
  plan,
  shift: shiftOptionsOf(plan),
});

export const cartridgeContent = (
  shell: CourseShell,
  name: string,
  hint: TermDates,
  kb = 100,
): CourseCopyContent => {
  const plan = planFor(hint, shell);
  return {
    kind: "course-copy",
    target: shell.copyTarget,
    into: { code: shell.code, title: shell.title },
    source: { kind: "cartridge", name, kb, hint: { ...hint, dated: [] } },
    plan,
    shift: shiftOptionsOf(plan),
  };
};

/** The rig plus the term-setup reads, with the job clock under the test's control. */
export const makeTermRig = async () => {
  const rig = await makeRig();
  const setup = (school: SchoolId): TermSetup => {
    const found = rig.provider(school).termSetup;
    if (!found) throw new Error(`${school} offers no term setup.`);
    return found;
  };
  const shells = (school: SchoolId): Promise<readonly CourseShell[]> =>
    unwrap(setup(school).newCourses());
  const sources = (school: SchoolId): Promise<readonly SourceCourse[]> =>
    unwrap(setup(school).copySources());
  const content = (school: SchoolId, course: LmsRef<"course">): Promise<CourseContent> =>
    unwrap(setup(school).courseContent(course));
  const migrations = (school: SchoolId, course: LmsRef<"course">): Promise<readonly Migration[]> =>
    unwrap(setup(school).migrations(course));

  const shellNamed = async (school: SchoolId, code: string): Promise<CourseShell> => {
    const found = (await shells(school)).find((shell) => shell.code === code);
    if (!found) throw new Error(`No new course ${code} at ${school}.`);
    return found;
  };
  const sourceNamed = async (
    school: SchoolId,
    code: string,
    termName: string,
  ): Promise<SourceCourse> => {
    const found = (await sources(school)).find(
      (source) => source.code === code && source.termName === termName,
    );
    if (!found) throw new Error(`No source ${code} ${termName} at ${school}.`);
    return found;
  };

  /** Sends through the real runner and drives the virtual clock until it settles. */
  const send = async (ids: readonly ChangeId[]): Promise<void> => {
    const writeback = rig.newWriteback();
    await rig.clock.run(writeback.send(ids));
  };

  /** Moves the clock past a job's duration and reads it, which is what lands the content. */
  const finishJobs = async (
    school: SchoolId,
    course: LmsRef<"course">,
  ): Promise<readonly Migration[]> => {
    rig.clock.advance(10_000);
    return migrations(school, course);
  };

  const scan = async (
    school: SchoolId,
    course: LmsRef<"course">,
    plan: TermPlan,
    issues: Migration["issues"] = [],
  ): Promise<{ content: CourseContent; findings: readonly Finding[] }> => {
    const found = await content(school, course);
    return {
      content: found,
      findings: scanCourse(found, {
        plan,
        issues,
        written: [],
        contactEmail: CONTACT[school] ?? null,
      }),
    };
  };

  const fixOf = (findings: readonly Finding[], type: FindingType): TextFixContent => {
    const fix = findings.find(
      (finding) => finding.type === type && finding.fix?.kind === "text-fix",
    )?.fix;
    if (!fix || fix.kind !== "text-fix") throw new Error(`No text fix for ${type}.`);
    return fix;
  };

  const record = (id: ChangeId): ChangeRecord => {
    const found = rig.ledger.get(id);
    if (!found) throw new Error("No such change.");
    return found;
  };

  return {
    ...rig,
    setup,
    shells,
    sources,
    content,
    migrations,
    shellNamed,
    sourceNamed,
    send,
    finishJobs,
    scan,
    fixOf,
    record,
  };
};
