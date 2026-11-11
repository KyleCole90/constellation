import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { startDevServer } from "../dev-server.mjs";
import { onboardPage } from "./onboard.mjs";

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const LABEL = arg("label", "run");
const READERS = Number(arg("readers", "4"));
const MODEL = arg("model", "haiku");
const INJECT = arg("inject", null);
const [WIDTH, HEIGHT] = arg("viewport", "1440x900").split("x").map(Number);
const CAPTURE_ONLY = process.argv.includes("--capture-only");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = resolve(process.env.LAND_OUT ?? join(ROOT, "out/audit/landing-hillclimb/runs"), LABEL);
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const FIXED_NOW = new Date("2026-10-30T14:00:00");
const COMPOSER = "[data-composer]";
const SIDEBAR = '[data-testid="sidebar"]';
const HANDOFF_ASK = "Draft this week's announcement for HUM 150";
const G2_ROW = /Close Reading 2/;
const READ_KINDS = ["G", "R", "A", "H"];
const LISTED = ["G", "G2", "R", "V"];
const ARRIVAL_MS = 10000;
const SETTLE_MS = 1000;
const FINAL_SECOND_MS = 1000;
const PARALLEL_READERS = 12;
const NOT_A_NAME = new Set(
  "grade grades grading reply replies to draft drafted start review approve the a an and for of other others on your".split(
    " ",
  ),
);
const reference = (kind) =>
  resolve(
    arg("reference-dir", join(ROOT, "scripts/verify")),
    `landing-score.reference-${kind}-${WIDTH}x${HEIGHT}.png`,
  );
const clamp = (value) => Math.max(0, Math.min(1, value));
const linear = (value, best, worst) => clamp((worst - value) / (worst - best));
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const norm = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const nameWords = (text) =>
  new Set(
    norm(text)
      .split(" ")
      .filter((word) => word && !NOT_A_NAME.has(word) && !/^\d+$/.test(word)),
  );
const without = (set, drop) => new Set([...set].filter((word) => !drop.has(word)));

const PROMPT = (
  role,
) => `${role} You just clicked into a piece of work, and you have about 15 seconds before a meeting.

Read the image file screen.png in the current directory with the Read tool. It is all you can see. Do not scroll, and do not assume anything that is not on the screen. Do not use any other tool.

Then reply with only one JSON object and nothing else:
{
  "for_whom": "the student or course this piece of work is for, in the screen's words",
  "main_button": "the exact label of the main button",
  "main_button_does": "review_first" if pressing it shows you what will go out and asks you again, "sends_now" if pressing it sends straight away, "other" or "cant_tell",
  "proposal_kind": "grade", "reply", "announcement", "other" or "cant_tell": what the agent is proposing,
  "proposal_detail": "for a grade, the total grade it proposes. For a reply or an announcement, the first ten words it proposes",
  "sent_yet": "yes", "no" or "cant_tell": has anything from this draft reached students yet
}`;

const COMPARE = (
  role,
) => `${role} You just clicked into a piece of work. Two versions of that screen are in a.png and b.png in the current directory. Read both with the Read tool. Do not use any other tool.

Reply with only one JSON object and nothing else:
{
  "calmer": "a" or "b": which screen is cleaner, calmer and easier to scan,
  "clearer": "a" or "b": which screen makes it more obvious what this is, who it is for, what the agent proposes, and the one thing to do next, with no scrolling,
  "why": "one short sentence"
}`;

const ROLE = "You teach as an adjunct at two colleges, and you have minutes between meetings.";

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

const firstLine = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
const NEXT_UP_ROWS = 'section[aria-label="Next up"] li button, section[aria-label="Next up"] li a';

const home = async (page, base) => {
  await page.goto(`${base}/`);
  await page.waitForSelector(COMPOSER);
  await page.waitForTimeout(400);
};

const dueRow = async (page, base, name) => {
  await page.goto(`${base}/due`);
  await page.waitForTimeout(400);
  const row = () => page.locator(`button:not(${SIDEBAR} button)`).filter({ hasText: name }).first();
  if ((await row().count()) && (await row().isVisible())) return row();
  for (const summary of await page.locator(`summary:not(${SIDEBAR} summary)`).all())
    await summary.click();
  await row().waitFor({ state: "visible", timeout: 1500 });
  return row();
};

const nextUpRow = async (page, base, match) => {
  await home(page, base);
  const rows = page.locator(NEXT_UP_ROWS);
  await rows.first().waitFor({ state: "visible", timeout: 3000 });
  for (let i = 0; i < (await rows.count()); i++)
    if (match(await rows.nth(i).innerText())) return rows.nth(i);
  throw new Error("no matching Next up row");
};

