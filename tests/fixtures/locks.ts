export class BrowserLocks implements Pick<LockManager, "request"> {
  readonly #scope = `browser-${crypto.randomUUID()}:`;

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

  async hold(name: string): Promise<{ release: () => void }> {
    let release = () => {};
    const gone = new Promise<void>((resolve) => (release = resolve));
    await new Promise<void>((held) => {
      void this.request(name, () => (held(), gone));
    });
    return { release };
  }
}
