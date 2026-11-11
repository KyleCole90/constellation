import { transition, type ChangeEvent, type ChangeRecord, type Rejection } from "~/domain/change";
import type { ChangeId, Result } from "~/domain/ids";
import type { ChangeLedger } from "~/writeback/writeback";

export interface Crash {
  /** 1-based count of accepted commits since armed. */
  atCommit: number;
  when: "before-durable" | "after-durable";
}

export class SimulatedCrash extends Error {}

/** Records live as JSON, so whatever a reload could not read back is a test failure rather than a lucky reference. */
export class DurableLedger implements ChangeLedger {
  readonly #rows = new Map<ChangeId, string>();
  #crash: Crash | null = null;
  commits = 0;

  add(record: ChangeRecord): void {
    this.#rows.set(record.id, JSON.stringify(record));
  }
  get(id: ChangeId): ChangeRecord | undefined {
    const row = this.#rows.get(id);
    return row === undefined ? undefined : (JSON.parse(row) as ChangeRecord);
  }
  all(): readonly ChangeRecord[] {
    return [...this.#rows.values()].map((row) => JSON.parse(row) as ChangeRecord);
  }
  commit(id: ChangeId, event: ChangeEvent): Result<ChangeRecord, Rejection> {
    const record = this.get(id);
    if (!record) return { ok: false, error: "not-sendable" };
    const next = transition(record, event);
    if (!next.ok) return next;
    this.commits += 1;
    const crash = this.#crash && this.commits === this.#crash.atCommit ? this.#crash : null;
    if (crash?.when === "before-durable") throw new SimulatedCrash();
    this.#rows.set(id, JSON.stringify(next.value));
    if (crash?.when === "after-durable") throw new SimulatedCrash();
    return next;
  }
  armCrash(crash: Crash | null): void {
    this.commits = 0;
    this.#crash = crash;
  }
}
