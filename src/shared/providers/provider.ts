import type {
  ChangeContent,
  FieldKey,
  FieldRun,
  LmsError,
  RemoteState,
} from "~/shared/domain/change";
import type { Result, SchoolHost, SchoolId, LmsRef, IsoTime } from "~/shared/domain/ids";
import type {
  CourseContent,
  CourseShell,
  Migration,
  PickedPackage,
  SamplePackage,
  SourceCourse,
} from "~/shared/domain/content";
import type {
  Announcement,
  Assignment,
  Conversation,
  Course,
  School,
  Student,
  FileContent,
  Submission,
} from "~/shared/domain/lms";
import type { SendPermit } from "~/shared/domain/permit";
import type { CommentEffect } from "~/shared/domain/preview";

export type Read<T> = Promise<Result<T, LmsError>>;

export interface Capabilities {
  /** False hides the inbox for this school. */
  messaging: boolean;
  rubricWrite: boolean;
  attachments: boolean;
  /** Canvas `submission[excuse]`. False hides Excuse on missing work. */
  excuse: boolean;
  /** Canvas adds a comment. Another LMS may replace earlier feedback, so the preview has to say whether it stays. */
  commentEffect: CommentEffect;
}

export interface AccountInfo {
  displayName: string;
  scopes: readonly string[];
}

type FieldOutcome = Exclude<FieldRun, { status: "pending" }>;
export type FieldOutcomes = Readonly<Partial<Record<FieldKey, FieldOutcome>>>;

/**
 * One instance per school. A provider reports facts and carries out writes. It holds no retry, backoff,
 * conflict, or duplicate logic, because the writeback runner and `classify` own those once.
 *
 * Contract, checked by runProviderContract against every provider:
 * - Reads return whole lists. Paging and id encoding stay inside.
 * - `observe` is read-only and reflects every landed write, including one whose response was lost.
 *   Every saved comment gets a new entry id, even on a vendor that replaces feedback, because that id is how a retry recognizes its own write.
 * - `apply` writes exactly `permit.fields`, in however many requests the vendor needs, and reports per field.
 *   A failed field did not land. A field it cannot vouch for is `unknown`. It never sleeps on a 429 and never throws.
 * - `apply` refuses anything that is not a genuine SendPermit before doing any work.
 */
export interface LmsProvider {
  readonly vendorLabel: string;
  readonly capabilities: Capabilities;
  verify(): Read<AccountInfo>;
  courses(): Read<readonly Course[]>;
  assignments(course: LmsRef<"course">): Read<readonly Assignment[]>;
  students(course: LmsRef<"course">): Read<readonly Student[]>;
  submissions(course: LmsRef<"course">): Read<readonly Submission[]>;
  /** One file a submission lists in its body, by its id there. Refuses a file the submission doesn't list. */
  file(submission: LmsRef<"submission">, file: string): Read<FileContent>;
  /**
   * The PDF export of the public Google file a link submission points at (`googleExportOf`), read with no credentials.
   * The link is the one the LMS holds, never one the caller passes. Refuses any other link, and a file that isn't public.
   */
  linkExport(submission: LmsRef<"submission">): Read<FileContent>;
  conversations(): Read<readonly Conversation[]>;
  announcements(course: LmsRef<"course">): Read<readonly Announcement[]>;
  observe(content: ChangeContent): Read<RemoteState>;
  apply(permit: SendPermit): Promise<FieldOutcomes>;
  /** A permission in words a teacher reads. Pure, and needs no network. */
  describeScope(scope: string): string;
  /** Absent means this LMS offers no new-term setup, and the app never shows the offer for its schools. */
  readonly termSetup?: TermSetup;
}

/**
 * Reads for setting up a new term. All read-only. The copy itself and every fix go through `observe` and `apply`
 * as changes, so no second write path exists.
 * - `newCourses` lists shells `courses()` leaves out: unpublished, with a start date still ahead.
 * - `migrations` lists every job on a course, newest last, each with its progress and issues read in.
 * - Link classification inside `courseContent` is the provider's, because URL grammar is vendor knowledge.
 */
export interface TermSetup {
  newCourses(): Read<readonly CourseShell[]>;
  copySources(): Read<readonly SourceCourse[]>;
  courseContent(course: LmsRef<"course">): Read<CourseContent>;
  migrations(course: LmsRef<"course">): Read<readonly Migration[]>;
  samplePackages(): Read<readonly SamplePackage[]>;
  /**
   * Opens main's file picker for a package. Present only where main reads the file itself, a real school in the
   * desktop app; elsewhere the page's own file input names the package.
   */
  pickPackage?(): Read<PickedPackage | null>;
}

// A WeakMap rather than a # field, because devtools prints # fields when an object is logged.
const plaintext = new WeakMap<Secret, string>();
export class Secret {
  constructor(raw: string) {
    plaintext.set(this, raw);
  }
  toString = () => "[secret]";
  toJSON = () => "[secret]";
}
export const revealSecret = <T>(secret: Secret, use: (raw: string) => T): T =>
  use(plaintext.get(secret) as string);
export const isBlankSecret = (secret: Secret): boolean =>
  revealSecret(secret, (raw) => raw.trim() === "");

export type Credential =
  | { kind: "bearer"; token: Secret }
  | {
      kind: "oauth2";
      access: Secret;
      refresh: Secret | null;
      expiresAt: IsoTime;
      scopes: readonly string[];
    };

/** All a provider holds. It decrypts per use, so no long-lived plaintext sits on the provider. */
export interface CredentialLease {
  use<T>(work: (credential: Credential | null) => Promise<T>): Promise<T>;
  replace(next: Credential): Promise<void>;
}

export type VaultKey = SchoolId | "ai-key";
/**
 * Browser impl: AES-GCM ciphertext and a non-extractable CryptoKey in IndexedDB, so a reload stays connected
 * while localStorage, logs, and exports never hold the token. Same-origin script can still ask it to decrypt.
 * Nothing but a provider lease can read a credential back. Settings can only enroll, check, and forget.
 */
export interface Vault {
  enroll(key: VaultKey, credential: Credential): Promise<void>;
  has(key: VaultKey): Promise<boolean>;
  /** Which entries exist. Never their contents. */
  keys(): Promise<readonly VaultKey[]>;
  forget(key: VaultKey): Promise<void>;
  forgetAll(): Promise<void>;
  leaseFor(key: VaultKey): CredentialLease;
}

// ---- Plugging in a vendor. The onboarding screen renders this and has no vendor branch. ----

type Enrollment =
  | {
      kind: "paste-token";
      fieldLabel: string;
      steps: readonly string[];
      validate(raw: string): string | null;
      /** An example address for the add-a-school field. */
      addressPlaceholder: string;
      /** Where this vendor issues a personal token for that school. */
      tokenPageUrl(host: SchoolHost): string;
    }
  | {
      kind: "redirect";
      authorizeUrl(state: string): string;
      scopes: readonly string[];
      finish(callback: URLSearchParams): Promise<Result<Credential, LmsError>>;
    };

export interface ProviderDescriptor {
  kind: School["provider"];
  label: string;
  enrollment: Enrollment;
  create(args: { school: School; lease: CredentialLease }): LmsProvider;
}
