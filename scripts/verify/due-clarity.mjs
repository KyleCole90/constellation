import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { startDevServer } from "../dev-server.mjs";
import { onboardPage } from "./onboard.mjs";

const ORACLE = JSON.parse(
  await readFile(new URL("./due-clarity.oracle.json", import.meta.url), "utf8"),
);

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const LABEL = arg("label", "run");
const WORKLOAD = arg("workload", "heavy");
const READERS = Number(arg("readers", "6"));
const MODEL = arg("model", "haiku");
const INJECT = arg("inject", null);
const [WIDTH, HEIGHT] = arg("viewport", "1440x900").split("x").map(Number);
const CAPTURE_ONLY = process.argv.includes("--capture-only");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = resolve(
  process.env.DUE_CLARITY_OUT ?? join(ROOT, "out/audit/whats-due-hillclimb/runs"),
  LABEL,
);
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const FIXED_NOW = new Date("2026-10-30T14:00:00");

const PROMPT = `You teach as an adjunct at two colleges. You just opened the app you use to run your teaching week, and you have about 15 seconds before a meeting.

Read the image file screen.png in the current directory with the Read tool. It is all you can see. Do not scroll, and do not assume anything that is not on the screen. Do not use any other tool.

Then reply with only one JSON object and nothing else:
{
  "next": "the one specific thing you would start next, in the words the screen uses",
  "then": ["the thing after that", "the thing after that"],
  "order_source": "screen" if the screen told you what order to work in, or "me" if you had to work the order out yourself,
  "reason": "one short sentence on why that thing goes first",
  "reason_quote": "the exact words on the screen that say why it goes first, or null if no words on the screen say so",
  "to_grade": the total number of student submissions waiting to be graded right now, as a number, or null if you can't tell,
  "unread": the total number of unread student messages, as a number, or null if you can't tell,
  "other_work": "the first specific task on the screen that is not grading, such as a named student message or announcement, or null if you can't see one",
  "can_wait": "one specific item you can see that needs nothing from you right now, or null if you can't tell",
  "click": "the label of what you would click to start"
}`;

const onboard = {
  heavy: (page) => onboardPage(page),
  light: (page) => onboardPage(page, { hosts: ["lakeshore.instructure.com"] }),
};

const readTruth = (page) =>
  page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("lms-app.v1")).state;
    const caches = Object.entries(state.cache)
      .filter(([school]) => state.connections[school]?.status !== "disconnected")
      .map(([, cache]) => cache);
    const submissions = caches.flatMap((c) => c.submissions);
    const assignments = caches.flatMap((c) => c.assignments);
    const conversations = caches.flatMap((c) => c.conversations);
    const live = (a) => submissions.filter((s) => s.assignment === a.ref);
    const toGrade = assignments.filter((a) => live(a).some((s) => s.workflow === "submitted"));
    const nothingYet = assignments.filter(
      (a) =>
        a.dueAt &&
        Date.parse(a.dueAt) > Date.now() &&
        !live(a).some((s) => s.workflow === "submitted" || s.workflow === "graded"),
    );
    const threads = Object.values(state.threads);
    return {
      toGrade: submissions.filter((s) => s.workflow === "submitted").length,
      unread: conversations.filter((c) => c.unread).length,
      workNow: [
        ...toGrade.flatMap((a) => [a.title, a.shortTitle]),
        ...threads
          .filter((t) => ["grading", "messages", "announcement"].includes(t.kind) && t.course)
          .map((t) => t.title),
        ...conversations.flatMap((c) => (c.unread ? [c.from, c.subject] : [])),
      ],
      canWait: nothingYet.flatMap((a) => [a.title, a.shortTitle]),
      setup: Object.values(state.newCourses)
        .flat()
        .map((shell) => shell.title),
      otherWork: [
        ...threads
          .filter((t) => ["messages", "announcement"].includes(t.kind) && t.course)
          .map((t) => t.title),
        ...conversations.flatMap((c) => (c.unread ? [c.from, c.subject] : [])),
      ],
      data: {
        today: new Date().toISOString(),
        assignments: assignments.map((a) => ({
          title: a.title,
          school: a.school,
          course: caches.flatMap((c) => c.courses).find((c) => c.ref === a.course)?.code,
          dueAt: a.dueAt,
          points: a.pointsPossible,
          toGrade: live(a).filter((s) => s.workflow === "submitted").length,
          graded: live(a).filter((s) => s.workflow === "graded").length,
          missing: live(a).filter((s) => s.workflow === "missing").length,
          total: live(a).length,
        })),
        unreadMessages: conversations
          .filter((c) => c.unread)
          .map((c) => ({
            from: c.from,
            subject: c.subject,
            school: c.school,
            course: caches.flatMap((x) => x.courses).find((x) => x.ref === c.course)?.code,
            messages: c.messages.map((m) => ({ mine: m.mine, at: m.at, text: m.text ?? m.body })),
          })),
        announcementDrafts: threads
          .filter((t) => t.kind === "announcement")
          .map((t) => ({ title: t.title, course: t.course })),
        newCourseShells: Object.values(state.newCourses)
          .flat()
          .map((c) => ({
            title: c.title,
            code: c.code,
            school: c.school,
            termName: c.termName,
            startAt: c.startAt,
            itemCount: c.itemCount,
          })),
      },
    };
  });