const named = async (row) => ({ row, rowName: firstLine(await row.innerText()) });
const JOURNEYS = {
  G: async ({ page, base }) => {
    const found = await named(await nextUpRow(page, base, () => true));
    await page.screenshot({ path: join(OUT, "home-next-up.png") });
    if (!/^grade\b/i.test(found.rowName))
      throw new Error(`first Next up row is not a grade row: ${found.rowName}`);
    return found;
  },
  G2: async ({ page, base }) =>
    named(
      await nextUpRow(page, base, (text) => G2_ROW.test(text)).catch(() =>
        dueRow(page, base, G2_ROW),
      ),
    ),
  R: async ({ page, base }) =>
    named(await dueRow(page, base, /^(reply to|draft the repl|review the repl)/i)),
  A: async ({ page, base }) =>
    named(await dueRow(page, base, /(start|review|finish) draft: |announcement/i)),
  H: async ({ page, base, tick }) => {
    await home(page, base);
    await tick();
    await page.locator(COMPOSER).fill(HANDOFF_ASK);
    await page.keyboard.press("Enter");
    const row = page.locator("main a", { hasText: /open/i }).first();
    await row.waitFor({ state: "visible", timeout: 8000 });
    const lines = (await row.innerText())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      row,
      rowName: lines.find((line) => line.length > 8 && !/^[A-Z]{2,5}( \d+)?$/.test(line)) ?? "",
    };
  },
  V: async ({ page, base, settle }) => {
    const first = await nextUpRow(page, base, () => true);
    const key = await first.locator("xpath=ancestor::li[1]").getAttribute("data-row");
    await first.click();
    await settle();
    await page
      .locator(SIDEBAR)
      .locator("a", { hasText: /^North Star/ })
      .first()
      .click();
    await page.waitForSelector(COMPOSER);
    await page.waitForTimeout(400);
    const byKey = page
      .locator(`section[aria-label="Next up"] li[data-row="${key}"]`)
      .locator("button, a")
      .first();
    return named(key && (await byKey.count()) ? byKey : page.locator(NEXT_UP_ROWS).first());
  },
};

const readTruth = (page) =>
  page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("lms-app.v1")).state;
    const id = decodeURIComponent(location.pathname.split("/threads/")[1] ?? "");
    const thread = state.threads[id] ?? null;
    const change = thread?.focus ? (state.changes[thread.focus] ?? null) : null;
    const caches = Object.values(state.cache);
    const content = change?.content ?? null;
    const course =
      caches.flatMap((c) => c.courses).find((c) => c.ref === (change?.course ?? thread?.course)) ??
      null;
    const submission =
      content?.kind === "grade"
        ? caches.flatMap((c) => c.submissions).find((s) => s.ref === content.target)
        : null;
    const conversation =
      content?.kind === "reply"
        ? caches.flatMap((c) => c.conversations).find((c) => c.ref === content.target)
        : null;
    const assignment =
      caches
        .flatMap((c) => c.assignments)
        .find((a) => a.ref === (submission?.assignment ?? thread?.assignment)) ?? null;
    const late = content?.late ? content.late.days * content.late.pointsPerDay : 0;
    const raw = content?.rubric
      ? content.rubric.reduce((sum, r) => sum + (r.points ?? 0), 0)
      : content?.points;
    const total =
      content?.kind === "grade" && raw !== null && raw !== undefined
        ? Math.max(0, raw - late)
        : null;
    const threadRows =
      thread?.kind === "messages"
        ? caches
            .flatMap((c) => c.conversations)
            .filter((c) => c.course === thread.course)
            .map((c) => c.from)
        : caches
            .flatMap((c) => c.submissions)
            .filter((s) => s.assignment === thread?.assignment)
            .map((s) => s.studentName);
    const messages = thread?.messages ?? [];
    return {
      threadKind: thread?.kind ?? null,
      threadTitle: thread?.title ?? null,
      changeId: change?.id ?? null,
      changeState: change?.state.tag ?? null,
      family: content?.kind ?? null,
      who: submission?.studentName ?? conversation?.from ?? null,
      courseCode: course?.code ?? null,
      courseTitle: course?.title ?? null,
      assignmentTitle: assignment?.title ?? null,
      assignmentShort: assignment?.shortTitle ?? null,
      criterion: content?.rubric?.[0]?.name ?? null,
      total,
      outOf: content?.outOf ?? null,
      comment: content?.comment ?? null,
      title: content?.title ?? null,
      body: content?.body ?? null,
      userTexts: messages.filter((m) => m.type === "user").map((m) => m.text),
      agentTexts: messages.filter((m) => m.type === "agent").map((m) => m.text),
      workLines: messages.filter((m) => m.type === "work").flatMap((m) => m.lines ?? []),
      threadRows,
      schoolAbbrs: state.schools.map((s) => s.abbr),
    };
  });

