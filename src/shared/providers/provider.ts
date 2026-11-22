import type {
  AttachmentDraft,
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

export const fewAtATime = async <T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = [];
  const queue = items.entries();
  const worker = async () => {
    for (const [index, item] of queue) out[index] = await work(item);
  };
  await Promise.all([worker(), worker()]);
  return out;
};

export interface Capabilities {
  messaging: boolean;
  rubricWrite: boolean;
  attachments: boolean;
  excuse: boolean;
  commentEffect: CommentEffect;
}

export interface AccountInfo {
  displayName: string;
  usedPermissions: readonly string[];
}

export type FieldOutcome = Exclude<FieldRun, { status: "pending" }>;
export type FieldOutcomes = Readonly<Partial<Record<FieldKey, FieldOutcome>>>;

export interface LmsProvider {
  readonly vendorLabel: string;
  readonly capabilities: Capabilities;
  verify(): Read<AccountInfo>;
  courses(): Read<readonly Course[]>;
  assignments(course: LmsRef<"course">): Read<readonly Assignment[]>;
  students(course: LmsRef<"course">): Read<readonly Student[]>;
  submissions(course: LmsRef<"course">): Read<readonly Submission[]>;
  file(submission: LmsRef<"submission">, file: string): Read<FileContent>;
  linkExport(submission: LmsRef<"submission">): Read<FileContent>;
  conversations(): Read<readonly Conversation[]>;
  announcements(course: LmsRef<"course">): Read<readonly Announcement[]>;
  observe(content: ChangeContent): Read<RemoteState>;
  apply(permit: SendPermit): Promise<FieldOutcomes>;
  pickAttachment?(submission: LmsRef<"submission">): Read<AttachmentDraft | null>;
  describeScope(scope: string): string;
  readonly termSetup?: TermSetup;
}

export interface TermSetup {
  newCourses(): Read<readonly CourseShell[]>;
  copySources(): Read<readonly SourceCourse[]>;
  courseContent(course: LmsRef<"course">): Read<CourseContent>;
  migrations(course: LmsRef<"course">): Read<readonly Migration[]>;
  samplePackages(): Read<readonly SamplePackage[]>;
  pickPackage?(): Read<PickedPackage | null>;
}

const plaintext = new WeakMap<Secret, string>();
export class Secret {
  declare private readonly nominal: never;
  constructor(raw: string) {
    plaintext.set(this, raw);
  }
  toString = () => "[secret]";
  toJSON = () => "[secret]";
}
export const revealSecret = <T>(secret: Secret, use: (raw: string) => T): T => {
  const raw = plaintext.get(secret);
  if (raw === undefined) throw new Error("not a Secret");
  return use(raw);
};
export const isBlankSecret = (secret: Secret): boolean =>
  revealSecret(secret, (raw) => raw.trim() === "");

export interface SecretRefusal {
  message: string;
  wrongSecret: boolean;
}

export type Credential =
  | { kind: "bearer"; token: Secret }
  | {
      kind: "oauth2";
      access: Secret;
      refresh: Secret | null;
      expiresAt: IsoTime;
      scopes: readonly string[];
    };

export interface CredentialLease {
  use<T>(work: (credential: Credential | null) => Promise<T>): Promise<T>;
  replace(next: Credential): Promise<void>;
}

export type VaultKey = SchoolId | "ai-key";
export interface Vault {
  enroll(key: VaultKey, credential: Credential): Promise<void>;
  has(key: VaultKey): Promise<boolean>;
  keys(): Promise<readonly VaultKey[]>;
  forget(key: VaultKey): Promise<void>;
  forgetAll(): Promise<void>;
  leaseFor(key: VaultKey): CredentialLease;
}

type Enrollment =
  | {
      kind: "paste-token";
      fieldLabel: string;
      steps: readonly string[];
      validate(raw: string): string | null;
      addressPlaceholder: string;
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
