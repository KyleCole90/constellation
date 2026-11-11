// Scores North Star as a place to start work. START is half checks on the running app and half what fresh readers get from one screenshot. Black box: it knows the composer and the sidebar, and nothing about how the start screen is built.
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { startDevServer } from "../dev-server.mjs";
import { onboardPage } from "./onboard.mjs";

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const LABEL = arg("label", "run");
const READERS = Number(arg("readers", "6"));
const MODEL = arg("model", "haiku");
const INJECT = arg("inject", null);
const [WIDTH, HEIGHT] = arg("viewport", "1440x900").split("x").map(Number);
const CAPTURE_ONLY = process.argv.includes("--capture-only");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REFERENCE = resolve(
  arg("reference", join(ROOT, `scripts/verify/north-star-start.reference-${WIDTH}x${HEIGHT}.png`)),
);
const OUT = resolve(
  process.env.START_OUT ?? join(ROOT, "out/audit/north-star-hillclimb/runs"),
  LABEL,
);
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const FIXED_NOW = new Date("2026-10-30T14:00:00");
const WORK_KINDS = new Set(["grading", "messages", "announcement"]);
const COMPOSER = "[data-composer]";
const SIDEBAR = '[data-testid="sidebar"]';
const ANSWERED = 1800;
const NO_COURSE_ASK = "Draft this week's announcement";
const CHAT_ASK = "What needs grading?";

const clamp = (value) => Math.max(0, Math.min(1, value));
const linear = (value, best, worst) => clamp((worst - value) / (worst - best));
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);

const PROMPT = `You teach as an adjunct at two colleges. You just opened the app you use to run your teaching week, and you have about 15 seconds before a meeting.

Read the image file screen.png in the current directory with the Read tool. It is all you can see. Do not scroll, and do not assume anything that is not on the screen. Do not use any other tool.

Then reply with only one JSON object and nothing else:
{
  "first_target": "the exact visible label or placeholder of the one control you would use first",
  "focal": "the visible words your eye lands on first, copied from the screen",
  "can_do": ["up to 4 specific things this screen lets you do"],
  "next_work": "the most specific piece of teaching work you could start right now, in the screen's words, or null",
  "reaches_students_unapproved": "yes", "no" or "can't tell": could something reach students without you approving it
}`;

const COMPARE = `You teach as an adjunct at two colleges. Two versions of the app you use to run your teaching week are in a.png and b.png in the current directory. Read both with the Read tool. Do not use any other tool.

Reply with only one JSON object and nothing else:
{
  "calmer": "a" or "b": which screen is cleaner, calmer and easier to scan,
  "clearer": "a" or "b": which screen makes it more obvious how to get your next piece of work started,
  "why": "one short sentence"
}`;

const onboard = async (page, base) => {
  await page.goto(`${base}/welcome`);
  await page.evaluate((noise) => sessionStorage.setItem("verify.noise", noise), QUIET);
  await page.reload();
  await onboardPage(page);
  await page.waitForURL("**/due");
  await page.locator(SIDEBAR).getByText("Settings").click();
  await page.locator('[data-testid="settings-nav"]').getByText("AI", { exact: true }).click();
  await page.locator('[data-testid="ai-source-row"]').getByText("Use a key").click();
  await page.locator('[role="dialog"] input[type="password"]').fill("verify-ai-key");
  await page.locator('[role="dialog"]').getByText("Save key").click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="ai-source-row"]')?.innerText.includes("Anthropic key"),
  );
};

const snapshotStorage = (page) => page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
const restoreStorage = (page, saved) =>
  page.evaluate((entries) => {
    localStorage.clear();
    for (const [key, value] of JSON.parse(entries)) localStorage.setItem(key, value);
  }, saved);

const land = async (page, base) => {
  await page.goto(`${base}/`);
  await page.waitForSelector(COMPOSER);
  await page.waitForTimeout(500);
};