const installHelpers = (page) =>
  page.evaluate((sidebar) => {
    const collapse = (text) =>
      String(text ?? "")
        .replace(/\*\*/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const inSidebar = (el) => Boolean(el.closest(sidebar));
    const seen = (el) => el.checkVisibility() && !inSidebar(el);
    const shownOf = (box, el) => {
      let [left, right, top, bottom] = [
        Math.max(box.left, 0),
        Math.min(box.right, innerWidth),
        Math.max(box.top, 0),
        Math.min(box.bottom, innerHeight),
      ];
      for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
        const style = getComputedStyle(a);
        const r = a.getBoundingClientRect();
        if (style.overflowX !== "visible")
          [left, right] = [Math.max(left, r.left), Math.min(right, r.right)];
        if (style.overflowY !== "visible")
          [top, bottom] = [Math.max(top, r.top), Math.min(bottom, r.bottom)];
      }
      const area = Math.max(box.width, 0.01) * Math.max(box.height, 0.01);
      if (right <= left || bottom <= top) return { fraction: 0, full: false };
      const fraction = ((right - left) * (bottom - top)) / area;
      const x = (left + right) / 2;
      const covered = [top + 1, (top + bottom) / 2, bottom - 1].some((y) => {
        const hit = document.elementFromPoint(x, y);
        return hit && !(el.contains(hit) || hit.contains(el));
      });
      return { fraction: covered ? 0 : Math.min(fraction, 1), full: !covered && fraction > 0.97 };
    };
    const locate = (needle, { lineOnly = false } = {}) => {
      const want = collapse(needle);
      if (!want) return [];
      const fields = [...document.querySelectorAll("textarea, input")]
        .filter((field) => seen(field) && collapse(field.value).includes(want))
        .map((el) => {
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const line = new DOMRect(
            box.left,
            box.top + Number.parseFloat(style.paddingTop),
            box.width,
            Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4,
          );
          return {
            el,
            box: lineOnly ? line : box,
            whole: lineOnly || el.scrollHeight <= el.clientHeight + 1,
          };
        });
      const holds = (el) => collapse(el.textContent).includes(want);
      const texts = [...document.querySelectorAll("main *, aside *")]
        .filter(
          (el) =>
            seen(el) &&
            !["TEXTAREA", "INPUT"].includes(el.tagName) &&
            holds(el) &&
            ![...el.children].some(holds),
        )
        .map((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return {
            el,
            box: lineOnly
              ? (range.getClientRects()[0] ?? range.getBoundingClientRect())
              : range.getBoundingClientRect(),
            whole: true,
          };
        });
      return [...fields, ...texts]
        .map((place) => {
          const { fraction, full } = shownOf(place.box, place.el);
          return { fraction, full: full && place.whole };
        })
        .sort((a, b) => Number(b.full) - Number(a.full) || b.fraction - a.fraction);
    };
    const primary = () => {
      const probe = document.body.appendChild(
        Object.assign(document.createElement("div"), { style: "background-color: var(--primary)" }),
      );
      const fill = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const buttons = [
        ...document.querySelectorAll("main button, main a, main [role=button], aside button"),
      ].filter((el) => seen(el) && /[a-z]{2}/i.test(el.innerText ?? ""));
      return (
        buttons.find((el) => getComputedStyle(el).backgroundColor === fill) ??
        buttons.find((el) => /review before|approve|send|post it/i.test(el.innerText)) ??
        null
      );
    };
    const textNodes = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode())
        if (
          walker.currentNode.textContent.trim() &&
          walker.currentNode.parentElement.checkVisibility()
        )
          nodes.push(walker.currentNode);
      return nodes.map((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return { node, range };
      });
    };
    const card = () =>
      primary()?.closest("article") ?? document.querySelector("main article") ?? null;
    const NEXT = /\bnext\b/i;
    const nextControl = () =>
      [...document.querySelectorAll("main button, main a")].find(
        (el) => seen(el) && NEXT.test(el.getAttribute("aria-label") ?? el.innerText ?? ""),
      );
    const strip = () => {
      const main = document.querySelector("main");
      let el =
        [...main.querySelectorAll("*")].find(
          (node) =>
            seen(node) &&
            node.children.length === 0 &&
            /^\d+ of \d+ \w+$/.test(collapse(node.textContent)),
        ) ??
        nextControl() ??
        null;
      while (
        el &&
        el.parentElement !== main &&
        !el.parentElement.querySelector("article, textarea")
      )
        el = el.parentElement;
      return el;
    };
    window.__land = {
      collapse,
      seen,
      shownOf,
      locate,
      primary,
      card,
      nextControl,
      strip,
      textNodes,
    };
  }, SIDEBAR);

const cardTop = (page) =>
  page.evaluate(() => window.__land?.card()?.getBoundingClientRect().top ?? null);

const settle = async (page) => {
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < ARRIVAL_MS && !ready) {
    await page.waitForTimeout(100);
    await installHelpers(page);
    ready = await page.evaluate(
      () =>
        Boolean(window.__land.primary() && window.__land.card()) &&
        !/\bworking\b/i.test(
          document.querySelector("main").innerText.split("\n").slice(-12).join(" "),
        ),
    );
  }
  await page.waitForTimeout(SETTLE_MS);
  const tops = [];
  for (let at = 0; at <= FINAL_SECOND_MS; at += 100) {
    tops.push(await cardTop(page));
    await page.waitForTimeout(100);
  }
  const known = tops.filter((top) => top !== null);
  return {
    ready,
    arrivedMs: Date.now() - started - SETTLE_MS - FINAL_SECOND_MS,
    topTravel: known.length ? Math.max(...known) - Math.min(...known) : null,
  };
};

