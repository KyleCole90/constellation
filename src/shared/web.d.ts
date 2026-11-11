// Web-platform globals that both Chromium and Node provide. Shared code compiles without DOM and Node types, so it gets only these.
declare function structuredClone<T>(value: T): T;

interface AbortSignal {
  readonly aborted: boolean;
}

interface URLSearchParams {
  get(name: string): string | null;
}
