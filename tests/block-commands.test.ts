import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

const runHook = (command: string) => {
  const { stdout, status } = spawnSync("node", ["scripts/block-commands.mjs"], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  });
  expect(status).toBe(0);
  if (stdout.trim() === "") return { decision: "allow", reason: "" };
  const { hookSpecificOutput } = JSON.parse(stdout);
  return {
    decision: hookSpecificOutput.permissionDecision as string,
    reason: hookSpecificOutput.permissionDecisionReason as string,
  };
};

describe("git hook skips", () => {
  it.each(["git commit --no-verify", "git commit -nm x", "git push --no-verify"])(
    "denies %s",
    (command) => {
      const { decision, reason } = runHook(command);
      expect(decision).toBe("deny");
      expect(reason).toMatch(/pre-commit hook/);
    },
  );

  it("allows --no-verify inside a commit message", () => {
    expect(runHook('git commit -m "--no-verify"').decision).toBe("allow");
  });
});

describe("killing a process this thread did not start", () => {
  it.each([
    'pkill -f "node scripts/verify.mjs"',
    'pkill -f "lms-verify-"',
    "kill 95679 95722",
    "killall node",
    "kill -9 1234",
    "kill -TERM 123",
    "kill -s TERM 123",
    "kill -- -1234",
    "kill $(pgrep -f verify)",
    "kill `lsof -ti:4320`",
    "pgrep -f vite | xargs kill",
    "ps aux | grep node | awk '{print $2}' | xargs kill -9",
    "PID=$(lsof -ti:4320); kill $PID",
    "for p in $(pgrep -f vite); do kill $p; done",
    "if pgrep -f verify; then pkill -f verify; fi",
    "sudo pkill -f vite",
    "timeout 5 pkill -f vite",
    "timeout -s KILL 5 pkill -f vite",
    "sudo -u root pkill -f vite",
    "command pkill -f vite",
    "sudo -u root kill 1234",
    "kill $(timeout 5 pgrep -f vite)",
    "kill $(sudo lsof -ti:4320)",
    "kill $(/usr/sbin/lsof -ti:4320)",
  ])("denies %s", (command) => {
    const { decision, reason } = runHook(command);
    expect(decision).toBe("deny");
    expect(reason).toMatch(/\$!/);
    expect(reason).toMatch(/timeout/);
    expect(reason).toMatch(/TaskStop/);
  });

  it.each([
    "kill $!",
    'kill "$pid"',
    'kill -TERM "$server_pid"',
    "kill %1",
    'kill -0 "$pid"',
    'kill "$(cat "$pidfile")"',
    "timeout 300 npm run verify",
    'echo "pkill is banned"',
    'git commit -m "kill 123"',
    "grep -n pkill scripts/x.mjs",
    "pid=$(lsof -ti:4320); echo $pid",
    "npm run dev & server=$!; kill $server",
    "sudo -n true",
    "timeout 300 npm run verify -- --only=grading",
    "nice -n 10 npm test",
  ])("allows %s", (command) => {
    expect(runHook(command).decision).toBe("allow");
  });
});