const readScreen = (page, truth) =>
  page.evaluate((truth) => {
    const {
      collapse,
      seen,
      shownOf,
      locate,
      primary,
      card,
      nextControl: findNext,
      strip: findStrip,
      textNodes,
    } = window.__land;
    const main = document.querySelector("main");
    const leaves = [...main.querySelectorAll("*")].filter(
      (el) => seen(el) && el.children.length === 0,
    );
    const best = (needle, options) => locate(needle, options)[0] ?? null;
    const shown = (needle, options) => Boolean(best(needle, options)?.full);
    const button = primary();
    const action = button ? shownOf(button.getBoundingClientRect(), button) : { full: false };
    const totalShown = () =>
      leaves.some(
        (el) =>
          collapse(el.textContent) === String(truth.total) &&
          collapse(el.parentElement.parentElement.textContent).includes(`/ ${truth.outOf}`) &&
          shownOf(el.getBoundingClientRect(), el).full,
      );
    const parts =
      {
        grade: () => [
          ["criterion", shown(truth.criterion)],
          ["total", totalShown()],
          ["commentFirstLine", shown(collapse(truth.comment).slice(0, 40), { lineOnly: true })],
        ],
        reply: () => [["body", shown(truth.body)]],
        announcement: () => [
          ["title", shown(truth.title)],
          ["body", shown(truth.body)],
        ],
      }[truth.family]?.() ?? [];
    const whoShown = (
      truth.family === "announcement" ? [truth.courseCode, truth.courseTitle] : [truth.who]
    )
      .filter(Boolean)
      .some((name) => shown(name));
    const mainText = collapse(main.innerText);
    const askCounts = truth.userTexts.map((text) => ({
      text,
      count: mainText.split(collapse(text).replace(/[.?!]+$/, "")).length - 1,
    }));
    const marker = leaves.find((el) => /from north star/i.test(el.textContent));
    const markerBlock = marker?.closest('[role="note"]') ?? marker;
    const markerTop = marker?.getBoundingClientRect().top ?? null;
    const messageTops = [...truth.userTexts, ...truth.agentTexts, ...truth.workLines].flatMap(
      (text) => {
        const needle = collapse(text).slice(0, 40);
        const holds = (el) => collapse(el.textContent).includes(needle);
        return [...main.querySelectorAll("*")]
          .filter(
            (el) =>
              seen(el) && holds(el) && ![...el.children].some(holds) && !markerBlock?.contains(el),
          )
          .slice(0, 2)
          .map((el) => ({ text: needle, top: el.getBoundingClientRect().top }));
      },
    );
    const cardBox = card()?.getBoundingClientRect() ?? null;
    const above =
      markerTop === null
        ? []
        : [
            ...messageTops.filter((m) => m.top < markerTop).map((m) => m.text),
            ...(cardBox && cardBox.top < markerTop ? ["the draft card"] : []),
          ];
    const header = main.querySelector("header") ?? main.firstElementChild;
    const crumb = collapse(
      header?.querySelector("h1, h2")?.textContent ?? header?.innerText.split("\n").at(-1),
    );
    const heading = collapse(
      card()?.querySelector("h1, h2, h3, [role=heading]")?.textContent ??
        (card()?.innerText ?? "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line && !truth.schoolAbbrs.includes(line)),
    );
    const agentInView = truth.agentTexts.flatMap((text) => {
      const paragraphs = text
        .split(/\n\s*\n/)
        .map(collapse)
        .filter(Boolean);
      return (best(paragraphs[0]?.slice(0, 40) ?? "")?.fraction ?? 0) > 0.1
        ? paragraphs.map((paragraph) => paragraph.slice(0, 50))
        : [];
    });
    const previews = [...document.querySelectorAll("button, a, [role=tab], summary")]
      .filter(
        (el) =>
          seen(el) &&
          shownOf(el.getBoundingClientRect(), el).fraction > 0 &&
          /\bpreview\b/i.test((el.innerText || el.getAttribute("aria-label")) ?? ""),
      )
      .map((el) => collapse(el.innerText || el.getAttribute("aria-label")));
    const nextControl = findNext();
    const strip = findStrip();
    const centers = strip
      ? textNodes(strip)
          .flatMap(({ range }) =>
            [...range.getClientRects()]
              .filter((box) => box.height > 0 && box.width > 0)
              .map((box) => (box.top + box.bottom) / 2),
          )
          .sort((a, b) => a - b)
      : [];
    const stripLines = strip
      ? centers.filter((center, i) => i === 0 || center - centers[i - 1] > 8).length
      : null;
    const claimEl = [...document.querySelectorAll("main *, aside *")].find(
      (el) => seen(el) && el.children.length === 0 && /[\d,]+ words\b/.test(el.textContent),
    );
    let honest = null;
    if (claimEl) {
      let pane = claimEl;
      while (pane.parentElement && !["auto", "scroll"].includes(getComputedStyle(pane).overflowY))
        pane = pane.parentElement;
      honest = {
        claimed: Number(claimEl.textContent.match(/([\d,]+) words\b/)[1].replace(/,/g, "")),
        shownWords: collapse([...pane.querySelectorAll("p")].map((p) => p.innerText).join(" "))
          .split(" ")
          .filter(Boolean).length,
        saysExcerpt: /excerpt/i.test(pane.innerText),
      };
    }
    const count = (text) => collapse(text).split(" ").filter(Boolean).length;
    const words =
      textNodes(main)
        .filter(({ node }) => !node.parentElement.closest("textarea"))
        .reduce(
          (sum, { node, range }) =>
            sum +
            count(node.textContent) *
              shownOf(range.getBoundingClientRect(), node.parentElement).fraction,
          0,
        ) +
      [...main.querySelectorAll("textarea, input")]
        .filter((field) => field.checkVisibility())
        .reduce(
          (sum, field) =>
            sum +
            count(field.value || field.placeholder) *
              shownOf(field.getBoundingClientRect(), field).fraction,
          0,
        );
    const head = card()?.getBoundingClientRect();
    const onTop = head ? document.elementFromPoint(head.left + 8, head.top + 8) : null;
    parts.push(["draft card's top", Boolean(onTop && card().contains(onTop))]);
    const active = document.activeElement;
    const focusReady = Boolean(
      active &&
      active !== document.body &&
      (active.matches("[data-composer]") || active === button || button?.contains(active)),
    );
    return {
      primaryText: collapse(button?.innerText),
      actionFull: action.full,
      parts,
      whoShown,
      askCounts,
      markerFound: Boolean(marker),
      above,
      crumb,
      heading,
      agentInView,
      previews,
      stripFound: Boolean(strip),
      stripHeight: strip ? strip.getBoundingClientRect().height : null,
      stripLines,
      stripText: strip ? collapse(strip.innerText) : null,
      honest,
      words: Math.round(words),
      focus:
        active === document.body
          ? "body"
          : `${active?.tagName}:${active?.getAttribute("aria-label") ?? collapse(active?.innerText).slice(0, 24)}`,
      focusReady,
      nextVisible: Boolean(
        nextControl &&
        !nextControl.disabled &&
        shownOf(nextControl.getBoundingClientRect(), nextControl).full,
      ),
    };
  }, truth);

const readList = async (page, truth) => {
  const expand = page
    .locator("main")
    .getByRole("button", { name: /expand|(show|see|view).*(all|list|queue)|^all \d+/i })
    .first();
  if (!(await expand.count())) return null;
  await expand.click({ timeout: 1000 });
  await page.waitForTimeout(300);
  const list = await page.evaluate((truth) => {
    const { collapse, seen, strip } = window.__land;
    const band = strip();
    const title = collapse(truth.threadTitle).toLowerCase();
    const rows = [...(band?.querySelectorAll("li") ?? [])].filter(seen).map((el) => {
      const text = collapse(el.innerText);
      const repeats =
        [truth.courseCode, truth.assignmentShort, truth.assignmentTitle].some(
          (name) => name && text.includes(name),
        ) || text.toLowerCase().includes(title);
      return {
        text,
        namesStudent: truth.threadRows.some((name) => text.includes(name)),
        repeatsThread: repeats,
        badge: el.innerText.split("\n").some((line) => truth.schoolAbbrs.includes(line.trim())),
      };
    });
    const chips = [...(band?.querySelectorAll("button") ?? [])]
      .filter((el) => seen(el) && !el.closest("li") && /\d\s*$/.test(el.innerText))
      .map((el) => ({
        text: collapse(el.innerText),
        count: Number(el.innerText.match(/(\d+)\s*$/)[1]),
        top: Math.round(el.getBoundingClientRect().top),
      }));
    const tops = [...new Set(chips.map((chip) => chip.top))].sort((a, b) => a - b);
    return {
      rows,
      chips,
      wrapsAlone: tops.length > 1 && chips.filter((chip) => chip.top === tops.at(-1)).length === 1,
    };
  }, truth);
  await page.screenshot({ path: join(OUT, `${truth.landingKind}-list.png`) });
  const close = page
    .locator("main")
    .getByRole("button", { name: /collapse|hide/i })
    .first();
  if (await close.count()) await close.click({ timeout: 1000 });
  await page.waitForTimeout(300);
  return list;
};

const panelText = (page) =>
  page.evaluate(
    (sidebar) =>
      [...document.querySelectorAll("aside, [role=dialog]")]
        .filter((el) => !el.matches(sidebar))
        .map((el) => el.innerText)
        .join(" "),
    SIDEBAR,
  );

const pressPrimary = async (page, truth) => {
  await page.evaluate(() => window.__land.primary()?.setAttribute("data-land-primary", ""));
  const before = await panelText(page);
  await page.locator("[data-land-primary]").click({ timeout: 1500 });
  await page.waitForTimeout(400);
  const after = await readTruth(page);
  const panel = await panelText(page);
  return {
    sends: after.changeState !== truth.changeState,
    opensReview: panel !== before && /\bsend\b|\bapprove\b|will (change|post|go)/i.test(panel),
  };
};

const pressNext = async (page, screen) => {
  if (!screen.nextVisible) return false;
  const shownBefore = await page.evaluate(() => document.querySelector("main").innerText);
  await page
    .locator("main")
    .getByRole("button", { name: /\bnext\b/i })
    .first()
    .click({ timeout: 1000 });
  return page
    .waitForFunction((before) => document.querySelector("main").innerText !== before, shownBefore, {
      timeout: 3000,
    })
    .then(
      () => true,
      () => false,
    );
};

const scoreLanding = (kind, s, truth, arrival, list, pressedNext, rowName) => {
  const who = nameWords(truth.who ?? "");
  const names = [nameWords(s.crumb), nameWords(s.heading), nameWords(rowName)];
  const close = (x, y) =>
    x.size > 0 && [...x].filter((w) => y.has(w)).length / new Set([...x, ...y]).size >= 0.6;
  const agreed = [
    [0, 1],
    [0, 2],
    [1, 2],
  ].filter(
    ([a, b]) => close(names[a], names[b]) || close(without(names[a], who), without(names[b], who)),
  ).length;
  const asks = s.askCounts.map(({ count }) => (count === 0 ? (kind === "H" ? 0 : 1) : 1 / count));
  const rate = (test) => (list?.rows.length ? list.rows.filter(test).length / list.rows.length : 0);
  const atMostOne = (n) => (n <= 1 ? 1 : 1 / n);
  const entries = {
    actionInView: [
      s.actionFull ? 1 : 0,
      `"${s.primaryText}" ${s.actionFull ? "fully in view" : "cut off or missing"}`,
    ],
    essentialsInView: [
      mean(s.parts.map(([, inView]) => (inView ? 1 : 0))),
      s.parts.map(([part, inView]) => `${part}:${inView ? "in" : "out"}`).join(" "),
    ],
    whoInView: [
      s.whoShown ? 1 : 0,
      `${truth.family === "announcement" ? truth.courseCode : truth.who} ${s.whoShown ? "in view" : "not in view"}`,
    ],
    askOnce: [
      asks.length ? Math.min(...asks) : 1,
      s.askCounts.map(({ text, count }) => `"${text.slice(0, 32)}"x${count}`).join(" ") ||
        "no typed ask",
    ],
    oneName: [
      agreed === 3 ? 1 : 0,
      `crumb "${s.crumb}" | heading "${s.heading}" | row "${rowName}" | agree ${agreed}/3`,
    ],
    oneNarration: [
      atMostOne(s.agentInView.length),
      `${s.agentInView.length} agent paragraphs in view`,
    ],
    onePreview: [atMostOne(s.previews.length), `${s.previews.length} Preview controls`],
    honestText: [
      !s.honest || s.honest.saysExcerpt ? 1 : clamp(s.honest.shownWords / (s.honest.claimed / 2)),
      s.honest
        ? `claims ${s.honest.claimed} words, pane shows ${s.honest.shownWords}${s.honest.saysExcerpt ? ", says excerpt" : ""}`
        : "no word count shown",
    ],
    stillOnArrival: [
      arrival.topTravel !== null && arrival.topTravel < 8 ? 1 : 0,
      `shift ${arrival.shift.toFixed(3)}, card top moved ${arrival.topTravel?.toFixed(1) ?? "n/a"}px in the final second, draft after ${arrival.arrivedMs}ms`,
    ],
    focusReady: [s.focusReady ? 1 : 0, `focus on ${s.focus}`],
    fewWords: [linear(s.words, 120, 240), `${s.words} words in the main pane`],
    ...(kind === "H"
      ? {
          orderReads: [
            s.markerFound && s.above.length === 0 ? 1 : 0,
            s.markerFound
              ? `above the marker: ${s.above.join(" | ") || "nothing"}`
              : "no From North Star marker",
          ],
        }
      : {}),
    ...(LISTED.includes(kind)
      ? {
          listQuiet: list
            ? [
                mean([
                  rate((r) => r.namesStudent),
                  rate((r) => !r.repeatsThread),
                  rate((r) => !r.badge),
                  list.chips.length
                    ? list.chips.filter((c) => c.count > 0).length / list.chips.length
                    : 1,
                  list.wrapsAlone ? 0 : 1,
                ]),
                `${list.rows.length} rows: ${list.rows.filter((r) => r.namesStudent).length} name a student, ${list.rows.filter((r) => r.repeatsThread).length} repeat the thread, ${list.rows.filter((r) => r.badge).length} repeat the badge. Chips ${list.chips.map((c) => c.text).join(", ")}${list.wrapsAlone ? ", one wraps alone" : ""}`,
              ]
            : [0, "no control expands a list"],
          nextReachable: [
            pressedNext ? 1 : 0,
            s.nextVisible
              ? pressedNext
                ? "next control moved on"
                : "next control did nothing"
              : "no next control in view",
          ],
        }
      : {}),
  };
  return {
    scored: Object.fromEntries(Object.entries(entries).map(([name, [score]]) => [name, score])),
    evidence: {
      ...Object.fromEntries(Object.entries(entries).map(([name, [, text]]) => [name, text])),
      stripOneLine: s.stripFound
        ? `${s.stripLines} text row(s), ${s.stripHeight}px: ${s.stripText}`
        : "no strip",
    },
  };
};

const runLanding = async (browser, base, kind, pageErrors) => {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1.5,
  });
  try {
    await context.addInitScript(() => {
      window.__shift = 0;
      new PerformanceObserver((list) =>
        list.getEntries().forEach((entry) => (window.__shift += entry.value)),
      ).observe({ type: "layout-shift", buffered: true });
    });
    if (INJECT) await context.addInitScript({ path: resolve(INJECT) });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(`${kind}: ${error.message}`));
    let minutes = 0;
    const tick = () => page.clock.setFixedTime(new Date(FIXED_NOW.getTime() + ++minutes * 60000));
    await page.clock.setFixedTime(FIXED_NOW);
    await onboard(page, base);
    const { row, rowName } = await JOURNEYS[kind]({ page, base, tick, settle: () => settle(page) });
    const shiftBefore = await page.evaluate(() => window.__shift);
    await row.click({ timeout: 2000 });
    const timing = await settle(page);
    if (!timing.ready)
      throw new Error(
        `no draft card with a primary action within ${ARRIVAL_MS}ms at ${page.url()}`,
      );
    const arrival = { ...timing, shift: (await page.evaluate(() => window.__shift)) - shiftBefore };
    await page.screenshot({ path: join(OUT, `${kind}.png`) });
    const truth = { ...(await readTruth(page)), landingKind: kind };
    if (!truth.changeId) throw new Error(`landed with no focused draft at ${page.url()}`);
    const screen = await readScreen(page, truth);
    const list = await readList(page, truth).catch((error) => ({
      rows: [],
      chips: [],
      wrapsAlone: false,
      error: error.message,
    }));
    const pressed = await pressPrimary(page, truth).catch((error) => ({
      sends: null,
      opensReview: false,
      error: error.message,
    }));
    const pressedNext = await pressNext(page, screen).catch(() => false);
    return {
      kind,
      ok: true,
      truth,
      screen,
      list,
      pressed,
      rowName,
      ...scoreLanding(kind, screen, truth, arrival, list, pressedNext, rowName),
    };
  } catch (error) {
    return {
      kind,
      ok: false,
      error: String(error.message ?? error).split("\n")[0],
      scored: {},
      evidence: {},
    };
  } finally {
    await context.close();
  }
};

