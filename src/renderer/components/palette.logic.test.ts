import { describe, expect, it } from "vite-plus/test";

import type { CourseShell } from "~/shared/domain/content";
import type { IsoTime, LmsRef, SchoolHost, SchoolId, ThreadId } from "~/shared/domain/ids";
import type { Course, School, Student, Submission } from "~/shared/domain/lms";
import type { ConnectionRecord, Thread } from "~/renderer/stores/types";

import { INBOX_THREAD } from "~/renderer/stores/selectors";

import { buildEntries, filterEntries } from "./palette.logic";

const school = "lcc" as SchoolId;
const course = {
  ref: "lcc:course:1" as LmsRef<"course">,
  school,
  code: "ENG 101",
  title: "Composition",
  section: null,
  modality: null,
  studentCount: 2,
} satisfies Course;
const students: readonly Student[] = [
  { ref: "s1" as LmsRef<"student">, school, course: course.ref, name: "Maya Ortiz" },
  { ref: "s2" as LmsRef<"student">, school, course: course.ref, name: "Luis Cardenas" },
];
const schoolNamed = (id: string, name: string): School => ({
  id: id as SchoolId,
  abbr: id.toUpperCase(),
  name,
  host: `${id}.example.edu` as SchoolHost,
  provider: "fake-canvas",
});
const connection = (id: string, status: ConnectionRecord["status"]): ConnectionRecord => ({
  school: id as SchoolId,
  status,
  connectedAt: null,
  accountName: null,
  scopes: [],
  lastSyncedAt: null,
  syncError: null,
});
const noSchools = { schools: [], connections: {} };
const thread: Thread & { toApprove: boolean } = {
  id: "t1" as ThreadId,
  school,
  course: course.ref,
  kind: "general",
  title: "Essay 2",
  messages: [],
  focus: null,
  updatedAt: "2026-10-30T00:00:00.000Z" as IsoTime,
  toApprove: false,
};
const submission = {
  ref: "sub" as LmsRef<"submission">,
  student: "s1" as LmsRef<"student">,
  workflow: "submitted",
} as Submission;
const entries = buildEntries({
  ...noSchools,
  threads: [thread],
  courses: [course],
  shells: [],
  students,
  submissions: [submission],
});

