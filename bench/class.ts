import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { documentText } from "~/main/document-text";
import type { SubmittedFile } from "~/shared/agent/agent";
import { isoTime } from "~/shared/domain/ids";
import type {
  Assignment,
  Course,
  Submission,
  SubmissionBody,
  SubmissionFile,
} from "~/shared/domain/lms";

import { ASSIGNMENTS, SUBMISSIONS, type AuthoredSubmission } from "./fixtures/authored";
import type { FixtureKind } from "./metrics";
import { lmsRef, schoolId } from "../tests/fixtures/ids";

export interface Fixture {
  id: string;
  kind: FixtureKind;
  submission: Submission;
  assignment: Assignment;
  course: Course;
  files: SubmittedFile[];
}

const FILES = join(import.meta.dirname, "files");
const SCHOOL = schoolId("bench-school");
const SUBMITTED = isoTime("2026-11-02T15:30:00Z");
const COURSES: Record<string, string> = {
  eng10: "English 10",
  bio: "Biology",
  hist: "U.S. History",
  art: "Studio Art",
};

const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const listed = (name: string, bytes: number): SubmissionFile => ({
  id: name,
  name,
  mediaType: MEDIA_TYPES[name.split(".").at(-1) ?? ""] ?? "application/octet-stream",
  bytes,
});

const read = async (file: SubmissionFile): Promise<SubmittedFile> => {
  const data = new Uint8Array(await readFile(join(FILES, file.name)));
  if (file.mediaType === "application/pdf" || file.mediaType === "image/png")
    return { name: file.name, mediaType: file.mediaType, data };
  const text = await documentText(file.mediaType, data);
  if (!text.ok) throw new Error(`${file.name}: ${text.error}`);
  return {
    name: file.name,
    mediaType: "text/markdown",
    data: new TextEncoder().encode(text.value),
  };
};

const bodyOf = async ({ work }: AuthoredSubmission): Promise<SubmissionBody> => {
  if (work.kind === "text")
    return {
      kind: "text",
      title: "",
      wordCount: work.paragraphs.join(" ").split(/\s+/).filter(Boolean).length,
      paragraphs: work.paragraphs,
    };
  const file = listed(work.file, (await readFile(join(FILES, work.file))).byteLength);
  return work.kind === "link-screenshot"
    ? { kind: "url", title: "", url: work.url, files: [file] }
    : { kind: "upload", title: "", files: [file] };
};

const ref = <K extends string>(kind: K, key: string) => lmsRef<K>(`${kind}-${key}`);

const assignmentOf = (key: string): Assignment & { courseKey: string } => {
  const authored = ASSIGNMENTS.find((a) => a.key === key);
  if (!authored) throw new Error(`No assignment ${key}`);
  return {
    courseKey: authored.course,
    ref: ref("assignment", key),
    school: SCHOOL,
    course: ref("course", authored.course),
    title: authored.title,
    shortTitle: authored.shortTitle,
    dueAt: isoTime("2026-11-02T23:59:00Z"),
    pointsPossible: authored.pointsPossible,
    rubric: authored.rubric.map((criterion, index) => ({
      ref: ref("criterion", `${key}-${index + 1}`),
      name: criterion.name,
      maxPoints: criterion.maxPoints,
    })),
    latePointsPerDay: null,
  };
};

const courseOf = (key: string): Course => ({
  ref: ref("course", key),
  school: SCHOOL,
  code: key.toUpperCase(),
  title: COURSES[key] ?? key,
  section: "Period 3",
  modality: null,
  studentCount: 28,
});

export const loadClass = (): Promise<Fixture[]> =>
  Promise.all(
    SUBMISSIONS.map(async (authored) => {
      const { courseKey, ...assignment } = assignmentOf(authored.assignment);
      const body = await bodyOf(authored);
      const submission: Submission = {
        ref: ref("submission", authored.id),
        school: SCHOOL,
        course: assignment.course,
        assignment: assignment.ref,
        student: ref("student", authored.id),
        studentName: authored.student,
        workflow: "submitted",
        attempt: 1,
        lateDays: 0,
        submittedAt: SUBMITTED,
        grade: null,
        rubricScores: null,
        comments: [],
        body,
        page: null,
      };
      return {
        id: authored.id,
        kind: authored.work.kind,
        submission,
        assignment,
        course: courseOf(courseKey),
        files:
          body.kind === "upload" || body.kind === "url"
            ? await Promise.all(body.files.map(read))
            : [],
      };
    }),
  );