const capture = async () => {
  const vite = await startDevServer();
  const base = vite.origin;
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const pageErrors = [];
    const landings = [];
    for (const kind of Object.keys(JOURNEYS)) {
      const first = await runLanding(browser, base, kind, pageErrors);
      landings.push(
        first.ok
          ? first
          : { ...(await runLanding(browser, base, kind, pageErrors)), retried: first.error },
      );
    }
    return { landings, pageErrors };
  } finally {
    await browser.close();
    await vite.close();
  }
};

const CHECK_NAMES = [
  "actionInView",
  "essentialsInView",
  "whoInView",
  "askOnce",
  "orderReads",
  "oneName",
  "oneNarration",
  "onePreview",
  "stripOneLine",
  "honestText",
  "listQuiet",
  "stillOnArrival",
  "focusReady",
  "fewWords",
  "nextReachable",
];

const aggregate = (landings) => {
  const applies = (name, kind) =>
    name === "orderReads"
      ? kind === "H"
      : ["listQuiet", "nextReachable"].includes(name)
        ? LISTED.includes(kind)
        : true;
  const strips = landings.filter((l) => l.ok && l.screen.stripFound);
  const heights = strips.map((l) => l.screen.stripHeight);
  const sameHeight = heights.length < 2 || Math.max(...heights) - Math.min(...heights) <= 1;
  const stripScore = strips.length
    ? mean(strips.map((l) => (l.screen.stripLines === 1 ? 1 : 0))) * (sameHeight ? 1 : 0.5)
    : landings.every((l) => l.ok)
      ? 1
      : 0;
  const checks = Object.fromEntries(
    CHECK_NAMES.map((name) => [
      name,
      name === "stripOneLine"
        ? stripScore
        : mean(landings.filter((l) => applies(name, l.kind)).map((l) => l.scored[name] ?? 0)),
    ]),
  );
  return { checks, stripHeights: heights, sameHeight };
};

