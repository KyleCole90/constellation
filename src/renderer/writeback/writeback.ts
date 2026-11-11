import {
  classify,
  errorWords,
  fieldsOf,
  seenForFirstSend,
  seenOf,
  type ChangeEvent,
  type ChangeRecord,
  type FieldConflict,
  type FieldKey,
  type FieldRun,
  type LmsError,
  type Rejection,
  type Seen,
  type SendRun,
} from "~/shared/domain/change";
import { isoTime, type ChangeId, type Result, type SchoolId } from "~/shared/domain/ids";
import { mintSendPermit } from "~/shared/domain/permit";
import type { FieldOutcomes, LmsProvider, Read } from "~/shared/providers/provider";

/** Sole writer of changes. `commit` applies transition and is durable before it returns, so no request leaves unrecorded. */
export interface ChangeLedger {
  get(id: ChangeId): ChangeRecord | undefined;
  all(): readonly ChangeRecord[];
  commit(id: ChangeId, event: ChangeEvent): Result<ChangeRecord, Rejection>;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** How long a lost response gets to land before a read can call the field absent. */
  settleMs: number;
}

export interface WritebackDeps {
  ledger: ChangeLedger;
  providerFor(school: SchoolId): LmsProvider | null;
  markExpired(school: SchoolId): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  policy: RetryPolicy;
  /** Defaults to navigator.locks when the runtime has it. Null turns locking off. */
  locks?: Pick<LockManager, "request"> | null;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 800,
  maxDelayMs: 8000,
  settleMs: 2500,
};

export type RunResult =
  | { id: ChangeId; state: ChangeRecord["state"]["tag"] }
  | { id: ChangeId; refused: "not-sendable" | "no-connection" };

/**
 * One attempt, and the only code path for first send, retry, and resume:
 *   observe, then classify every field.
 *   Any conflict: write nothing, go to `conflicted`.
 *   Fields already there: mark landed, via observed.
 *   Remaining fields: durable `begin-send`, mint a permit, provider.apply, durable per-field outcomes.
 * A 429 pauses that school's lane and spends no attempt. An expired token holds the change and closes the lane.
 * A lost response waits settleMs and then only reads. If that read cannot confirm, it rests in held in-doubt.
 */
export interface Writeback {
  /** Serial per school with a shared pause, parallel across schools. One outcome per id. */
  send(
    ids: readonly ChangeId[],
    onItem?: (result: RunResult) => void,
  ): Promise<readonly RunResult[]>;
  /** Boot step. It reads and never writes: a `sending` change becomes held interrupted, with landed fields marked. */
  recover(): Promise<void>;
  /** Read-only: a held change marks fields it can see in the LMS as landed, and finishes if nothing is left. Writes nothing. */
  check(id: ChangeId): Promise<Result<ChangeRecord, LmsError>>;
  laneStatus(
    school: SchoolId,
  ):
    | { state: "open" }
    | { state: "paused"; until: number; reason: "rate-limited" }
    | { state: "closed"; reason: "reconnect" };
  /** Reconnecting reopens the lane. Held and approved changes wait for the next send. */
  reopen(school: SchoolId): void;
  /** A read that shares the lane's pause: a 429 pauses the lane and retries, and anything else comes back as is. */
  laneRead<T>(school: SchoolId, read: () => Read<T>): Read<T>;
}

interface Lane {
  closed: boolean;
  pausedUntil: number;
  tail: Promise<unknown>;
}

const landedIn = (run: SendRun | null, field: FieldKey): boolean =>
  run?.fields[field]?.status === "landed";
const runOf = (record: ChangeRecord): SendRun | null =>
  record.state.tag === "sending" || (record.state.tag === "held" && record.state.run.attempt > 0)
    ? record.state.run
    : null;

