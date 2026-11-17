// Claude Code PreToolUse hook: denies a Bash call that skips git hooks or kills a process this thread
// did not start. Wired in .claude/settings.json. Reads the hook payload on stdin.

import { readFileSync } from "node:fs";

const NO_VERIFY_REASON =
  "The pre-commit hook runs fmt, lint and knip, not tests, so a commit with a failing test passes it. Fix what the hook reports.";

const KILL_REASON =
  "Other agent threads run verify on this Mac, and a process search or a PID from ps matches their processes too. Stop only what you started: capture $! when you start it, run it under timeout <seconds>, or use TaskStop for your own background task.";

// Short commit options that take a value; in a cluster like -nm, chars after one of these are its value.
const COMMIT_VALUE_FLAGS = "mFcCtSu";

// Git's global options that take their value as the next word.
const GIT_VALUE_OPTIONS = [
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--attr-source",
];

// A heredoc body or a comment, where an apostrophe (`it's`) opens a quote that swallows the commands after it. The
// hook also reads the command with the quotes in these removed. Text alone can't tell a real heredoc or comment from
// one inside a string, or a body `bash` runs from one `cat` prints, so a rule that matches either reading denies.
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?\n\t*\3)(?=\n|$)/g;
const COMMENT = /(?<=^|[\s;|&])#[^\n]*/g;
const unquoted = (text) => text.replaceAll(/["'\\]/g, "");

/**
 * Splits a shell command into words per simple command, removing quotes and backslashes the way the shell does, so
 * `--no-ver""ify` is one word. A word written wholly inside quotes is `quoted`: it never names a command to run.
 */
const simpleCommands = (command) => {
  const commands = [[]];
  for (const [, op, word] of command
    .replaceAll("\\\n", "")
    .matchAll(
      /(&&|\|\||[;|&\n])|((?:\$?"(?:\\.|[^"])*"|\$'(?:\\.|[^'])*'|'[^']*'|\\.|[^\s"'\\;|&])+)/g,
    )) {
    if (op) {
      commands.push([]);
      continue;
    }
    const parts = [
      ...word.matchAll(
        /\$?"((?:\\.|[^"])*)"|\$'((?:\\.|[^'])*)'|'([^']*)'|\\(.)|((?:[^"'\\$]|\$(?!["']))+)/g,
      ),
    ];
    commands.at(-1).push({
      text: parts
        .map(
          ([, double, ansi, single, escaped, bare]) => double ?? ansi ?? single ?? escaped ?? bare,
        )
        .join(""),
      quoted: parts.every(([, double, ansi, single]) => (double ?? ansi ?? single) !== undefined),
    });
  }
  return commands;
};

// Config keys that set core.hooksPath, directly or through an included file.
const HOOKS_PATH = /^(core\.hookspath|include\.path|includeif\..+\.path)(=|$)/i;

// Git takes any unambiguous prefix of a long option. Below 6 chars the prefix clashes with --no-verbose, so git refuses it.
// Git sees the word without its quotes, so quoting doesn't matter here.
const isNoVerify = ({ text }) => text.length >= 6 && "--no-verify".startsWith(text);

const commitSkipsHooks = (args) => {
  for (let i = 0; i < args.length; i++) {
    const { text } = args[i];
    if (text === "--") return false;
    if (isNoVerify(args[i])) return true;
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
  for (; i < words.length && words[i].text.startsWith("-"); i++) {
    const { text } = words[i];
    const config = text.startsWith("--config-env=")
      ? text.slice("--config-env=".length)
      : ["-c", "--config-env"].includes(text) && words[i + 1]?.text;
    if (config && HOOKS_PATH.test(config)) return true;
    if (GIT_VALUE_OPTIONS.includes(text)) i++;
  }
  const args = words.slice(i + 1);
  if (words[i]?.text === "commit") return commitSkipsHooks(args);
  if (words[i]?.text === "push") return args.some(isNoVerify);
  if (words[i]?.text === "config") return configWritesHooksPath(args);
  return false;
};

/** `git config core.hooksPath` and `--get` only read it; a value or an unset after the key changes it. */
const configWritesHooksPath = (args) => {
  const key = args.findIndex((w) => HOOKS_PATH.test(w.text));
  return key !== -1 && (key < args.length - 1 || args.some((w) => /^(--)?unset/.test(w.text)));
};

// GIT_CONFIG_COUNT (with its KEY_n and VALUE_n), GIT_CONFIG_PARAMETERS, GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM can each
// set core.hooksPath unseen. They take effect before the command name, or as arguments to `export` and its kin.
const setsGitConfigEnv = (words) => {
  const first = words.findIndex((w) => w.quoted || !BEFORE_COMMAND.test(w.text));
  const assignments =
    first === -1 ||
    runs(words, ["export", "env", "sudo", "declare", "typeset", "readonly", "local"])
      ? words
      : words.slice(0, first);
  return assignments.some((w) => /^GIT_CONFIG_(COUNT|PARAMETERS|GLOBAL|SYSTEM)\+?=/.test(w.text));
};

// Words that come before the command name: VAR=value, or a shell keyword such as `then` or `do`.
const BEFORE_COMMAND = /^(\w+\+?=.*|then|do|else|elif|if|while|until|!|[{(])$/;
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
  { test: setsGitConfigEnv, reason: NO_VERIFY_REASON },
  { test: (words) => runs(words, ["pkill", "killall"]), reason: KILL_REASON },
  { test: killsLiteralPid, reason: KILL_REASON },
  { test: killsSearchResult, reason: KILL_REASON },
  { test: xargsKill, reason: KILL_REASON },
];

const { tool_input } = JSON.parse(readFileSync(0, "utf8"));
const command = tool_input?.command ?? "";
const loose = command
  .replace(HEREDOC, (_, head, _quote, _tag, body) => head + unquoted(body))
  .replace(COMMENT, unquoted);
const commands = [command, loose].flatMap(simpleCommands);
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
