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
  it.each([
    "git commit --no-verify",
    "git commit -nm x",
    "git push --no-verify",
    "git commit --no-verif",
    "git commit --no-veri",
    "git push --no-verif",
    "git --git-dir .git commit --no-verify",
    "git -c core.hooksPath=/dev/null commit",
    "git -c core.hookspath=/dev/null push",
    'git -c "core.hooksPath=/dev/null" commit -m x',
    "git --config-env=core.hooksPath=HOOKS commit -m x",
    "git --config-env core.hooksPath=HOOKS commit -m x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x",
    "env GIT_CONFIG_GLOBAL=/tmp/gitconfig git commit -m x",
    `export GIT_CONFIG_PARAMETERS="'core.hooksPath'='/dev/null'"; git commit -m x`,
    'export "GIT_CONFIG_COUNT=1" "GIT_CONFIG_KEY_0=core.hooksPath"; git commit -m x',
    "git --attr-source HEAD commit --no-verify -m x",
    'git -c "user.name"=x commit --no-verify -m x',
    'git -c core."hooksPath"=/dev/null commit -m x',
    "git -c core.hooks\\Path=/dev/null commit -m x",
    'git commit --no-ver""ify -m x',
    'git commit "--no-verify" -m x',
    "git commit -m x \\\n  --no-verify",
    "git config core.hooksPath /dev/null",
    "git config --unset core.hooksPath",
    "git -c include.path=/tmp/hooks.cfg commit -m x",
    "git commit $'--no-verify' -m x",
    `GIT_CONFIG_PARAMETERS+="'core.hooksPath'='/dev/null'" git commit -m x`,
    "cat <<EOF > notes.txt\nit's fine\nEOF\ngit push --no-verify\necho 'done'",
    "# don't touch\ngit commit -n -m x; echo 'x'",
    "bash <<EOF\ngit commit -n -m x\nEOF",
  ])("denies %s", (command) => {
    const { decision, reason } = runHook(command);
    expect(decision).toBe("deny");
    expect(reason).toMatch(/pre-commit hook/);
  });

  it.each([
    'git commit -m "--no-verify"',
    'git commit -m "--no-verif"',
    "git commit --no-verbose -m x",
    "git -c user.name=x commit -m y",
    "git -c core.editor=true rebase --continue",
    "grep -rn GIT_CONFIG_COUNT scripts",
    "GIT_CONFIG_NOSYSTEM=1 git commit -m x",
    "git config --get core.hooksPath",
    'git commit -m fix -m "--no-verify is banned here"',
    "cat <<EOF > notes.txt\nit's fine\nEOF\necho 'never run git commit -n here'",
    'git commit -m "fix #12" -m "it\'s done"',
    `git commit -m "$(cat <<'EOF'\nfix: don't skip hooks\n\nNever "git push --no-verify".\nEOF\n)"`,
  ])("allows %s", (command) => {
    expect(runHook(command).decision).toBe("allow");
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
    "cat <<'EOF' > notes.txt\nDon't panic\nEOF\nkill 123\necho 'done'",
    "# don't touch\npkill -f vite; echo 'x'",
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
