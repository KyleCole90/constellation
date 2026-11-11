import type { ContentItemType, SchoolPolicy } from "~/domain/content";
import { isoTime, type IsoDate, type IsoTime } from "~/domain/ids";
import type { TermBreak, TermDates, Weekday } from "~/domain/term";

import { SEED } from "./seed";

export interface RawLink {
  text: string;
  url: string;
}
/** An item as the LMS stores it. Links are raw here, and the provider classifies them on the way out. */
export interface RawItem {
  id: number;
  type: ContentItemType;
  slug: string;
  title: string;
  body: string;
  published: boolean;
  dueAt: IsoTime | null;
  points: number | null;
  links: RawLink[];
  copied: boolean;
  version: number;
}
export interface RawModule {
  id: number;
  title: string;
  published: boolean;
  itemCount: number;
}
export interface RawTool {
  id: number;
  name: string;
  configured: boolean;
}
export interface RawBody {
  items: RawItem[];
  modules: RawModule[];
  tools: RawTool[];
}

export interface ShellSeed {
  school: string;
  canvasId: number;
  code: string;
  title: string;
  section: string | null;
  modality: string | null;
  term: TermDates;
  students: readonly string[];
  body: RawBody;
}
export interface SourceSeed {
  school: string;
  canvasId: number;
  code: string;
  title: string;
  term: TermDates;
  template: boolean;
  body: RawBody;
}
export interface PackageIssueSeed {
  issue_type: "todo" | "warning" | "error";
  description: string;
  fixUrl: string | null;
}
export interface PackageSeed {
  name: string;
  kb: number;
  note: string;
  hint: TermDates | null;
  /** Where the package came from. Links inside still point there. */
  host: string;
  courseId: number;
  issues: readonly PackageIssueSeed[];
  /** Null for a package that cannot be read. */
  body: RawBody | null;
  damaged: boolean;
}

const date = (value: string): IsoDate => value as IsoDate;
const dueOn = (day: string): IsoTime => isoTime(`${day}T23:59:00.000Z`);
const TUE_THU: readonly Weekday[] = [2, 4];
const MON_WED: readonly Weekday[] = [1, 3];
const DAY_WORDS: Readonly<Record<Weekday, string>> = {
  0: "Sundays",
  1: "Mondays",
  2: "Tuesdays",
  3: "Wednesdays",
  4: "Thursdays",
  5: "Fridays",
  6: "Saturdays",
};

export const FALL_2026 = (days: readonly Weekday[]): TermDates => ({
  name: "Fall 2026",
  start: date("2026-08-24"),
  end: date("2026-12-11"),
  days,
});
const SPRING_2026 = (days: readonly Weekday[]): TermDates => ({
  name: "Spring 2026",
  start: date("2026-01-20"),
  end: date("2026-05-08"),
  days,
});
const SPRING_2027 = (days: readonly Weekday[]): TermDates => ({
  name: "Spring 2027",
  start: date("2027-01-19"),
  end: date("2027-05-07"),
  days,
});
export const SPRING_2027_BREAKS: readonly TermBreak[] = [
  { name: "Spring break", start: date("2027-03-08"), end: date("2027-03-12") },
];

export const HOSTS: Readonly<Record<string, string>> = Object.fromEntries(
  SEED.schools.map((school) => [school.id, school.host]),
);
const NORTHGATE_HOST = "northgate.instructure.com";

/** Where a person at each school is expected to be reached. Statements are what each school's syllabus must carry. */
export const POLICIES: Readonly<Record<string, SchoolPolicy>> = {
  lcc: {
    contactDomain: "lakeshore.edu",
    contactEmail: "kyle@lakeshore.edu",
    statements: [
      {
        name: "Accessibility statement",
        mustInclude: ["accessibility"],
        text: "Accessibility statement: Lakeshore Community College welcomes students with disabilities. If you need accommodations, contact the Accessibility Resource Center at arc@lakeshore.edu as early in the term as you can.",
      },
      {
        name: "Academic integrity",
        mustInclude: ["academic integrity"],
        text: "Academic integrity: The work you submit in this course must be your own. Using another person's words or ideas without credit, or submitting work generated for you, is a violation of the college's academic integrity policy.",
      },
    ],
  },
  rsu: {
    contactDomain: "riverbend.edu",
    contactEmail: "kyle@riverbend.edu",
    statements: [
      {
        name: "Title IX notice",
        mustInclude: ["title ix"],
        text: "Title IX notice: Riverbend State University does not tolerate discrimination or harassment on the basis of sex. Instructors are required to report disclosures to the Title IX office at titleix@riverbend.edu.",
      },
      {
        name: "Accessibility statement",
        mustInclude: ["accessibility"],
        text: "Accessibility statement: Students who need accommodations should register with Disability Services at access@riverbend.edu. Accommodations begin once the instructor receives the letter.",
      },
    ],
  },
};

