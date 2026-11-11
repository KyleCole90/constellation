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

/** cyrb53: sync, and well distributed for integrity checks. Not cryptographic, as the note on Fingerprint says. */
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

/** Integrity of what was reviewed, not a security boundary. Sync, so a render can carry it. */
export type Fingerprint = string & { readonly __brand: "Fingerprint" };
export const fingerprintOf = (change: {
  content: ChangeContent;
  basis: Basis;
  landed: readonly FieldKey[];
}): Fingerprint =>
  hash53(
    canonicalJson({
      content: change.content,
      remote: change.basis.remote,
      landed: [...change.landed].sort(),
    }),
  ) as Fingerprint;

/** What a person must face before a risky change is approved, as in `students:14|items:3`. Read from the basis, so the fingerprint already covers it. */
export type RiskKey = Brand<string, "RiskKey">;

export interface Approval {
  changeId: ChangeId;
  fingerprint: Fingerprint;
  at: IsoTime;
  via: "button" | "batch-button" | "guarded-button" | "chord";
}

export interface ApprovalTarget {
  changeId: ChangeId;
  fingerprint: Fingerprint;
  risk?: RiskKey;
}

/**
 * Proof that a person clicked a button showing exactly these changes. The # field makes it impossible to
 * build by cast or JSON copy, and `isTrusted` cannot be set by script, so a tool driving the DOM mints nothing.
 * Enter or Space on the focused button is a trusted click too, on purpose: it is still a person pressing this button, and the button has to work without a mouse.
 * Carrying fingerprints means an edit that wins a race makes the click stale rather than approving newer text.
 * A risky target rides alone: the click that acknowledges a risk must be about that one change.
 */
export class ApprovalWitness {
  readonly #targets: ReadonlyMap<ChangeId, Fingerprint>;
  readonly #risks: ReadonlyMap<ChangeId, RiskKey>;
  readonly via: Approval["via"];
  private constructor(targets: readonly ApprovalTarget[], chord = false) {
    this.#targets = new Map(targets.map((t) => [t.changeId, t.fingerprint]));
    this.#risks = new Map(
      targets.flatMap((t) => (t.risk === undefined ? [] : [[t.changeId, t.risk]])),
    );
    this.via = chord
      ? "chord"
      : this.#risks.size > 0
        ? "guarded-button"
        : targets.length > 1
          ? "batch-button"
          : "button";
  }
  covers(id: ChangeId, fingerprint: Fingerprint): boolean {
    return this.#targets.get(id) === fingerprint;
  }
  acknowledges(id: ChangeId, risk: RiskKey): boolean {
    return this.#risks.get(id) === risk;
  }
  /** Lets `transition` reject casts, JSON copies, and prototype spoofs. Holds no minting power. */
  static isGenuine(value: unknown): value is ApprovalWitness {
    return typeof value === "object" && value !== null && #targets in value;
  }
  /** Only ApproveButton may import this. A structure test fails the build otherwise. */
  static fromClick(
    click: { isTrusted: boolean; type: string },
    targets: readonly ApprovalTarget[],
  ): ApprovalWitness | null {
    if (!click.isTrusted || click.type !== "click" || targets.length === 0) return null;
    if (targets.length > 1 && targets.some((t) => t.risk !== undefined)) return null;
    return new ApprovalWitness(targets);
  }
  /**
   * ⌘↵ on one grade that only you have edited. It is still a person pressing a key. `transition` refuses it for
   * anything an agent touched, so an AI draft still needs the button. A held chord repeats, so a repeat mints nothing.
   */
  static fromChord(
    press: {
      isTrusted: boolean;
      type: string;
      key: string;
      repeat: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
    },
    target: ApprovalTarget,
  ): ApprovalWitness | null {
    if (!press.isTrusted || press.type !== "keydown" || press.key !== "Enter" || press.repeat)
      return null;
    if (!(press.metaKey || press.ctrlKey) || target.risk !== undefined) return null;
    return new ApprovalWitness([target], true);
  }
}
