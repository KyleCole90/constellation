// Claude Code PreToolUse hook: denies a Bash call that skips git hooks or kills a process this thread
// did not start. Wired in .claude/settings.json. Reads the hook payload on stdin.

import { readFileSync } from "node:fs";

const NO_VERIFY_REASON =
  "The pre-commit hook runs fmt, lint and knip, not tests, so a commit with a failing test passes it. Fix what the hook reports.";

const KILL_REASON =
  "CI and other threads run verify on this Mac, and a process search or a PID from ps matches their processes too. Stop only what you started: capture $! when you start it, run it under timeout <seconds>, or use TaskStop for your own background task.";

// Short commit options that take a value; in a cluster like -nm, chars after one of these are its value.
const COMMIT_VALUE_FLAGS = "mFcCtSu";

/** Splits a shell command into words per simple command, dropping quotes. Quoted words are never flags. */
const simpleCommands = (command) => {
  const commands = [[]];
  for (const [, op, double, single, bare] of command.matchAll(
    /(&&|\|\||[;|&\n])|"((?:\\.|[^"])*)"|'([^']*)'|(\S+?)(?=$|\s|&&|\|\||[;|&])/g,
  )) {
    if (op) commands.push([]);
    else commands.at(-1).push({ text: double ?? single ?? bare, quoted: bare === undefined });
  }
  return commands;
};

const commitSkipsHooks = (args) => {
  for (let i = 0; i < args.length; i++) {
    const { text, quoted } = args[i];
    if (quoted) continue;
    if (text === "--") return false;
    if (text === "--no-verify") return true;
    if (!/^-[^-]/.test(text)) continue;
    for (const flag of text.slice(1)) {
      if (flag === "n") return true;
      if (COMMIT_VALUE_FLAGS.includes(flag)) {
        if (text.endsWith(flag) && "mFcCt".includes(flag)) i++;
        break;
      }
    }
  }
  return false;
};

const skipsHooks = (words) => {
  const git = words.findIndex((w) => !w.quoted && /(^|\/)git$/.test(w.text));
  if (git === -1) return false;
  let i = git + 1;
  // Skip git's global options, such as -C <dir> or -c key=value.
  while (i < words.length && words[i].text.startsWith("-"))
    i += ["-C", "-c"].includes(words[i].text) ? 2 : 1;
  const args = words.slice(i + 1);
  if (words[i]?.text === "commit") return commitSkipsHooks(args);
  if (words[i]?.text === "push") return args.some((w) => !w.quoted && w.text === "--no-verify");
  return false;
};

// Words that come before the command name: VAR=value, or a shell keyword such as `then` or `do`.
const BEFORE_COMMAND = /^(\w+=.*|then|do|else|elif|if|while|until|!|[{(])$/;
const WRAPPER = /^(sudo|nohup|exec|time|env|timeout|nice|stdbuf|command)$/;

const named = (word, names) => !word.quoted && names.includes(word.text.split("/").at(-1));

/**
 * The index of the word that runs one of `names`, or -1. Behind a wrapper such as `sudo -u root` or `timeout -k 5 300`,
 * the command can't be told from the wrapper's own arguments, so any later word that names one counts.
 */
const commandIndex = (words, names) => {
  const first = words.findIndex((w) => w.quoted || !BEFORE_COMMAND.test(w.text));
  if (first === -1) return -1;
  if (named(words[first], names)) return first;
  if (words[first].quoted || !WRAPPER.test(words[first].text)) return -1;
  return words.findIndex((w, i) => i > first && named(w, names));
};

const runs = (words, names) => commandIndex(words, names) !== -1;

const killArgs = (words) => {
  const kill = commandIndex(words, ["kill"]);
  return kill === -1 ? [] : words.slice(kill + 1);
};

/** True when an operand is a literal PID or process group. Quoting doesn't matter: "$pid" is not a number. */
const killsLiteralPid = (words) => {
  const args = killArgs(words);
  for (let i = 0, operands = false; i < args.length; i++) {
    const { text } = args[i];
    if (!operands && text === "--") operands = true;
    else if (!operands && (text === "-s" || text === "-n")) i++;
    else if (!operands && text.startsWith("-")) continue;
    else if (/^-?\d+$/.test(text)) return true;
  }
  return false;
};

// Looks at the whole Bash call, because the search and the kill are often apart: `PID=$(lsof -ti:4320); kill $PID`.
// Any substitution that mentions a search tool counts, whatever wraps it: `$(sudo /usr/sbin/lsof -ti:4320)`.
const killsSearchResult = (words, command) =>
  runs(words, ["kill"]) && /(\$\(|`)[^)`]*\b(pgrep|pidof|lsof|ps|fuser)\b/.test(command);

// A pipeline splits into one simple command per stage, so `pgrep x | xargs kill` arrives as `xargs kill`.
const xargsKill = (words) =>
  runs(words, ["xargs"]) && words.some((w) => !w.quoted && w.text === "kill");

const RULES = [
  { test: skipsHooks, reason: NO_VERIFY_REASON },
  { test: (words) => runs(words, ["pkill", "killall"]), reason: KILL_REASON },
  { test: killsLiteralPid, reason: KILL_REASON },
  { test: killsSearchResult, reason: KILL_REASON },
  { test: xargsKill, reason: KILL_REASON },
];

const { tool_input } = JSON.parse(readFileSync(0, "utf8"));
const command = tool_input?.command ?? "";
const commands = simpleCommands(command);
const denied = RULES.find((rule) => commands.some((words) => rule.test(words, command)));
if (denied) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denied.reason,
      },
    }),
  );
}