/** The instructor teaches at both schools, so each school's old course carries the other school's address. */
const FOREIGN_EMAIL: Readonly<Record<string, string>> = {
  lcc: "kyle@riverbend.edu",
  rsu: "kyle@lakeshore.edu",
};

interface Dues {
  early: string;
  /** Lands inside Spring break once shifted into Spring 2027. */
  mid: string;
  /** Lands after the new term ends. */
  late: string;
}
const DUES: Readonly<Record<string, Dues>> = {
  "Fall 2026|2,4": { early: "2026-09-17", mid: "2026-10-15", late: "2026-12-15" },
  "Fall 2026|1,3": { early: "2026-09-16", mid: "2026-10-14", late: "2026-12-14" },
  "Spring 2026|2,4": { early: "2026-02-12", mid: "2026-03-10", late: "2026-05-12" },
  "Spring 2026|1,3": { early: "2026-02-11", mid: "2026-03-09", late: "2026-05-11" },
};
const SAMPLE_DATE: Readonly<Record<string, string>> = {
  "Fall 2026": "Oct 12",
  "Spring 2026": "Mar 3",
};

interface ComposeArgs {
  host: string;
  courseId: number;
  code: string;
  term: TermDates;
  /** The term before this one. A syllabus still points at its pages. */
  priorCourseId: number;
  foreign: string;
}

const MISSING_FILE_ID = 555001;
const url = (host: string, courseId: number, path: string): string =>
  `https://${host}/courses/${courseId}/${path}`;

/** One course's worth of content with every finding type planted once. Ids are unique per course by construction. */
const composeBody = ({
  host,
  courseId,
  code,
  term,
  priorCourseId,
  foreign,
}: ComposeArgs): RawBody => {
  const id = (n: number) => courseId * 100 + n;
  const dues = DUES[`${term.name}|${[...term.days].sort().join(",")}`] ?? {
    early: term.start,
    mid: term.start,
    late: term.end,
  };
  const sample = SAMPLE_DATE[term.name] ?? "Oct 12";
  const meets = term.days.map((day) => DAY_WORDS[day]).join(" and ");
  const officeDay = DAY_WORDS[term.days[0] ?? 2].replace(/s$/, "");
  const policiesUrl = url(host, priorCourseId, "pages/course-policies");
  const faqUrl = url(host, courseId, "pages/grading-faq");
  const fileUrl = url(host, courseId, `files/${MISSING_FILE_ID}`);
  const toolUrl = url(host, courseId, `external_tools/${id(90)}`);
  const item = (
    n: number,
    type: ContentItemType,
    slug: string,
    title: string,
    body: string,
    extra: Partial<RawItem> = {},
  ): RawItem => ({
    id: id(n),
    type,
    slug,
    title,
    body,
    published: true,
    dueAt: null,
    points: null,
    links: [],
    copied: false,
    version: 1,
    ...extra,
  });
  const syllabus = [
    `Welcome to ${code}, ${term.name}. This course meets ${meets} in Room 214.`,
    `Contact: email ${foreign} with questions about assignments. Allow one business day for a reply.`,
    `Office hours are ${officeDay} 2 to 3 in Hall 210, or by appointment at ${foreign}.`,
    `Essay 2 is due ${sample}. Late work loses 5 points per day.`,
    `Course policies are posted at ${policiesUrl} and the grading FAQ at ${faqUrl}. The reading list is at ${fileUrl}.`,
  ].join("\n\n");
  return {
    items: [
      item(1, "syllabus", "syllabus", "Syllabus", syllabus, {
        links: [
          { text: "Course policies", url: policiesUrl },
          { text: "grading FAQ", url: faqUrl },
          { text: "reading list", url: fileUrl },
        ],
      }),
      item(
        2,
        "page",
        "course-policies",
        "Course Policies",
        `Policies for ${term.name}. Attendance is taken at each class meeting, and two unexcused absences lower the participation grade.`,
      ),
      item(
        3,
        "page",
        "week-1-overview",
        "Week 1 Overview",
        "Read chapters 1 and 2 before our first meeting, and bring one question about each.",
        { published: false },
      ),
      item(
        4,
        "page",
        "library-research-guide",
        "Library Research Guide",
        `Start with the library reserves tool at ${toolUrl}, then search the databases by subject.`,
        { links: [{ text: "Library reserves", url: toolUrl }] },
      ),
      item(
        5,
        "announcement",
        "welcome",
        `Welcome to ${term.name}`,
        "Welcome! Read the syllabus and open the Week 1 module before our first meeting.",
      ),
      item(6, "assignment", "essay-1", "Essay 1", "A two-page narrative. Submit as a PDF.", {
        dueAt: dueOn(dues.early),
        points: 100,
      }),
      item(
        7,
        "assignment",
        "essay-2",
        "Essay 2",
        "A rhetorical analysis of an advertisement of your choosing.",
        { dueAt: dueOn(dues.mid), points: 100 },
      ),
      item(
        8,
        "assignment",
        "final-portfolio",
        "Final Portfolio",
        "Revised versions of two essays with a reflective letter.",
        { dueAt: dueOn(dues.late), points: 150 },
      ),
      item(9, "file", "syllabus-pdf", "Syllabus.pdf", ""),
    ],
    modules: [
      { id: id(80), title: "Week 1", published: true, itemCount: 3 },
      { id: id(81), title: "Week 2", published: true, itemCount: 2 },
      { id: id(82), title: "Resources", published: true, itemCount: 0 },
    ],
    tools: [{ id: id(90), name: "Library Reserves", configured: true }],
  };
};