export const createWriteback = (deps: WritebackDeps): Writeback => {
  const { ledger, policy } = deps;
  const lanes = new Map<SchoolId, Lane>();
  const locks =
    deps.locks === undefined
      ? typeof navigator === "undefined"
        ? null
        : (navigator.locks ?? null)
      : deps.locks;

  const laneOf = (school: SchoolId): Lane => {
    const existing = lanes.get(school);
    if (existing) return existing;
    const lane: Lane = { closed: false, pausedUntil: 0, tail: Promise.resolve() };
    lanes.set(school, lane);
    return lane;
  };
  const at = () => isoTime(deps.now());

  const pause = (lane: Lane, retryAfterMs: number | null): void => {
    lane.pausedUntil = Math.max(
      lane.pausedUntil,
      deps.now() + (retryAfterMs ?? policy.baseDelayMs),
    );
  };

  const waitOutPause = async (lane: Lane, id: ChangeId | null): Promise<void> => {
    while (deps.now() < lane.pausedUntil) {
      if (id && ledger.get(id)?.state.tag === "sending")
        ledger.commit(id, { type: "wait", until: lane.pausedUntil });
      await deps.sleep(lane.pausedUntil - deps.now());
    }
  };

  const backoffMs = (failures: number): number => {
    const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failures - 1));
    return ceiling / 2 + (deps.random() * ceiling) / 2;
  };

  const closeLane = (lane: Lane, school: SchoolId): void => {
    lane.closed = true;
    deps.markExpired(school);
  };

  /** What to do about one error, shared by observe and apply. `null` means a retry has been arranged. */
  const holdFor = (
    error: LmsError,
    failures: number,
  ): Extract<ChangeEvent, { type: "hold" }>["cause"] | null => {
    switch (error.kind) {
      case "auth_expired":
        return { tag: "reconnect" };
      case "forbidden":
        return { tag: "forbidden", missingScope: error.missingScope };
      case "rejected":
        return { tag: "rejected", reason: error.reason };
      // Trying again gets the same answer, so these go to a person the way a refusal does.
      case "not_found":
      case "unsupported":
        return { tag: "rejected", reason: errorWords(error) };
      case "rate_limited":
        return null;
      case "unavailable":
      case "lost_response":
        return failures >= policy.maxAttempts
          ? { tag: "failed", error, retriesExhausted: true }
          : null;
    }
  };

  const remainingFields = (record: ChangeRecord): readonly FieldKey[] => {
    const run = runOf(record);
    return fieldsOf(record.content).filter(
      (field) => !record.landed.includes(field) && !landedIn(run, field),
    );
  };

  /**
   * One Lane entry. Loops until the change rests. A rejected commit means another writer moved the change, and
   * that writer's state is the truth, so the loop stops there. A throw from the ledger is a crash, not an error
   * to handle: it propagates, and `recover` picks the change up from whatever became durable.
   */
  const drive = async (id: ChangeId, provider: LmsProvider, lane: Lane): Promise<void> => {
    let failures = 0;

    const onError = async (error: LmsError, school: SchoolId): Promise<boolean> => {
      if (error.kind === "rate_limited") {
        pause(lane, error.retryAfterMs);
        return true;
      }
      if (error.kind === "unavailable" || error.kind === "lost_response") failures += 1;
      const cause = holdFor(error, failures);
      if (cause) {
        ledger.commit(id, { type: "hold", cause, at: at() });
        if (error.kind === "auth_expired") closeLane(lane, school);
        return false;
      }
      const delay = backoffMs(failures);
      ledger.commit(id, { type: "wait", until: deps.now() + delay });
      await deps.sleep(delay);
      return true;
    };

    for (;;) {
      await waitOutPause(lane, id);
      const record = ledger.get(id);
      if (!record) return;

      const observed = await provider.observe(record.content);
      if (!observed.ok) {
        if (await onError(observed.error, record.school)) continue;
        return;
      }
      const remote = observed.value;
      const seen = record.seen ?? seenForFirstSend(ledger.all(), record.content, remote);
      const decisions = classify(record.content, record.basis, remote, seen);
      const remaining = remainingFields(record);

      const conflicts = remaining.flatMap((field): readonly FieldConflict[] => {
        const decision = decisions[field];
        return decision?.do === "conflict" ? [decision.conflict] : [];
      });
      if (conflicts.length > 0) {
        ledger.commit(id, { type: "conflict", conflicts, at: at() });
        return;
      }

      // Durable before any request leaves, so a reload always finds out a send may have happened.
      if (
        record.state.tag !== "sending" &&
        !ledger.commit(id, { type: "begin-send", seen, at: at() }).ok
      )
        return;

      const present = remaining.filter((field) => decisions[field]?.do === "already-there");
      if (present.length > 0)
        ledger.commit(id, {
          type: "field-outcomes",
          outcomes: observedOutcomes(present),
          at: at(),
        });

      const toWrite = remaining.filter((field) => decisions[field]?.do === "write");
      if (toWrite.length === 0) {
        ledger.commit(id, { type: "finish", at: at() });
        return;
      }

      const sending = ledger.get(id);
      const permit = sending && mintSendPermit(sending, toWrite);
      if (!permit) return;
      const outcomes = await provider.apply(permit);
      ledger.commit(id, { type: "field-outcomes", outcomes, at: at() });

      const statuses = toWrite.map((field) => outcomes[field]);
      if (statuses.some((outcome) => outcome?.status === "unknown")) {
        const settled = await settle(id, provider, lane, seen);
        if (!settled) return;
      }
      const landedSome = statuses.some((outcome) => outcome?.status === "landed");
      const failure = firstError(outcomes);
      if (!failure) {
        const current = ledger.get(id);
        if (current && remainingFields(current).length > 0) {
          // A provider that skipped a field broke its contract. Rest it where a person can see it, never in `sending`.
          ledger.commit(id, {
            type: "hold",
            cause: {
              tag: "failed",
              error: { kind: "unavailable", status: null },
              retriesExhausted: false,
            },
            at: at(),
          });
          return;
        }
        ledger.commit(id, { type: "finish", at: at() });
        return;
      }
      // A 5xx after some fields landed goes to a person: they should see "partly sent" before anything is retried.
      if (landedSome && failure.kind !== "rate_limited") {
        const cause = holdFor(failure, 0) ?? {
          tag: "failed",
          error: failure,
          retriesExhausted: false,
        };
        ledger.commit(id, { type: "hold", cause, at: at() });
        if (failure.kind === "auth_expired") closeLane(lane, record.school);
        return;
      }
      if (!(await onError(failure, record.school))) return;
    }
  };

  const observedOutcomes = (fields: readonly FieldKey[]): FieldOutcomes => {
    const landed: Extract<FieldRun, { status: "landed" }> = {
      status: "landed",
      at: at(),
      via: "observed",
    };
    return Object.fromEntries(fields.map((field) => [field, landed]));
  };

  const firstError = (outcomes: FieldOutcomes): LmsError | null => {
    for (const outcome of Object.values(outcomes))
      if (outcome.status === "failed") return outcome.error;
    return null;
  };

  /** Read only, after giving a lost response time to land. Returns false once the change has come to rest in a hold. */
  const settle = async (
    id: ChangeId,
    provider: LmsProvider,
    lane: Lane,
    seen: Seen,
  ): Promise<boolean> => {
    await deps.sleep(policy.settleMs);
    const inDoubt = (): false => {
      ledger.commit(id, { type: "hold", cause: { tag: "in-doubt", since: at() }, at: at() });
      return false;
    };
    for (;;) {
      await waitOutPause(lane, id);
      const record = ledger.get(id);
      if (!record) return false;
      const observed = await provider.observe(record.content);
      if (!observed.ok) {
        if (observed.error.kind === "rate_limited") {
          pause(lane, observed.error.retryAfterMs);
          continue;
        }
        if (observed.error.kind === "auth_expired") {
          ledger.commit(id, { type: "hold", cause: { tag: "reconnect" }, at: at() });
          closeLane(lane, record.school);
          return false;
        }
        return inDoubt();
      }
      const fields = fieldsWith(record, "unknown");
      const decisions = classify(record.content, record.basis, observed.value, seen);
      const confirmed = fields.filter((field) => decisions[field]?.do === "already-there");
      if (confirmed.length > 0)
        ledger.commit(id, {
          type: "field-outcomes",
          outcomes: observedOutcomes(confirmed),
          at: at(),
        });
      return confirmed.length === fields.length || inDoubt();
    }
  };

  const fieldsWith = (record: ChangeRecord, status: FieldRun["status"]): readonly FieldKey[] => {
    const run = runOf(record);
    return fieldsOf(record.content).filter((field) => run?.fields[field]?.status === status);
  };

  const withLock = async <T>(id: ChangeId, work: () => Promise<T>): Promise<T> =>
    locks ? locks.request(`lms-send:${id}`, work) : work();

  const runOne = async (id: ChangeId, school: SchoolId, lane: Lane): Promise<RunResult> => {
    if (lane.closed) return { id, state: ledger.get(id)?.state.tag ?? "discarded" };
    const provider = deps.providerFor(school);
    if (!provider) return { id, refused: "no-connection" };
    return withLock(id, async () => {
      // Read inside the lock: another tab may have finished this change while we waited for it.
      const record = ledger.get(id);
      if (!record || (record.state.tag !== "approved" && record.state.tag !== "held"))
        return { id, refused: "not-sendable" };
      await drive(id, provider, lane);
      return { id, state: ledger.get(id)?.state.tag ?? "discarded" };
    });
  };

  const recoverOne = async (record: ChangeRecord): Promise<void> => {
    const { id, school } = record;
    const provider = deps.providerFor(school);
    const markUnconfirmed = () => {
      const pending = fieldsWith(record, "pending");
      if (pending.length > 0)
        ledger.commit(id, {
          type: "field-outcomes",
          outcomes: Object.fromEntries(
            pending.map((field) => [field, { status: "unknown", since: at() } as const]),
          ),
          at: at(),
        });
    };
    if (!provider) {
      markUnconfirmed();
      ledger.commit(id, { type: "interrupt", at: at() });
      return;
    }
    const observed = await provider.observe(record.content);
    if (!observed.ok) {
      if (observed.error.kind === "auth_expired") closeLane(laneOf(school), school);
      markUnconfirmed();
      ledger.commit(id, { type: "interrupt", at: at() });
      return;
    }
    const decisions = classify(
      record.content,
      record.basis,
      observed.value,
      record.seen ?? seenOf(observed.value),
    );
    const remaining = remainingFields(record);
    const present = remaining.filter((field) => decisions[field]?.do === "already-there");
    if (present.length > 0)
      ledger.commit(id, { type: "field-outcomes", outcomes: observedOutcomes(present), at: at() });
    ledger.commit(
      id,
      present.length === remaining.length
        ? { type: "finish", at: at() }
        : { type: "interrupt", at: at() },
    );
  };

  return {
    send: async (ids, onItem) => {
      const unique = [...new Set(ids)];
      const finish = (result: RunResult): RunResult => {
        onItem?.(result);
        return result;
      };
      const results = await Promise.all(
        unique.map((id) => {
          const record = ledger.get(id);
          if (!record) return Promise.resolve(finish({ id, refused: "not-sendable" }));
          const lane = laneOf(record.school);
          const run = lane.tail.then(() => runOne(id, record.school, lane)).then(finish);
          // A crash in one change rejects its own promise. The lane itself has to keep going for later sends.
          lane.tail = run.catch(() => undefined);
          return run;
        }),
      );
      return results;
    },

    recover: async () => {
      const interrupted = ledger.all().filter((record) => record.state.tag === "sending");
      await Promise.all(
        interrupted.map(async (record) => {
          // A held lock means a live tab is still running this send, so it is not interrupted at all.
          if (!locks) return recoverOne(record);
          await locks.request(`lms-send:${record.id}`, { ifAvailable: true }, async (lock) => {
            if (lock) await recoverOne(record);
          });
        }),
      );
    },

    check: async (id) => {
      const record = ledger.get(id);
      const provider = record && deps.providerFor(record.school);
      if (!record || !provider) return { ok: false, error: { kind: "not_found" } };
      return withLock(id, async () => {
        const current = ledger.get(id) ?? record;
        const observed = await provider.observe(current.content);
        if (!observed.ok) return observed;
        const decisions = classify(
          current.content,
          current.basis,
          observed.value,
          current.seen ?? seenOf(observed.value),
        );
        const present = remainingFields(current).filter(
          (field) => decisions[field]?.do === "already-there",
        );
        const confirmed = ledger.commit(id, {
          type: "confirm",
          outcomes: observedOutcomes(present),
          at: at(),
        });
        return { ok: true, value: confirmed.ok ? confirmed.value : current };
      });
    },

    laneStatus: (school) => {
      const lane = laneOf(school);
      if (lane.closed) return { state: "closed", reason: "reconnect" };
      return deps.now() < lane.pausedUntil
        ? { state: "paused", until: lane.pausedUntil, reason: "rate-limited" }
        : { state: "open" };
    },

    reopen: (school) => {
      laneOf(school).closed = false;
    },

    laneRead: async (school, read) => {
      const lane = laneOf(school);
      for (let tries = 1; ; tries++) {
        await waitOutPause(lane, null);
        const result = await read();
        if (result.ok || tries >= policy.maxAttempts) return result;
        if (result.error.kind === "rate_limited") pause(lane, result.error.retryAfterMs);
        else if (result.error.kind === "unavailable") await deps.sleep(backoffMs(tries));
        else return result;
      }
    },
  };
};
