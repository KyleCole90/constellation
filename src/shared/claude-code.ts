/**
 * The oldest Claude Code whose flags, init message and stream-json Constellation has checked. Raise it on purpose, after
 * the live test (`tests/claude-code.live.ts`) passes on the newer version.
 */
export const CLAUDE_CODE_MINIMUM = "2.1.323";

/** Whether version `have` is older than `need`, comparing dotted numbers ("2.1.9" is older than "2.1.10"). */
export const olderThan = (have: string, need: string): boolean => {
  const a = have.split(".").map(Number);
  const b = need.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
};