const DAYS_BY_CODE: Readonly<Record<string, readonly Weekday[]>> = {
  "ENG 101": TUE_THU,
  "ENG 102": MON_WED,
  "COMM 110": TUE_THU,
  "ENG 210": MON_WED,
  "ENG 305": TUE_THU,
  "HUM 150": MON_WED,
};
const TEMPLATE_CODES = new Set(["ENG 101", "ENG 210"]);
/** The concluded course each Fall course descends from, so its syllabus can still point there. */
const PRIOR_IDS: Readonly<Record<number, number>> = {
  48213: 45108,
  48227: 45121,
  48240: 45133,
  12077: 11562,
  12091: 11577,
  12103: 11590,
};

const fallSources: readonly SourceSeed[] = SEED.courses.map((course) => {
  const term = FALL_2026(DAYS_BY_CODE[course.code] ?? TUE_THU);
  const host = HOSTS[course.schoolId] ?? "";
  return {
    school: course.schoolId,
    canvasId: course.canvasId,
    code: course.code,
    title: course.title,
    term,
    template: TEMPLATE_CODES.has(course.code),
    body: composeBody({
      host,
      courseId: course.canvasId,
      code: course.code,
      term,
      priorCourseId: PRIOR_IDS[course.canvasId] ?? course.canvasId,
      foreign: FOREIGN_EMAIL[course.schoolId] ?? "",
    }),
  };
});

const concluded = (
  school: string,
  canvasId: number,
  code: string,
  title: string,
  days: readonly Weekday[],
  priorCourseId: number,
): SourceSeed => {
  const term = SPRING_2026(days);
  return {
    school,
    canvasId,
    code,
    title,
    term,
    template: false,
    body: composeBody({
      host: HOSTS[school] ?? "",
      courseId: canvasId,
      code,
      term,
      priorCourseId,
      foreign: FOREIGN_EMAIL[school] ?? "",
    }),
  };
};

export const SOURCES: readonly SourceSeed[] = [
  ...fallSources,
  concluded("lcc", 45108, "ENG 101", "Composition I", TUE_THU, 41990),
  concluded("rsu", 11562, "ENG 210", "Intro to Literature", MON_WED, 10877),
];

const EMPTY: RawBody = { items: [], modules: [], tools: [] };

