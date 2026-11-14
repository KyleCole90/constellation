import type {
  ChangeContent,
  FieldKey,
  GradeContent,
  LmsError,
  RemoteState,
} from "~/shared/domain/change";
import { finalGrade } from "~/shared/domain/change";
import type { IsoTime, LmsRef, SchoolId } from "~/shared/domain/ids";
import type { Submission } from "~/shared/domain/lms";
import { SendPermit } from "~/shared/domain/permit";
import type {
  Capabilities,
  CredentialLease,
  FieldOutcomes,
  LmsProvider,
  Read,
} from "~/shared/providers/provider";

const CAPABILITIES: Capabilities = {
  messaging: false,
  rubricWrite: false,
  attachments: false,
  excuse: false,
  commentEffect: "replace",
};
const OK = <T>(value: T): Read<T> => Promise.resolve({ ok: true, value });
const FAIL = <T>(error: LmsError): Read<T> => Promise.resolve({ ok: false, error });

/**
 * A made-up second LMS, to prove the seam fits something other than Canvas: the grade and the feedback are separate
 * requests with no transaction across them, feedback replaces the earlier text, and there is no messaging.
 */
export class SecondLmsStub {
  static readonly SCHOOL = "ksu" as SchoolId;
  static readonly COURSE = "ksu:org:6606" as LmsRef<"course">;
  static readonly ASSIGNMENT = "ksu:folder:88" as LmsRef<"assignment">;
  static readonly TARGET = "ksu:dropbox:6606:88:310" as LmsRef<"submission">;

  grade: number | null = null;
  feedback: { version: number; text: string } | null = { version: 1, text: "Earlier feedback." };
  requests: string[] = [];
  #fail = new Map<string, LmsError>();
  #lose = 0;
  #throttle: number | null = null;
  #expired = false;

  failNext(request: "grade" | "feedback", error: LmsError): void {
    this.#fail.set(request, error);
  }
  loseNext(): void {
    this.#lose += 1;
  }
  throttleNext(ms: number): void {
    this.#throttle = ms;
  }
  expire(): void {
    this.#expired = true;
  }

  #denied(): LmsError | null {
    if (this.#expired) return { kind: "auth_expired" };
    if (this.#throttle !== null) {
      const retryAfterMs = this.#throttle;
      this.#throttle = null;
      return { kind: "rate_limited", retryAfterMs };
    }
    return null;
  }

  /** One vendor request. Returns the error if it failed, null if it applied, and "lost" if it applied unconfirmed. */
  #request(name: "grade" | "feedback", content: GradeContent): LmsError | null | "lost" {
    this.requests.push(name);
    const failure = this.#denied() ?? this.#fail.get(name) ?? null;
    this.#fail.delete(name);
    if (failure) return failure;
    if (name === "grade") this.grade = finalGrade(content);
    else
      this.feedback = { version: (this.feedback?.version ?? 0) + 1, text: content.comment ?? "" };
    if (this.#lose > 0) {
      this.#lose -= 1;
      return "lost";
    }
    return null;
  }

  provider(lease: CredentialLease, now: () => number): LmsProvider {
    const at = () => new Date(now()).toISOString() as IsoTime;
    const authed = async <T>(work: () => Read<T>): Read<T> =>
      lease.use((credential) => {
        const denied: LmsError | null =
          credential === null ? { kind: "auth_expired" } : this.#denied();
        return denied ? FAIL<T>(denied) : work();
      });

    const submission = (): Submission => ({
      ref: SecondLmsStub.TARGET,
      school: SecondLmsStub.SCHOOL,
      course: SecondLmsStub.COURSE,
      assignment: SecondLmsStub.ASSIGNMENT,
      student: "ksu:user:310" as LmsRef<"student">,
      studentName: "Ana Ruiz",
      workflow: this.grade === null ? "submitted" : "graded",
      attempt: 1,
      lateDays: 0,
      submittedAt: at(),
      grade: this.grade,
      rubricScores: null,
      comments: this.feedback
        ? [{ id: `fb:${this.feedback.version}`, mine: true, text: this.feedback.text, at: at() }]
        : [],
      body: { kind: "text", title: "Paper", wordCount: 2, paragraphs: ["Two words."] },
      page: null,
    });

    return {
      vendorLabel: "Other LMS",
      capabilities: CAPABILITIES,
      verify: () => authed(() => OK({ displayName: "Instructor", scopes: ["grades:write"] })),
      file: async () => ({ ok: false, error: { kind: "not_found" } }),
      linkExport: async () => ({ ok: false, error: { kind: "not_found" } }),
      courses: () =>
        authed(() =>
          OK([
            {
              ref: SecondLmsStub.COURSE,
              school: SecondLmsStub.SCHOOL,
              code: "ENG 101",
              title: "Composition",
              section: null,
              modality: null,
              studentCount: 1,
            },
          ]),
        ),
      assignments: () =>
        authed(() =>
          OK([
            {
              ref: SecondLmsStub.ASSIGNMENT,
              school: SecondLmsStub.SCHOOL,
              course: SecondLmsStub.COURSE,
              title: "Paper",
              shortTitle: "Paper",
              dueAt: null,
              pointsPossible: 100,
              rubric: null,
              latePointsPerDay: null,
            },
          ]),
        ),
      students: () =>
        authed(() =>
          OK([
            {
              ref: "ksu:user:310" as LmsRef<"student">,
              school: SecondLmsStub.SCHOOL,
              course: SecondLmsStub.COURSE,
              name: "Ana Ruiz",
            },
          ]),
        ),
      submissions: () => authed(() => OK([submission()])),
      conversations: () => authed(() => OK([])),
      announcements: () => authed(() => OK([])),
      observe: (content: ChangeContent) =>
        authed((): Read<RemoteState> => {
          if (content.kind !== "grade")
            return FAIL({ kind: "unsupported", capability: content.kind });
          if (content.target !== SecondLmsStub.TARGET) return FAIL({ kind: "not_found" });
          // Every saved feedback gets a new version, so a replace reads as a fresh entry that `seen` does not hold.
          const comments = this.feedback
            ? [{ id: `fb:${this.feedback.version}`, mine: true, text: this.feedback.text }]
            : [];
          return OK({
            kind: "grade",
            targetVersion: "attempt:1",
            grade: this.grade,
            rubric: null,
            excused: false,
            comments,
            attachments: [],
          });
        }),
      apply: async (permit) => {
        if (!SendPermit.isGenuine(permit)) return {};
        const { content, fields } = permit;
        if (content.kind !== "grade")
          return Object.fromEntries(
            fields.map((field) => [
              field,
              { status: "failed", error: { kind: "unsupported", capability: content.kind } },
            ]),
          );
        return lease.use(async (credential) => {
          const outcomes: Partial<Record<FieldKey, FieldOutcomes[FieldKey]>> = {};
          for (const field of fields) {
            const failure: LmsError | null | "lost" =
              credential === null
                ? { kind: "auth_expired" }
                : field === "grade" || field === "comment"
                  ? this.#request(field === "grade" ? "grade" : "feedback", content)
                  : { kind: "unsupported", capability: field };
            if (failure === "lost") outcomes[field] = { status: "unknown", since: at() };
            else if (failure) outcomes[field] = { status: "failed", error: failure };
            else outcomes[field] = { status: "landed", at: at(), via: "response" };
          }
          return outcomes as FieldOutcomes;
        });
      },
      describeScope: (scope) => (scope === "grades:write" ? "Post grades" : scope),
    };
  }
}
