declare function structuredClone<T>(value: T): T;

interface AbortSignal {
  readonly aborted: boolean;
}

interface URLSearchParams {
  get(name: string): string | null;
}
