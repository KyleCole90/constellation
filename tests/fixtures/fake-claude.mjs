#!/usr/bin/env node
// A stand-in for `claude`: it answers --version and `auth status`, and for a run records its argv, environment,
// working folder and stdin, then replays the stream-json lines of the scenario file named by FAKE_CLAUDE.
import { appendFileSync, readFileSync, readdirSync } from "node:fs";

const scenario = JSON.parse(readFileSync(process.env.FAKE_CLAUDE, "utf8"));
const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write(`${scenario.version ?? "2.1.325"} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] === "auth") {
  const auth = scenario.auth ?? { loggedIn: true, authMethod: "claude.ai" };
  process.stdout.write(`${JSON.stringify(auth, null, 2)}\n`);
  process.exit(auth.loggedIn ? 0 : 1);
}

let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", async () => {
  const started = Date.now();
  const record = {
    pid: process.pid,
    argv: args,
    env: process.env,
    cwd: process.cwd(),
    cwdEntries: readdirSync(process.cwd()),
    stdin,
    started,
  };
  appendFileSync(scenario.record, `${JSON.stringify(record)}\n`);
  if (scenario.exitAtOnce !== undefined) process.exit(scenario.exitAtOnce);
  await new Promise((resolve) => setTimeout(resolve, scenario.delayMs ?? 0));
  for (const line of scenario.lines ?? []) process.stdout.write(`${JSON.stringify(line)}\n`);
  appendFileSync(scenario.record, `${JSON.stringify({ pid: process.pid, ended: Date.now() })}\n`);
  // Hangs until killed, but never outlives the test run that started it.
  if (scenario.hang) {
    const parent = process.ppid;
    setInterval(() => process.ppid !== parent && process.exit(0), 100);
    setTimeout(() => process.exit(0), 60_000);
  } else process.exitCode = scenario.exitCode ?? 0;
});
