let browsers = 0;

/**
 * The real `navigator.locks`, under a name scope of its own. Tabs that share one act as one
 * browser. A rig that stands in for a reload gets a fresh one, because the old tab is gone and its
 * locks with it, and a test's leftover lock can't reach the next test.
 */
export class BrowserLocks implements Pick<LockManager, "request"> {
  readonly #scope = `browser-${++browsers}:`;

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<Awaited<T>>;
  request<T>(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<Awaited<T>>;
  request<T>(
    name: string,
    ...args: [LockGrantedCallback<T>] | [LockOptions, LockGrantedCallback<T>]
  ): Promise<Awaited<T>> {
    return args.length === 1
      ? navigator.locks.request(this.#scope + name, args[0])
      : navigator.locks.request(this.#scope + name, args[0], args[1]);
  }

  /** Another tab takes the lock and keeps it until `release` is called. */
  async hold(name: string): Promise<{ release: () => void }> {
    let release = () => {};
    const gone = new Promise<void>((resolve) => (release = resolve));
    await new Promise<void>((held) => {
      void this.request(name, () => (held(), gone));
    });
    return { release };
  }
}
