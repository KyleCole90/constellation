import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync } from "oxc-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE = "scripts/comment-baseline.json";

const CODE = /\.(?:[cm]?[jt]sx?|css)$/;
const ROOT_CONFIG = /^(?:tsconfig[\w.]*|knip)\.json$/;
const GENERATED = new Set(["src/renderer/routeTree.gen.ts"]);

const TOOL_COMMENTS = [
  /^\s*(?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?\s+\S.*\s--\s+\S/s,
  /^\s*@ts-(?:expect-error|ignore|nocheck|check)\b/,
  /^\/\s*<reference\s/,
  /^\s*forged:\s+\S/,
  /^\s*(?:prettier|oxfmt)-ignore\b/,
  /^\s*[@#]__PURE__\s*$/,
  /^\s*@vite-ignore\s*$/,
];

export const counts = (comment, source) =>
  !TOOL_COMMENTS.some((pattern) => pattern.test(comment.value)) &&
  !source.startsWith("#!", comment.range?.[0] ?? comment.start);

const cssComments = (source) => {
  const found = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === '"' || char === "'") {
      const close = source.indexOf(char, at + 1);
      at = close === -1 ? source.length : close + 1;
    } else if (source.startsWith("/*", at)) {
      const close = source.indexOf("*/", at + 2);
      const end = close === -1 ? source.length : close + 2;
      found.push({ type: "Block", value: source.slice(at + 2, end - 2), start: at, end });
      at = end;
    } else at += 1;
  }
  return found;
};

const rawComments = (path, source) => {
  if (path.endsWith(".css")) return cssComments(source);
  if (path.endsWith(".json"))
    return parseSync("config.js", `(${source})`).comments.map((comment) => ({
      ...comment,
      start: comment.start - 1,
      end: comment.end - 1,
    }));
  return parseSync(path, source).comments.filter(
    (comment) => !source.startsWith("#!", comment.start),
  );
};

const lineAt = (source, offset) => source.slice(0, offset).split("\n").length;

const commentsIn = (path, source) =>
  rawComments(path, source)
    .filter((comment) => counts(comment, source))
    .map((comment) => {
      const line = lineAt(source, comment.start);
      const endLine = lineAt(source, comment.end);
      const lineStart = source.lastIndexOf("\n", comment.start - 1) + 1;
      const lineEnd = source.indexOf("\n", comment.end);
      const own =
        source.slice(lineStart, comment.start).trim() === "" &&
        source.slice(comment.end, lineEnd === -1 ? source.length : lineEnd).trim() === "";
      return {
        line,
        lines: endLine - line + 1,
        own,
        text: source.slice(comment.start, comment.end),
      };
    });

const trackedFiles = () =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(
      (path) =>
        !GENERATED.has(path) &&
        !path.startsWith(".claude/") &&
        (CODE.test(path) || ROOT_CONFIG.test(path)),
    );

const inventory = () => {
  const files = {};
  for (const path of trackedFiles()) {
    let source;
    try {
      source = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue;
    }
    const comments = commentsIn(path, source);
    if (comments.length > 0) files[path] = comments;
  }
  return files;
};

export const readBaseline = () => {
  const parsed = JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8"));
  const baseline = {};
  for (const [path, count] of Object.entries(parsed))
    if (typeof count === "number") baseline[path] = count;
  return baseline;
};

const baselineDrift = (files, baseline) => {
  const drift = [];
  for (const path of new Set([...Object.keys(files), ...Object.keys(baseline)])) {
    const actual = files[path]?.length ?? 0;
    const allowed = baseline[path] ?? 0;
    if (actual !== allowed) drift.push({ path, actual, allowed });
  }
  return drift.sort((a, b) => a.path.localeCompare(b.path));
};

const POSITION = new Set(["start", "end", "range", "loc"]);
const isJsxFiller = (node) =>
  (node?.type === "JSXExpressionContainer" && node.expression.type === "JSXEmptyExpression") ||
  (node?.type === "JSXText" && node.value.trim() === "" && node.value.includes("\n"));
