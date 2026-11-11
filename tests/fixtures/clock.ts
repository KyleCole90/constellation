const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Time moves only when everything runnable has run, so a sleep can never beat the work that should precede it. */
export class VirtualClock {
  #now: number;
  #timers: { at: number; resolve: () => void }[] = [];

  constructor(start = Date.UTC(2026, 9, 30, 12)) {
    this.#now = start;
  }

  now = (): number => this.#now;

  sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      this.#timers.push({ at: this.#now + ms, resolve });
    });

  #fireNext(): boolean {
    const next = this.#timers.reduce<{ at: number; resolve: () => void } | null>(
      (earliest, timer) => (!earliest || timer.at < earliest.at ? timer : earliest),
      null,
    );
    if (!next) return false;
    this.#timers = this.#timers.filter((timer) => timer !== next);
    this.#now = Math.max(this.#now, next.at);
    next.resolve();
    return true;
  }

  /** Drives one piece of work to the end, leaving later timers unfired. */
  async run<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    const tracked = work.finally(() => {
      settled = true;
    });
    tracked.catch(() => undefined);
    for (;;) {
      await macrotask();
      if (settled) return tracked;
      if (!this.#fireNext()) throw new Error("Deadlock: the work is waiting and no timer is left.");
    }
  }

  /** Fires every remaining timer, so anything scheduled for later has happened. */
  async flush(): Promise<void> {
    await macrotask();
    while (this.#fireNext()) await macrotask();
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