const runReader = async (prompt, files) => {
  const dir = await mkdtemp(join(tmpdir(), "land-reader-"));
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

const pooled = async (jobs, width) => {
  const results = [];
  const queue = jobs.map((job, at) => [job, at]);
  const worker = async () => {
    while (queue.length) {
      const [job, at] = queue.shift();
      results[at] = await job();
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
};

const compareOne = async (image, baseline, swapped) => {
  const result = await runReader(
    COMPARE(ROLE),
    swapped ? { "a.png": baseline, "b.png": image } : { "a.png": image, "b.png": baseline },
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

const gradeAnswer = (answer, landing) => {
  const { truth, pressed } = landing;
  const said = norm(answer.for_whom);
  const whoTerms =
    truth.family === "announcement"
      ? [truth.courseCode, truth.courseTitle]
      : norm(truth.who).split(" ");
  const wantButton = pressed.sends ? "sends_now" : pressed.opensReview ? "review_first" : "other";
  const detail = norm(answer.proposal_detail);
  const source = norm(
    truth.family === "announcement" ? `${truth.title} ${truth.body}` : truth.body,
  );
  const words = detail.split(" ");
  const quotes = words.some(
    (_, i) => i + 3 <= words.length && source.includes(words.slice(i, i + 3).join(" ")),
  );
  const detailRight =
    truth.family === "grade" ? new RegExp(`\\b${truth.total}\\b`).test(detail) : quotes;
  return {
    who: whoTerms
      .filter(Boolean)
      .some((term) => norm(term).length >= 3 && said.includes(norm(term)))
      ? 1
      : 0,
    button: norm(answer.main_button_does).replace(/ /g, "_") === wantButton ? 1 : 0,
    proposes: (norm(answer.proposal_kind) === truth.family ? 0.5 : 0) + (detailRight ? 0.5 : 0),
    sent:
      norm(answer.sent_yet) === (["draft", "approved"].includes(truth.changeState) ? "no" : "yes")
        ? 1
        : 0,
  };
};

const askReaders = async (landings) => {
  const readable = landings.filter((l) => READ_KINDS.includes(l.kind));
  const missing = [];
  const jobs = [];
  for (const landing of readable) {
    if (!landing.ok) continue;
    const image = join(OUT, `${landing.kind}.png`);
    for (let i = 0; i < READERS; i++)
      jobs.push(async () => ({
        kind: landing.kind,
        type: "ask",
        ...(await runReader(PROMPT(ROLE), { "screen.png": image })),
      }));
    const baseline = reference(landing.kind);
    if (
      await access(baseline).then(
        () => true,
        () => false,
      )
    ) {
      for (let i = 0; i < READERS; i++)
        jobs.push(async () => ({
          kind: landing.kind,
          type: "compare",
          ...(await compareOne(image, baseline, i % 2 === 1)),
        }));
    } else missing.push(baseline);
  }
  const results = await pooled(jobs, PARALLEL_READERS);
  const answers = results.filter((r) => r.type === "ask" && r.answer);
  const compared = results.filter((r) => r.type === "compare" && r.answer);
  const perKind = {};
  for (const landing of readable) {
    const asked = landing.ok
      ? answers.filter((a) => a.kind === landing.kind).map((a) => gradeAnswer(a.answer, landing))
      : [];
    const ab = landing.ok
      ? compared.filter((c) => c.kind === landing.kind).map((c) => c.answer)
      : [];
    perKind[landing.kind] = Object.fromEntries([
      ...["who", "button", "proposes", "sent"].map((key) => [key, mean(asked.map((a) => a[key]))]),
      ...["calmer", "clearer"].map((key) => [key, mean(ab.map((c) => c[key]))]),
    ]);
  }
  const parts = Object.fromEntries(
    ["who", "button", "proposes", "sent", "calmer", "clearer"].map((key) => [
      key,
      Math.round(mean(Object.values(perKind).map((k) => k[key])) * 100),
    ]),
  );
  return {
    score: mean(Object.values(parts)),
    parts,
    perKind,
    asked: jobs.length,
    answered: answers.length + compared.length,
    errors: jobs.length - answers.length - compared.length,
    missing,
    cost: results.reduce((sum, r) => sum + r.cost, 0),
    answers: answers.map((a) => ({ kind: a.kind, ...a.answer })),
    compared: compared.map((c) => ({ kind: c.kind, ...c.answer })),
  };
};

await mkdir(OUT, { recursive: true });
const { landings, pageErrors } = await capture();
const { checks, stripHeights, sameHeight } = aggregate(landings);
const objective = mean(Object.values(checks)) * 100;
const landingErrors = landings.filter((l) => !l.ok);
const drafts = landings.filter((l) => l.ok).length;
const checksLine = Object.entries(checks)
  .map(([key, value]) => `${key} ${value.toFixed(2)}`)
  .join(" ");
for (const landing of landings) {
  if (landing.retried)
    console.log(`landing ${landing.kind}: retried once after ${landing.retried}`);
  if (!landing.ok) {
    console.log(`landing ${landing.kind}: ERROR ${landing.error}`);
    continue;
  }
  console.log(
    `landing ${landing.kind} (${landing.truth.family}, ${landing.truth.who ?? landing.truth.courseCode}):`,
  );
  for (const name of CHECK_NAMES)
    if (landing.evidence[name] !== undefined)
      console.log(
        `  ${name} ${landing.scored[name]?.toFixed(2) ?? "-"}: ${landing.evidence[name]}`,
      );
}
console.log(`strip heights ${stripHeights.join(", ") || "none"} ${sameHeight ? "same" : "differ"}`);
console.log(
  `captured ${WIDTH}x${HEIGHT}: landings ${drafts}/${landings.length} with a draft, landing errors ${landingErrors.length}${landingErrors.length ? ` (${landingErrors.map((l) => l.kind).join(",")})` : ""}, page errors ${pageErrors.length}`,
);
console.log(`CHECKS ${objective.toFixed(0)}/100 [${checksLine}]`);
let report = {
  label: LABEL,
  viewport: `${WIDTH}x${HEIGHT}`,
  objective,
  checks,
  landingErrors: landingErrors.map((l) => ({ kind: l.kind, error: l.error })),
  pageErrors,
  landings: landings.map(({ kind, ok, truth, scored, evidence, pressed, rowName, error }) => ({
    kind,
    ok,
    error,
    rowName,
    truth,
    scored,
    evidence,
    pressed,
  })),
};
if (!CAPTURE_ONLY) {
  const readers = await askReaders(landings);
  const land = Math.round((objective + readers.score) / 2);
  report = {
    ...report,
    land,
    readers: readers.score,
    parts: readers.parts,
    perKind: readers.perKind,
    readersAsked: readers.asked,
    readersAnswered: readers.answered,
    readerErrors: readers.errors,
    missingReferences: readers.missing,
    cost: readers.cost,
    answers: readers.answers,
    compared: readers.compared,
  };
  if (readers.missing.length) console.log(`missing references: ${readers.missing.join(", ")}`);
  console.log(
    `LAND ${land}/100 ${LABEL} checks ${objective.toFixed(0)} readers ${readers.score.toFixed(0)} [${Object.entries(
      readers.parts,
    )
      .map(([key, value]) => `${key} ${value}`)
      .join(
        " ",
      )}] answered ${readers.answered}/${readers.asked} errors ${readers.errors} landing errors ${landingErrors.length} page errors ${pageErrors.length} work ${drafts}/${landings.length} cost $${readers.cost.toFixed(3)}`,
  );
}
await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));
process.exit(0);
