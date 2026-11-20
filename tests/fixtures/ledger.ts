import {
  transition,
  type ChangeEvent,
  type ChangeRecord,
  type Rejection,
} from "~/shared/domain/change";
import type { ChangeId, Result } from "~/shared/domain/ids";
import { isChange } from "~/renderer/stores/workspace";
import type { ChangeLedger } from "~/renderer/writeback/writeback";

export interface Crash {
  atCommit: number;
  when: "before-durable" | "after-durable";
}

export class SimulatedCrash extends Error {}

const reread = (row: string): ChangeRecord => {
  const record: unknown = JSON.parse(row);
  if (!isChange(record)) throw new Error("A reload would refuse this change.");
  return record;
};

export class DurableLedger implements ChangeLedger {
  readonly #rows = new Map<ChangeId, string>();
  #crash: Crash | null = null;
  commits = 0;

  add(record: ChangeRecord): void {
    this.#rows.set(record.id, JSON.stringify(record));
  }
  get(id: ChangeId): ChangeRecord | undefined {
    const row = this.#rows.get(id);
    return row === undefined ? undefined : reread(row);
  }
  all(): readonly ChangeRecord[] {
    return [...this.#rows.values()].map(reread);
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
