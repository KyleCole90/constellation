import type { Brand, ChangeId, IsoTime } from "./ids";
import type { Basis, ChangeContent, FieldKey } from "./change";

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const hash53 = (text: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
};

export type Fingerprint = Brand<string, "Fingerprint">;
export const fingerprintOf = (change: {
  content: ChangeContent;
  basis: Basis;
  landed: readonly FieldKey[];
  skipped?: readonly FieldKey[];
}): Fingerprint =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mint: a hash of the reviewed change is what the brand means
  hash53(
    canonicalJson({
      content: change.content,
      remote: change.basis.remote,
      landed: [...change.landed].sort(),
      ...(change.skipped && change.skipped.length > 0
        ? { skipped: [...change.skipped].sort() }
        : {}),
    }),
  ) as Fingerprint;

export type RiskKey = Brand<string, "RiskKey">;
export const riskKey = (students: number, items: number): RiskKey =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mint: the brand is this format
  `students:${students}|items:${items}` as RiskKey;

export interface Approval {
  changeId: ChangeId;
  fingerprint: Fingerprint;
  at: IsoTime;
  via: "button" | "batch-button" | "guarded-button";
}

export interface ApprovalTarget {
  changeId: ChangeId;
  fingerprint: Fingerprint;
  risk?: RiskKey;
}

export class ApprovalWitness {
  readonly #targets: ReadonlyMap<ChangeId, Fingerprint>;
  readonly #risks: ReadonlyMap<ChangeId, RiskKey>;
  readonly via: Approval["via"];
  private constructor(targets: readonly ApprovalTarget[]) {
    this.#targets = new Map(targets.map((t) => [t.changeId, t.fingerprint]));
    this.#risks = new Map(
      targets.flatMap((t) => (t.risk === undefined ? [] : [[t.changeId, t.risk]])),
    );
    this.via =
      this.#risks.size > 0 ? "guarded-button" : targets.length > 1 ? "batch-button" : "button";
  }
  covers(id: ChangeId, fingerprint: Fingerprint): boolean {
    return this.#targets.get(id) === fingerprint;
  }
  acknowledges(id: ChangeId, risk: RiskKey): boolean {
    return this.#risks.get(id) === risk;
  }
  static isGenuine(value: unknown): value is ApprovalWitness {
    return typeof value === "object" && value !== null && #targets in value;
  }
  static fromClick(
    click: { isTrusted: boolean; type: string },
    targets: readonly ApprovalTarget[],
  ): ApprovalWitness | null {
    if (!click.isTrusted || click.type !== "click" || targets.length === 0) return null;
    if (targets.length > 1 && targets.some((t) => t.risk !== undefined)) return null;
    return new ApprovalWitness(targets);
  }
}
