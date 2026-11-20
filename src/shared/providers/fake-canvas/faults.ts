import type { FieldKey, LmsError } from "~/shared/domain/change";
import type { IsoTime, LmsRef, SchoolId } from "~/shared/domain/ids";

export interface NoiseConfig {
  rate429: number;
  rate5xx: number;
  rateLost: number;
  latencyMs: readonly [min: number, max: number];
}
export const DEFAULT_NOISE: NoiseConfig = {
  rate429: 0,
  rate5xx: 0,
  rateLost: 0,
  latencyMs: [200, 900],
};
export const QUIET_NOISE: NoiseConfig = { rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [0, 0] };

export type DemoFault = "conflict" | "partial" | "throttle";
export const DEMO_FAULTS: readonly DemoFault[] = ["conflict", "partial", "throttle"];
export const DEMO_CONFLICT = {
  student: "Luis Cardenas",
  assignment: "Essay 2",
  newGrade: 65,
  by: "Jordan Pike (TA)",
};
export const DEMO_PARTIAL = {
  student: "Priya Raman",
  assignment: "Essay 2",
  field: "comment",
  error: { kind: "unavailable", status: 500 },
} as const;
export const DEMO_THROTTLE = { onWrite: 2, retryAfterMs: 3000 };

export interface WriteRecord {
  at: IsoTime;
  school: SchoolId;
  target: string;
  fields: readonly FieldKey[];
}

export interface ArmedFaults {
  failedFields: readonly FieldKey[];
  lostResponses: number;
  throttles: number;
}

export interface FaultLab {
  noise(): NoiseConfig;
  setNoise(patch: Partial<NoiseConfig>): void;
  defaultNoise(): NoiseConfig;
  resetNoise(): void;
  expireToken(school: SchoolId): void;
  changeGradeOutOfBand(submission: LmsRef<"submission">, newGrade: number, by: string): void;
  studentResubmits(submission: LmsRef<"submission">): void;
  failNextWrite(field: FieldKey, error: LmsError): void;
  loseNextResponse(applied?: boolean): void;
  lateLanding(delayMs: number): void;
  throttleNext(retryAfterMs: number, on?: "any" | "write"): void;
  holdReads(held: boolean): void;
  holdWrites(held: boolean): void;
  failNextMigration(stage: "pre_processing" | "running", message: string): void;
  enrollStudents(course: LmsRef<"course">, count: number): void;
  clearDueDates(course: LmsRef<"course">): void;
  addAssignments(course: LmsRef<"course">, titles: readonly string[]): void;
  createShell(school: SchoolId, code: string, title: string): void;
  hideTermDates(hidden: boolean): void;
  demoScript(): { enabled: boolean; fired: readonly DemoFault[] };
  setDemoScript(enabled: boolean): void;
  stored(): Promise<string | null>;
  armed(): ArmedFaults;
  writes(): readonly WriteRecord[];
  subscribe(listener: () => void): () => void;
  version(): number;
}

export type WriteLoss = { kind: "lost"; applied: boolean } | { kind: "late"; delayMs: number };

export class FaultQueue {
  noise: NoiseConfig;
  readonly #fields: { field: FieldKey; error: LmsError }[] = [];
  readonly #losses: WriteLoss[] = [];
  readonly #throttles: { retryAfterMs: number; on: "any" | "write" }[] = [];
  constructor(noise: NoiseConfig) {
    this.noise = noise;
  }
  failField(field: FieldKey, error: LmsError): void {
    this.#fields.push({ field, error });
  }
  lose(loss: WriteLoss): void {
    this.#losses.push(loss);
  }
  throttle(retryAfterMs: number, on: "any" | "write"): void {
    this.#throttles.push({ retryAfterMs, on });
  }
  armed(): ArmedFaults {
    return {
      failedFields: this.#fields.map((fault) => fault.field),
      lostResponses: this.#losses.length,
      throttles: this.#throttles.length,
    };
  }
  clear(): void {
    this.#fields.length = 0;
    this.#losses.length = 0;
    this.#throttles.length = 0;
  }
  takeField(field: FieldKey): LmsError | null {
    const index = this.#fields.findIndex((fault) => fault.field === field);
    return index < 0 ? null : (this.#fields.splice(index, 1)[0]?.error ?? null);
  }
  takeLoss(): WriteLoss | null {
    return this.#losses.shift() ?? null;
  }
  takeThrottle(kind: "read" | "write"): number | null {
    const index = this.#throttles.findIndex((fault) => fault.on === "any" || kind === "write");
    return index < 0 ? null : (this.#throttles.splice(index, 1)[0]?.retryAfterMs ?? null);
  }
}