const HUM_150_STUDENTS = [
  "Amara Okafor",
  "Ben Castellano",
  "Chloe Nguyen",
  "Darius Webb",
  "Elena Marsh",
  "Farid Haddad",
  "Grace Lindqvist",
  "Hugo Ferreira",
  "Imani Brooks",
  "Jonas Petrov",
  "Keiko Tanaka",
  "Liam O'Rourke",
  "Maya Sandoval",
  "Nikhil Rao",
];
const hum150Body = (): RawBody => {
  const item = (
    n: number,
    type: ContentItemType,
    slug: string,
    title: string,
    body: string,
  ): RawItem => ({
    id: 1342700 + n,
    type,
    slug,
    title,
    body,
    published: true,
    dueAt: null,
    points: null,
    links: [],
    copied: false,
    version: 1,
  });
  return {
    items: [
      item(
        1,
        "syllabus",
        "syllabus",
        "Syllabus",
        "HUM 150, Spring 2027. A first draft of the syllabus. Screenings are on Mondays and discussion on Wednesdays.",
      ),
      item(
        2,
        "page",
        "reading-schedule",
        "Reading Schedule",
        "Week 1: Bazin. Week 2: Mulvey. Week 3: hooks.",
      ),
      item(
        3,
        "announcement",
        "welcome-back",
        "Welcome back",
        "The course site is open. The syllabus is a draft until the first week.",
      ),
    ],
    modules: [],
    tools: [],
  };
};

export const SHELLS: readonly ShellSeed[] = [
  {
    school: "lcc",
    canvasId: 51302,
    code: "ENG 101",
    title: "Composition I",
    section: "sec 03",
    modality: null,
    term: SPRING_2027(TUE_THU),
    students: [],
    body: EMPTY,
  },
  {
    school: "lcc",
    canvasId: 51318,
    code: "COMM 110",
    title: "Public Speaking",
    section: "sec 01",
    modality: "online",
    term: SPRING_2027(TUE_THU),
    students: [],
    body: EMPTY,
  },
  {
    school: "rsu",
    canvasId: 13410,
    code: "ENG 210",
    title: "Intro to Literature",
    section: null,
    modality: null,
    term: SPRING_2027(MON_WED),
    students: [],
    body: EMPTY,
  },
  {
    school: "rsu",
    canvasId: 13427,
    code: "HUM 150",
    title: "Film & Society",
    section: null,
    modality: "hybrid",
    term: SPRING_2027(MON_WED),
    students: HUM_150_STUDENTS,
    body: hum150Body(),
  },
];

export const PACKAGES: readonly PackageSeed[] = [
  {
    name: "comm110-lakeshore-fall2026-export.imscc",
    kb: 2840,
    note: "COMM 110 as exported from Lakeshore at the end of Fall 2026.",
    hint: FALL_2026(TUE_THU),
    host: HOSTS["lcc"] ?? "",
    courseId: 48240,
    issues: [
      {
        issue_type: "warning",
        description:
          "The external tool Library Reserves is not configured in this course, so its links were left as they were.",
        fixUrl: null,
      },
    ],
    body: composeBody({
      host: HOSTS["lcc"] ?? "",
      courseId: 48240,
      code: "COMM 110",
      term: FALL_2026(TUE_THU),
      priorCourseId: 45133,
      foreign: FOREIGN_EMAIL["lcc"] ?? "",
    }),
    damaged: false,
  },
  {
    name: "eng210-northgate-spring2026-export.imscc",
    kb: 4120,
    note: "ENG 210 from Northgate College, Spring 2026. Northgate is not connected here.",
    hint: SPRING_2026(TUE_THU),
    host: NORTHGATE_HOST,
    courseId: 7731,
    issues: [
      {
        issue_type: "warning",
        description: `Links to ${NORTHGATE_HOST} could not be rewritten and still point at the old course.`,
        fixUrl: null,
      },
      {
        issue_type: "todo",
        description:
          'The quiz "Midterm Review" needs a question bank selected before it can be published.',
        fixUrl: `https://${NORTHGATE_HOST}/courses/7731/quizzes/4410`,
      },
    ],
    body: composeBody({
      host: NORTHGATE_HOST,
      courseId: 7731,
      code: "ENG 210",
      term: SPRING_2026(TUE_THU),
      priorCourseId: 6918,
      foreign: "kyle@northgate.edu",
    }),
    damaged: false,
  },
  {
    name: "damaged-export.imscc",
    kb: 96,
    note: "A package that fails partway through, for trying the failure path.",
    hint: null,
    host: NORTHGATE_HOST,
    courseId: 0,
    issues: [],
    body: null,
    damaged: true,
  },
];

/** Canvas reports this warning when a copied course's tool is not configured. */
export const COURSE_COPY_ISSUES: readonly PackageIssueSeed[] = [
  {
    issue_type: "warning",
    description:
      "The external tool Library Reserves is not configured in the new course, so its links were left as they were.",
    fixUrl: null,
  },
];