/** Everything in the main pane that a person can see or use. The sidebar is its own check. */
const readPane = (page) =>
  page.evaluate(
    ({ sidebar, composer }) => {
      const left = document.querySelector(sidebar).getBoundingClientRect().right;
      const header =
        document.querySelector('[data-testid="screen-header"]')?.getBoundingClientRect().bottom ??
        0;
      const visible = (box) =>
        box.width > 0 &&
        box.height > 0 &&
        box.left >= left &&
        box.top < innerHeight &&
        box.bottom > header;
      const blocks = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let words = 0;
      let text = "";
      while (walker.nextNode()) {
        const value = walker.currentNode.textContent.trim();
        if (!value || !walker.currentNode.parentElement.checkVisibility()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        const box = range.getBoundingClientRect();
        if (!visible(box)) continue;
        words += value.split(/\s+/).length;
        text += ` ${value}`;
        blocks.push({ top: box.top, bottom: box.bottom });
      }
      const input = document.querySelector(composer);
      const shell = input?.parentElement.getBoundingClientRect();
      if (shell) blocks.push({ top: shell.top, bottom: shell.bottom });
      blocks.sort((a, b) => a.top - b.top);
      let gap = 0;
      let reach = blocks[0]?.bottom ?? 0;
      for (const block of blocks) {
        gap = Math.max(gap, block.top - reach);
        reach = Math.max(reach, block.bottom);
      }
      const controls = [
        ...document.querySelectorAll("main a, main button, main [role=button], main summary"),
      ].filter((el) => el.checkVisibility() && visible(el.getBoundingClientRect()));
      const center = blocks.length ? (blocks[0].top + reach) / 2 : 0;
      const paneCenter = (header + innerHeight) / 2;
      const pane = document.querySelector("main");
      return {
        gap,
        offCenter: Math.abs(center - paneCenter) / (innerHeight - header),
        words,
        controls: controls.length,
        text: `${text} ${input?.placeholder ?? ""}`,
        composerBottom: shell ? innerHeight - shell.bottom : null,
        composerOnScreen: shell
          ? shell.top >= header &&
            shell.bottom <= innerHeight &&
            shell.left >= left &&
            shell.right <= innerWidth
          : false,
        overflowX: pane ? pane.scrollWidth > pane.clientWidth + 1 : false,
      };
    },
    { sidebar: SIDEBAR, composer: COMPOSER },
  );

const threadKindAt = (page) =>
  page.evaluate(() => {
    const id = decodeURIComponent(location.pathname.split("/threads/")[1] ?? "");
    return {
      id,
      kind: id
        ? (JSON.parse(localStorage.getItem("lms-app.v1")).state.threads[id]?.kind ?? null)
        : null,
    };
  });

const typesRightAway = async (page, base) => {
  await land(page, base);
  await page.keyboard.type("x");
  const typed = await page.locator(COMPOSER).inputValue();
  await page.locator(COMPOSER).fill("");
  return typed === "x";
};

/** Clicks every control in the main pane in turn, from the same saved state, and counts the different pieces of work one click reaches. */
const oneClickWork = async (page, base, saved) => {
  await land(page, base);
  const total = await page
    .locator(
      "main a:visible, main button:visible, main [role=button]:visible, main summary:visible",
    )
    .count();
  const reached = new Set();
  for (let i = 0; i < total; i++) {
    await restoreStorage(page, saved);
    await land(page, base);
    const control = page
      .locator(
        "main a:visible, main button:visible, main [role=button]:visible, main summary:visible",
      )
      .nth(i);
    if ((await control.count()) === 0 || (await control.isDisabled().catch(() => true))) continue;
    await control.click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(300);
    const { id, kind } = await threadKindAt(page);
    if (WORK_KINDS.has(kind)) reached.add(id);
  }
  await restoreStorage(page, saved);
  return reached;
};

const ask = async (page, text) => {
  await page.locator(COMPOSER).fill(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(ANSWERED);
};

/** A question that needs an answer must be answerable where it was asked: some control in the reply finishes the ask without leaving the conversation. */
const answersInPlace = async (page, base, saved) => {
  await restoreStorage(page, saved);
  await land(page, base);
  await ask(page, NO_COURSE_ASK);
  await page.screenshot({ path: join(OUT, "ask-no-course.png") });
  const midAsk = await snapshotStorage(page);
  const at = page.url();
  const choices = await page.locator('[data-testid="chat"] button:visible').count();
  let done = false;
  for (let i = 0; i < choices && !done; i++) {
    await restoreStorage(page, midAsk);
    await page.goto(at);
    await page.waitForSelector(COMPOSER);
    await page
      .locator('[data-testid="chat"] button:visible')
      .nth(i)
      .click({ timeout: 1000 })
      .catch(() => {});
    await page.waitForTimeout(ANSWERED);
    done = page.url() === at && (await page.locator('[data-testid="handoff-group"]').count()) > 0;
  }
  return done;
};

/** Going home after a conversation gives a clean start again, and the conversation is still one click away. */
const startsFresh = async (page, base, saved) => {
  await restoreStorage(page, saved);
  await land(page, base);
  await ask(page, CHAT_ASK);
  await page.screenshot({ path: join(OUT, "chat.png") });
  const docked = await readPane(page);
  await page
    .locator(SIDEBAR)
    .locator("a", { hasText: /^North Star/ })
    .first()
    .click();
  await page.waitForTimeout(700);
  const back = await readPane(page);
  await page.screenshot({ path: join(OUT, "home-after-chat.png") });
  const clean = !back.text.includes(CHAT_ASK);
  const findable = (await page.locator(SIDEBAR).getByText(CHAT_ASK).count()) > 0;
  return {
    docked: docked.composerBottom !== null && docked.composerBottom <= 40,
    fresh: (clean ? 0.5 : 0) + (findable ? 0.5 : 0),
  };
};

const sidebarFit = (page) =>
  page.evaluate((sidebar) => {
    const list = [...document.querySelectorAll(`${sidebar} *`)].find(
      (el) => el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== "visible",
    );
    return list ? list.clientHeight / list.scrollHeight : 1;
  }, SIDEBAR);

const capture = async () => {
  const vite = await startDevServer();
  const base = vite.origin;
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
    await onboard(page, base);
    const saved = await snapshotStorage(page);

    await land(page, base);
    if (INJECT) {
      const html = await readFile(INJECT, "utf8");
      await page.evaluate((markup) => {
        document.querySelector("main").innerHTML = markup;
      }, html);
      await page.waitForTimeout(200);
    }
    await page.screenshot({ path: join(OUT, "screen.png") });
    const pane = await readPane(page);
    const screenText = await page.evaluate(() => document.querySelector("main")?.innerText ?? "");
    const truth = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("lms-app.v1")).state;
      const caches = Object.values(state.cache);
      return {
        work: [
          ...caches
            .flatMap((c) =>
              c.submissions
                .filter((s) => s.workflow === "submitted")
                .map((s) => c.assignments.find((a) => a.ref === s.assignment)),
            )
            .filter(Boolean)
            .flatMap((a) => [a.title, a.shortTitle]),
          ...Object.values(state.threads)
            .filter((t) => t.course && ["grading", "messages", "announcement"].includes(t.kind))
            .map((t) => t.title),
          ...caches.flatMap((c) =>
            c.conversations.flatMap((x) => (x.unread ? [x.from, x.subject] : [])),
          ),
        ],
      };
    });
    const fit = await sidebarFit(page);
    const typed = await typesRightAway(page, base);
    const reached = await oneClickWork(page, base, saved);
    const inPlace = await answersInPlace(page, base, saved);
    const { docked, fresh } = await startsFresh(page, base, saved);
    const checks = {
      noVoid: linear(pane.gap, 96, 400),
      centered: linear(pane.offCenter, 0.1, 0.4),
      typesRightAway: typed ? 1 : 0,
      oneClickWork: clamp(reached.size / 3),
      answersInPlace: inPlace ? 1 : 0,
      startsFresh: fresh,
      docksInChat: docked ? 1 : 0,
      sidebarFits: clamp((fit - 0.5) / 0.5),
      fewControls: linear(pane.controls, 8, 20),
      fewWords: linear(pane.words, 50, 120),
      fits: pane.composerOnScreen && !pane.overflowX ? 1 : 0,
    };
    return {
      checks,
      pane,
      reached: [...reached],
      errors,
      screenText: `${pane.text} ${screenText}`,
      truth,
    };
  } finally {
    await browser.close();
    await vite.close();
  }
};