const capture = async (out) => {
  const vite = await startDevServer();
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1.5,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.setFixedTime(FIXED_NOW);
    await page.goto(`${vite.origin}/welcome`);
    await page.evaluate((noise) => sessionStorage.setItem("verify.noise", noise), QUIET);
    await page.reload();
    await onboard[WORKLOAD](page);
    await page.waitForURL("**/due");
    await page.waitForSelector('[data-testid="due-list"]');
    await page.waitForTimeout(1200);
    if (INJECT) {
      const html = await readFile(INJECT, "utf8");
      await page.evaluate((markup) => {
        document.querySelector('[data-testid="due-list"]').innerHTML = markup;
      }, html);
      await page.waitForTimeout(200);
    }
    const pane = await page.locator('[data-testid="due-list"]').evaluate((el) => {
      const main = el.parentElement.getBoundingClientRect();
      return { x: main.x, y: 0, width: innerWidth - main.x, height: innerHeight };
    });
    await page.screenshot({ path: join(out, "screen.png"), clip: pane });
    await page.screenshot({ path: join(out, "full.png") });
    const firstScreenWords = await page.evaluate(({ x }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let words = 0;
      while (walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        const box = range.getBoundingClientRect();
        if (
          box.width > 0 &&
          walker.currentNode.parentElement.checkVisibility({ contentVisibilityAuto: true }) &&
          box.left >= x &&
          box.top < innerHeight &&
          box.bottom > 0
        )
          words += walker.currentNode.textContent.trim().split(/\s+/).filter(Boolean).length;
      }
      return words;
    }, pane);
    const screenText = await page.evaluate(
      () => document.querySelector('[data-testid="due-list"]').parentElement.innerText,
    );
    const truth = await readTruth(page);
    const list = page.locator('[data-testid="due-list"]');
    const metrics = await list.evaluate((el) => ({
      rows: el.querySelectorAll("li").length,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    return { truth, metrics, errors, screenText, firstScreenWords };
  } finally {
    await browser.close();
    await vite.close();
  }
};

const askOne = async (image) => {
  const dir = await mkdtemp(join(tmpdir(), "due-reader-"));
  await copyFile(image, join(dir, "screen.png"));
  try {
    const child = spawn(
      "claude",
      [
        "-p",
        PROMPT,
        "--model",
        MODEL,
        "--tools",
        "Read",
        "--allowedTools",
        "Read",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--output-format",
        "json",
      ],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    await new Promise((done) => child.once("exit", done));
    const envelope = JSON.parse(stdout);
    const match = String(envelope.result ?? "").match(/\{[\s\S]*\}/);
    return {
      answer: match ? JSON.parse(match[0]) : null,
      cost: envelope.total_cost_usd ?? 0,
      raw: envelope.result ?? stdout,
    };
  } catch (error) {
    return { answer: null, cost: 0, raw: String(error) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const norm = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const mentions = (answer, names) =>
  names
    .map(norm)
    .filter((name) => name.length >= 4 && norm(answer).includes(name))
    .sort((a, b) => b.length - a.length)[0] ?? null;

const grade = (answers, truth, screenText) => {
  const picks = answers.map(
    (a) => mentions(a.next, [...truth.workNow, ...truth.setup]) ?? norm(a.next),
  );
  const tally = picks.reduce((acc, pick) => acc.set(pick, (acc.get(pick) ?? 0) + 1), new Map());
  const mode = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const scored = answers.map((a, i) => {
    const parts = {
      agree: picks[i] === mode ? 1 : 0,
      right: mentions(a.next, ORACLE.top) ? 1 : 0,
      told: a.order_source === "screen" ? 1 : 0,
      why:
        a.reason_quote &&
        norm(a.reason_quote).split(" ").length >= 3 &&
        norm(screenText).includes(norm(a.reason_quote))
          ? 1
          : 0,
      other: mentions(a.other_work, truth.otherWork) ? 1 : 0,
      load: (a.to_grade === truth.toGrade ? 0.5 : 0) + (a.unread === truth.unread ? 0.5 : 0),
      canWait: mentions(a.can_wait, truth.canWait) ? 1 : 0,
    };
    return { parts, score: Object.values(parts).reduce((sum, value) => sum + value, 0) / 7 };
  });
  const mean = (values) =>
    values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const parts = Object.fromEntries(
    ["agree", "right", "told", "why", "load", "other", "canWait"].map((key) => [
      key,
      Math.round(mean(scored.map((s) => s.parts[key])) * 100),
    ]),
  );
  return {
    score: Math.round(mean(scored.map((s) => s.score)) * 100),
    parts,
    mode,
    modeShare: answers.length ? tally.get(mode) / answers.length : 0,
    picks,
  };
};

await mkdir(OUT, { recursive: true });
const { truth, metrics, errors, screenText, firstScreenWords } = await capture(OUT);
await writeFile(join(OUT, "data.json"), JSON.stringify(truth.data, null, 1));
console.log(
  `captured ${WORKLOAD}: ${metrics.rows} rows, ${firstScreenWords} words on the first screen, list ${metrics.scrollHeight}px in ${metrics.clientHeight}px, page errors ${errors.length}, truth toGrade=${truth.toGrade} unread=${truth.unread} canWait=${truth.canWait.length / 2}`,
);
if (!CAPTURE_ONLY) {
  const results = await Promise.all(
    Array.from({ length: READERS }, () => askOne(join(OUT, "screen.png"))),
  );
  const answers = results.flatMap((r) => (r.answer ? [r.answer] : []));
  const failed = results.length - answers.length;
  const report = {
    label: LABEL,
    workload: WORKLOAD,
    model: MODEL,
    readersAsked: READERS,
    readersAnswered: answers.length,
    readerErrors: failed,
    pageErrors: errors.length,
    rows: metrics.rows,
    cost: results.reduce((sum, r) => sum + r.cost, 0),
    truth: { toGrade: truth.toGrade, unread: truth.unread },
    ...grade(answers, truth, screenText),
    answers,
  };
  await writeFile(
    join(OUT, "report.json"),
    JSON.stringify({ ...report, raw: results.map((r) => r.raw) }, null, 2),
  );
  console.log(
    `CLARITY ${report.score}/100 ${LABEL} [${Object.entries(report.parts)
      .map(([key, value]) => `${key} ${value}`)
      .join(
        " ",
      )}] answered ${answers.length}/${READERS} errors ${failed} cost $${report.cost.toFixed(3)} mode "${report.mode}" (${Math.round(report.modeShare * 100)}%)`,
  );
}
process.exit(0);