describe("filterEntries", () => {
  it("finds a North Star chat by its title and names it as a chat", () => {
    const chat = {
      ...thread,
      id: "t-chat" as ThreadId,
      school: null,
      course: null,
      kind: "north-star-chat" as const,
      title: "What's due this week?",
    };
    const [hit, ...others] = filterEntries(
      buildEntries({
        ...noSchools,
        threads: [chat],
        courses: [course],
        shells: [],
        students,
        submissions: [submission],
      }),
      "due this week",
    );
    expect(others).toEqual([]);
    expect(hit).toMatchObject({
      group: "Threads",
      title: "What's due this week?",
      hint: "North Star chat",
      target: { kind: "thread", id: "t-chat" },
    });
  });

  it("an empty query lists screens, threads, and courses, and leaves students out", () => {
    const groups = new Set(filterEntries(entries, "").map((entry) => entry.group));
    expect([...groups]).toEqual(["Screens", "Actions", "Threads", "Courses"]);
  });

  it("a course's gradebook and announcements are one search away", () => {
    expect(filterEntries(entries, "eng 101 gradebook").map((entry) => entry.target)).toEqual([
      { kind: "course-page", course, page: "gradebook" },
    ]);
    expect(filterEntries(entries, "announcements").map((entry) => entry.title)).toEqual([
      "ENG 101 announcements",
    ]);
  });

  it("the calendar screen is one search away", () => {
    expect(filterEntries(entries, "calendar").map((entry) => entry.target)).toEqual([
      { kind: "screen", to: "/calendar" },
    ]);
  });

  it("the thread behind the inbox never shows up as a thread", () => {
    const withInbox = buildEntries({
      ...noSchools,
      threads: [{ ...thread, id: INBOX_THREAD, title: "Messages" }],
      courses: [],
      shells: [],
      students: [],
      submissions: [],
    });
    expect(withInbox.filter((entry) => entry.group === "Threads")).toEqual([]);
  });

  it("a name finds the student, whichever word is typed first", () => {
    expect(filterEntries(entries, "ortiz maya").map((entry) => entry.title)).toEqual([
      "Maya Ortiz",
    ]);
  });

  it("a student with work waiting carries the submission, and one without does not", () => {
    const target = (name: string) => entries.find((entry) => entry.title === name)?.target;
    expect(target("Maya Ortiz")).toMatchObject({ kind: "student", submission });
    expect(target("Luis Cardenas")).toMatchObject({ kind: "student", submission: null });
  });

  it.each(["spring", "setup", "set up", "Set Up"])(
    "%s finds a new-term course to set up",
    (query) => {
      const shell = {
        ...course,
        ref: "lcc:course:2" as LmsRef<"course">,
        termName: "Spring 2027",
        startAt: null,
        endAt: null,
        itemCount: 0,
        copyTarget: "m" as LmsRef<"migrations">,
        stateTarget: "s" as LmsRef<"course-state">,
      } satisfies CourseShell;
      const withShell = buildEntries({
        ...noSchools,
        threads: [],
        courses: [],
        shells: [shell],
        students: [],
        submissions: [],
      });
      expect(filterEntries(withShell, query)).toEqual([
        expect.objectContaining({
          group: "Courses",
          title: "ENG 101 Composition",
          hint: "Spring 2027 setup",
          target: { kind: "setup", course: shell.ref },
        }),
      ]);
    },
  );

  it("caps each group, so a common word cannot bury the others", () => {
    const many = buildEntries({
      ...noSchools,
      threads: Array.from({ length: 20 }, (_, i) => ({ ...thread, id: `t${i}` as ThreadId })),
      courses: [course],
      shells: [],
      students: [],
      submissions: [],
    });
    expect(filterEntries(many, "essay")).toHaveLength(6);
  });

  it("eng101, typed without the space, finds the ENG 101 course first", () => {
    expect(filterEntries(entries, "eng101")[0]?.target).toEqual({ kind: "course", course });
  });

  it("a short word matches word starts only, not the middle of a name", () => {
    const titles = (query: string) => filterEntries(entries, query).map((entry) => entry.title);
    expect(titles("ca")).toContain("Luis Cardenas");
    expect(titles("as")).not.toContain("Luis Cardenas");
  });

  it("sync lists one Sync entry per connected school, none for disconnected or expired", () => {
    const withSchools = buildEntries({
      threads: [],
      courses: [],
      shells: [],
      students: [],
      submissions: [],
      schools: [
        schoolNamed("lcc", "Lansing CC"),
        schoolNamed("wmu", "Western Michigan"),
        schoolNamed("gvsu", "Grand Valley"),
      ],
      connections: {
        ["lcc" as SchoolId]: connection("lcc", "connected"),
        ["wmu" as SchoolId]: connection("wmu", "disconnected"),
        ["gvsu" as SchoolId]: connection("gvsu", "expired"),
      },
    });
    expect(filterEntries(withSchools, "sync")).toEqual([
      expect.objectContaining({
        group: "Actions",
        title: "Sync Lansing CC",
        target: { kind: "sync", school: "lcc" },
      }),
    ]);
  });

  it("a thread awaiting approval says so, and approve finds it", () => {
    const awaiting = buildEntries({
      ...noSchools,
      threads: [thread, { ...thread, id: "t2" as ThreadId, title: "Reminder", toApprove: true }],
      courses: [course],
      shells: [],
      students: [],
      submissions: [],
    });
    expect(filterEntries(awaiting, "approve")).toEqual([
      expect.objectContaining({
        group: "Threads",
        title: "Reminder",
        hint: "ENG 101, to approve",
        target: { kind: "thread", id: "t2" },
      }),
    ]);
  });

  it("a whole word or word start outranks a match mid-word, within and across groups", () => {
    const ranked = buildEntries({
      ...noSchools,
      threads: [{ ...thread, title: "Notes on Ortizville" }],
      courses: [course],
      shells: [],
      students: [
        { ref: "s3" as LmsRef<"student">, school, course: course.ref, name: "Bo Shortiz" },
        ...students,
      ],
      submissions: [],
    });
    expect(filterEntries(ranked, "ortiz").map((entry) => entry.title)).toEqual([
      "Maya Ortiz",
      "Bo Shortiz",
      "Notes on Ortizville",
    ]);
  });
});