const shape = (path, source) => {
  if (path.endsWith(".css")) {
    const comments = cssComments(source);
    let text = source;
    for (const comment of comments.reverse())
      text = text.slice(0, comment.start) + text.slice(comment.end);
    return text.replaceAll(/\s+/g, "");
  }
  const { program, errors } = parseSync(path, source);
  if (errors.length > 0) return null;
  return JSON.stringify(program, (key, value) =>
    POSITION.has(key)
      ? undefined
      : key === "children" && Array.isArray(value)
        ? value.filter((child) => !isJsxFiller(child))
        : value,
  );
};

const lineBounds = (source, start, end) => {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const newline = source.indexOf("\n", end);
  return { lineStart, lineEnd: newline === -1 ? source.length : newline };
};

const emptyJsxContainers = (path, source) => {
  if (!/\.[jt]sx$/.test(path)) return [];
  const found = [];
  const visit = (node) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") {
      if (isJsxFiller(node) && node.type === "JSXExpressionContainer") found.push(node);
      Object.values(node).forEach(visit);
    }
  };
  visit(parseSync(path, source).program);
  return found;
};

const withoutComments = (path, source) => {
  let text = source;
  const containers = emptyJsxContainers(path, source);
  for (const comment of rawComments(path, source)
    .filter((found) => counts(found, source))
    .reverse()) {
    const container = containers.find(
      (node) => node.start <= comment.start && comment.end <= node.end,
    );
    const { start, end } = container ?? comment;
    const { lineStart, lineEnd } = lineBounds(text, start, end);
    const lead = text.slice(lineStart, start);
    const tail = text.slice(end, lineEnd);
    if (lead.trim() === "" && tail.trim() === "")
      text = text.slice(0, lineStart) + text.slice(Math.min(lineEnd + 1, text.length));
    else if (tail.trim() === "") text = text.slice(0, start).trimEnd() + text.slice(end);
    else
      text =
        text.slice(0, start) + text.slice(end).replace(/^[ \t]+/, lead.trim() === "" ? "" : " ");
  }
  return shape(path, text) === shape(path, source) ? text : null;
};

const summary = (files) => {
  const all = Object.values(files).flat();
  const sum = (list) => list.reduce((total, comment) => total + comment.lines, 0);
  return {
    files: Object.keys(files).length,
    comments: all.length,
    lines: sum(all),
    ownLines: sum(all.filter((comment) => comment.own)),
  };
};

const USAGE = `node scripts/comments.mjs [--tsv | --summary | --check | --write-baseline]
  --tsv             every comment: file, line, line count, own-line, text (newlines as \\n)
  --summary         comment count and line totals (default)
  --check           exit 1 when ${BASELINE} differs from the tree
  --write-baseline  rewrite ${BASELINE} from the tree
  --delete <path>…  delete every comment in each file under the paths, refusing a file whose code would change`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--summary";
  const files = inventory();
  if (mode === "--tsv") {
    for (const [path, comments] of Object.entries(files))
      for (const comment of comments)
        process.stdout.write(
          `${path}\t${comment.line}\t${comment.lines}\t${comment.own ? "own" : "trailing"}\t${comment.text.replaceAll("\n", "\\n")}\n`,
        );
  } else if (mode === "--summary") {
    process.stdout.write(`${JSON.stringify(summary(files), null, 2)}\n`);
  } else if (mode === "--check") {
    const drift = baselineDrift(files, readBaseline());
    for (const { path, actual, allowed } of drift)
      process.stdout.write(`${path}: ${actual} comments, baseline allows ${allowed}\n`);
    process.exitCode = drift.length > 0 ? 1 : 0;
  } else if (mode === "--write-baseline") {
    const counts = Object.fromEntries(
      Object.entries(files)
        .map(([path, comments]) => [path, comments.length])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(join(ROOT, BASELINE), `${JSON.stringify(counts, null, 2)}\n`);
  } else if (mode === "--delete" && process.argv.length > 3) {
    const prefixes = process.argv.slice(3);
    for (const path of Object.keys(files).filter((file) =>
      prefixes.some(
        (prefix) => file === prefix || file.startsWith(`${prefix.replace(/\/$/, "")}/`),
      ),
    )) {
      const text = withoutComments(path, readFileSync(join(ROOT, path), "utf8"));
      if (text === null) {
        process.stdout.write(`${path}: left alone, deleting its comments would change its code\n`);
        process.exitCode = 1;
      } else writeFileSync(join(ROOT, path), text);
    }
  } else {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 2;
  }
}