const runReader = async (prompt, files) => {
  const dir = await mkdtemp(join(tmpdir(), "start-reader-"));
  await Promise.all(Object.entries(files).map(([name, from]) => copyFile(from, join(dir, name))));
  try {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
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

const askOne = (image) => runReader(PROMPT, { "screen.png": image });

/** Which side the screen under test sits on is random per reader, so "a" bias can't move the score. Scored against a frozen baseline, 50 means no better. */
const compareOne = async (image, reference, swapped) => {
  const result = await runReader(
    COMPARE,
    swapped ? { "a.png": reference, "b.png": image } : { "a.png": image, "b.png": reference },
  );
  const mine = swapped ? "b" : "a";
  return {
    ...result,
    answer: result.answer && {
      calmer: norm(result.answer.calmer) === mine ? 1 : 0,
      clearer: norm(result.answer.clearer) === mine ? 1 : 0,
      why: result.answer.why,
    },
  };
};

const norm = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const grade = (answers, compared, { screenText, truth }) => {
  const main = norm(screenText);
  const onMain = (text) => {
    const words = norm(text);
    return words.length >= 3 && main.includes(words);
  };
  const scored = answers.map((a) => ({
    start: onMain(a.first_target) ? 1 : 0,
    focal: onMain(a.focal) ? 1 : 0,
    canDo: clamp((a.can_do ?? []).length / 3),
    next: truth.work.some(
      (name) =>
        norm(name).length >= 4 &&
        norm(a.next_work).includes(norm(name)) &&
        main.includes(norm(name)),
    )
      ? 1
      : 0,
    safe: norm(a.reaches_students_unapproved) === "no" ? 1 : 0,
  }));
  const parts = Object.fromEntries(
    ["start", "focal", "canDo", "next", "safe"].map((key) => [
      key,
      Math.round(mean(scored.map((s) => s[key])) * 100),
    ]),
  );
  parts.calmer = Math.round(mean(compared.map((c) => c.calmer)) * 100);
  parts.clearer = Math.round(mean(compared.map((c) => c.clearer)) * 100);
  return { score: mean(Object.values(parts)), parts };
};

await mkdir(OUT, { recursive: true });
const seen = await capture();
const objective = mean(Object.values(seen.checks)) * 100;
const checksLine = Object.entries(seen.checks)
  .map(([key, value]) => `${key} ${value.toFixed(2)}`)
  .join(" ");
console.log(
  `captured ${WIDTH}x${HEIGHT}: gap ${Math.round(seen.pane.gap)}px, offCenter ${seen.pane.offCenter.toFixed(2)}, ${seen.pane.words} words, ${seen.pane.controls} controls, one-click work ${seen.reached.length}, page errors ${seen.errors.length}`,
);
console.log(`CHECKS ${objective.toFixed(0)}/100 [${checksLine}]`);
let report = {
  label: LABEL,
  viewport: `${WIDTH}x${HEIGHT}`,
  objective,
  checks: seen.checks,
  reached: seen.reached,
  pageErrors: seen.errors,
};
if (!CAPTURE_ONLY) {
  const results = await Promise.all(
    Array.from({ length: READERS }, () => askOne(join(OUT, "screen.png"))),
  );
  const comparisons = await Promise.all(
    Array.from({ length: READERS }, (_, i) =>
      compareOne(join(OUT, "screen.png"), REFERENCE, i % 2 === 1),
    ),
  );
  const answers = results.flatMap((r) => (r.answer ? [r.answer] : []));
  const compared = comparisons.flatMap((r) => (r.answer ? [r.answer] : []));
  const { score, parts } = grade(answers, compared, seen);
  const start = Math.round((objective + score) / 2);
  report = {
    ...report,
    start,
    readers: score,
    parts,
    readersAsked: READERS,
    readersAnswered: answers.length,
    readerErrors: results.length + comparisons.length - answers.length - compared.length,
    cost: [...results, ...comparisons].reduce((sum, r) => sum + r.cost, 0),
    answers,
    compared,
  };
  console.log(
    `START ${start}/100 ${LABEL} checks ${objective.toFixed(0)} readers ${score.toFixed(0)} [${Object.entries(
      parts,
    )
      .map(([key, value]) => `${key} ${value}`)
      .join(
        " ",
      )}] answered ${answers.length + compared.length}/${READERS * 2} errors ${report.readerErrors} page errors ${seen.errors.length} cost $${report.cost.toFixed(3)}`,
  );
}
await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));
process.exit(0);
