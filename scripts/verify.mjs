// Drives the real app in real headless Chrome with trusted mouse and key events. Starts its own vite and Chrome, and stops only those two processes.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUDIT_PAGE,
  CATEGORIES,
  CLEAN_SEED,
  SEED_PAGES,
  TWIN_IMAGES,
  unnumbered,
} from "./verify/layout-audit.mjs";
import { startDevServer } from "./dev-server.mjs";

const ONLY = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const ALL_MODULES = [
  "settings",
  "grading",
  "grading-list",
  "courses",
  "term",
  "followups",
  "north-star",
  "focus",
  "theme",
];
const MODULES = ONLY ? [ONLY] : ALL_MODULES;
const strayTwins = Object.keys(TWIN_IMAGES).filter((name) => !ALL_MODULES.includes(name));
if (strayTwins.length) throw new Error(`TWIN_IMAGES names no verify module: ${strayTwins}`);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = process.env.VERIFY_SHOTS
  ? join(ROOT, process.env.VERIFY_SHOTS)
  : join(ROOT, "out", "screenshots");
const AUDIT_OUT = process.env.VERIFY_AUDIT_OUT
  ? join(ROOT, process.env.VERIFY_AUDIT_OUT)
  : join(tmpdir(), "constellation-layout-audit.json");
const AUDIT_GATE = process.env.VERIFY_AUDIT !== "report";
const TWIN = { width: 1180, height: 800 };
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WAIT_MS = 10_000;
const POLL_MS = 40;
const SETTLE_MS = 500;
const TWIN_SETTLE_MS = 120;
const MODIFIER = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const KEY_CODES = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  ArrowUp: 38,
  " ": 32,
};
const BRACKET_CODE = { "[": "BracketLeft", "]": "BracketRight" };
const CLICK_SEED = `<a style="position:absolute;left:100px;top:100px;width:200px;height:28px">Reply to Wren Calloway</a><button style="position:absolute;left:100px;top:100px;width:200px;height:28px;margin:0;padding:0;border:0" onclick="this.dataset.clicked = 'yes'">Grade Speech 2</button>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const untilOk = async (url, what) => {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`${what} did not come up at ${url}`);
};

const stop = (child) =>
  new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000);
  });

const IS_CSS = /^[[.#]|^[a-z][a-z0-9]*[[.#:]/;

// Runs in the page. Buttons and other controls win over plain text, so "Approve" finds the button rather than a sentence about approving.
const FINDER = `(query, css, within, nth) => {
  const scope = within ? document.querySelector(within) : document;
  if (!scope) return null;
  const shows = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  if (css) return [...scope.querySelectorAll(query)].filter(shows)[nth] ?? null;
  const clean = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
  const controls = [...scope.querySelectorAll("button, a, [role=button], [role=tab], summary, label")].filter(shows);
  const name = (el) => clean(el.getAttribute("aria-label")) || clean(el.textContent);
  const hits = controls.filter((el) => name(el) === query);
  const starts = controls.filter((el) => name(el).startsWith(query));
  const holds = controls.filter((el) => name(el).includes(query));
  const pick = hits[nth] ?? starts[nth] ?? holds[nth];
  if (pick) return pick;
  const leaves = [...scope.querySelectorAll("*")].filter((el) => shows(el) && clean(el.textContent).includes(query) && ![...el.children].some((child) => clean(child.textContent).includes(query)));
  return leaves[nth] ?? null;
}`;

const main = async () => {
  await mkdir(SHOTS, { recursive: true });
  if (!ONLY)
    await Promise.all(
      (await readdir(SHOTS)).map((name) => rm(join(SHOTS, name), { recursive: true, force: true })),
    );
  await mkdir(SHOTS, { recursive: true });
  const debugPort = await freePort();
  const profile = await mkdtemp(join(tmpdir(), "lms-verify-"));
  const vite = await startDevServer();
  const { origin } = vite;
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--hide-scrollbars",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const failures = [];
  let passes = 0;
  const pageErrors = [];
  const consoleEntries = [];
  let shotIndex = 0;
  const twinned = new Set();
  let twinImages = [];
  const auditStates = [];

  const cleanup = async () => {
    await Promise.all([stop(chrome), vite.close()]);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void cleanup().then(() => process.exit(1)));
  }

  try {
    await untilOk(`http://127.0.0.1:${debugPort}/json/version`, "Chrome");
    const { webSocketDebuggerUrl } = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/version`)
    ).json();
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener("open", resolve));

    let seq = 0;
    let session = null;
    const waiting = new Map();
    const loaded = [];
    const listeners = new Map();
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id && message.sessionId !== session) return;
      if (
        /^(Runtime\.consoleAPICalled|Runtime\.exceptionThrown|Log\.entryAdded)$/.test(
          message.method ?? "",
        )
      )
        consoleEntries.push(JSON.stringify(message.params));
      if (!message.id) listeners.get(message.method)?.(message.params);
      if (message.id) {
        const entry = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) entry?.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry?.resolve(message.result);
      } else if (message.method === "Page.loadEventFired") loaded.shift()?.();
      else if (message.method === "Runtime.exceptionThrown")
        pageErrors.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text,
        );
      else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error")
        pageErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
      else if (message.method === "Log.entryAdded" && message.params.entry.level === "error")
        pageErrors.push(`${message.params.entry.text} ${message.params.entry.url ?? ""}`);
    });
    const send = (method, params = {}, sessionId = session) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        );
      return result.result.value;
    };

    // A page in its own browser context starts with no storage at all, and nothing an earlier page writes late can reach it.
    let context = null;
    const freshPage = async () => {
      if (context) await send("Target.disposeBrowserContext", { browserContextId: context }, null);
      ({ browserContextId: context } = await send("Target.createBrowserContext", {}, null));
      const { targetId } = await send(
        "Target.createTarget",
        { url: "about:blank", browserContextId: context },
        null,
      );
      ({ sessionId: session } = await send(
        "Target.attachToTarget",
        { targetId, flatten: true },
        null,
      ));
      loaded.length = 0;
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Log.enable");
      await media({});
    };
    // Every module sees the dark theme and full motion, whatever the machine's own settings. A module overrides one by name, and the rest keep these.
    const media = (features) =>
      send("Emulation.setEmulatedMedia", {
        features: Object.entries({
          "prefers-color-scheme": "dark",
          "prefers-reduced-motion": "no-preference",
          ...features,
        }).map(([name, value]) => ({ name, value })),
      });
    await freshPage();

    const locate = (query, within, nth) =>
      `(${FINDER})(${JSON.stringify(query)}, ${IS_CSS.test(query)}, ${JSON.stringify(within ?? null)}, ${nth})`;

    // Null while the target is missing, disabled, or under something else, so a click can only land where a person's would.
    // The press listener judges a hit by the same rule, at the moment of the press, because the click may unmount the target or navigate.
    const hitPoint = (query, within, nth) =>
      evaluate(`(() => {
        const el = ${locate(query, within, nth)};
        if (!el || el.disabled) return null;
        el.scrollIntoViewIfNeeded?.();
        const covers = (top, el) => top === el || el.contains(top) || top.contains(el);
        const centre = (el) => {
          const rects = el.getClientRects();
          const r = rects.length > 1 ? rects[0] : el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };
        // pointerdown, not mousedown: a control that cancels pointerdown (the row Settle sweep) suppresses mousedown.
        window.__pressWatch ??= (addEventListener("pointerdown", (event) => {
          const aim = window.__aim;
          window.__aim = null;
          if (!aim) return;
          const landed = event.target.closest("button, a, [role=button], [role=tab], summary, label, input, select, textarea") ?? event.target;
          const id = landed.getAttribute("data-testid");
          const words = (landed.innerText ?? "").replace(/\\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
          const now = aim.el.isConnected && centre(aim.el);
          window.__press = {
            hit: covers(event.target, aim.el),
            landed: "<" + landed.localName + ">" + (id ? " [data-testid=" + id + "]" : words ? ' "' + words + '"' : ""),
            moved: now && Math.round(now.x - aim.x) + "," + Math.round(now.y - aim.y) + " px",
          };
        }, true), true);
        const reachable = () => {
          const { x, y } = centre(el);
          const top = document.elementFromPoint(x, y);
          if (!top || !covers(top, el)) return null;
          window.__aim = { el, x, y };
          window.__press = null;
          return { x, y };
        };
        const point = reachable();
        if (point) return point;
        // scrollIntoViewIfNeeded can leave the target under a sticky bar; centering clears it.
        el.scrollIntoView({ block: "center" });
        return reachable();
      })()`);

    const waitPoint = async (query, within, nth, timeout) => {
      const end = Date.now() + timeout;
      // A point only counts once it holds still. A click aimed at something still sliding or reflowing lands beside it.
      let last = null;
      for (;;) {
        const point = await hitPoint(query, within, nth);
        if (point && last && point.x === last.x && point.y === last.y) return point;
        last = point;
        if (Date.now() > end)
          throw new Error(
            `nothing clickable for ${JSON.stringify(query)}${within ? ` within ${within}` : ""}`,
          );
        await sleep(POLL_MS);
      }
    };

    const t = {
      origin,
      shots: SHOTS,
      sleep,
      consoleEntries,
      cdp: send,
      media,
      /** Calls `handler` with each CDP event named `method` until the returned function stops it. */
      on(method, handler) {
        listeners.set(method, handler);
        return () => listeners.delete(method);
      },
      eval: evaluate,
      async goto(path) {
        const load = new Promise((resolve) => loaded.push(resolve));
        await send("Page.navigate", { url: `${origin}${path}` });
        await load;
      },
      async reload() {
        const load = new Promise((resolve) => loaded.push(resolve));
        await send("Page.reload");
        await load;
      },
      async viewport(width, height) {
        t.size = { width, height };
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 2,
          mobile: false,
        });
      },
      async hover(query, { within, nth = 0, timeout = WAIT_MS } = {}) {
        const { x, y } = await waitPoint(query, within, nth, timeout);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      },
      async click(query, { within, nth = 0, timeout = WAIT_MS } = {}) {
        const { x, y } = await waitPoint(query, within, nth, timeout);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        // A full navigation takes the record with the old page, which leaves nothing to judge, so that click passes.
        const press = await evaluate(
          `(() => { const press = window.__press; window.__press = null; return press ?? (window.__aim ? { unseen: true } : null); })()`,
        ).catch(() => null);
        if (press?.unseen)
          throw new Error(`click aimed at ${JSON.stringify(query)}: no press reached the page`);
        if (press && !press.hit)
          throw new Error(
            `click aimed at ${JSON.stringify(query)} landed on ${press.landed}; ${press.moved ? `the target moved ${press.moved}` : "the target is gone"}`,
          );
      },
      // Every press and release goes out at once, so nothing the app waits out can pass between the clicks. Returns what each click landed on and its gap from the first.
      async clickAtOnce(selectors) {
        const points = await evaluate(
          `${JSON.stringify(selectors)}.map((selector) => { const el = document.querySelector(selector); el.scrollIntoViewIfNeeded?.(); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`,
        );
        await evaluate(
          `void (window.__clicks = [], window.__clickWatch ??= (addEventListener("click", (event) => window.__clicks.push({ trusted: event.isTrusted, at: event.timeStamp, label: (event.target.closest("button,input")?.innerText ?? "").trim(), aria: event.target.closest("button,input")?.getAttribute("aria-label") ?? "" }), true), true))`,
        );
        await Promise.all(
          points.flatMap(({ x, y }) => [
            send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
            send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              buttons: 1,
              clickCount: 1,
            }),
            send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 1,
            }),
          ]),
        );
        const clicks = await evaluate(`window.__clicks`);
        return clicks.map((click) => ({ ...click, gapMs: click.at - clicks[0].at }));
      },
      async wheel(selector, deltaY, deltaX = 0) {
        const { x, y } = await waitPoint(selector, undefined, 0, WAIT_MS);
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
      },
      async type(text) {
        for (const char of text) {
          await send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: char,
            text: char,
            unmodifiedText: char,
          });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
        }
      },
      async key(combo) {
        const parts = combo === "+" ? ["+"] : combo.split("+");
        const key = parts.pop();
        const modifiers = parts.reduce((bits, part) => bits | MODIFIER[part], 0);
        const code =
          key.length === 1
            ? (BRACKET_CODE[key] ??
              (/[a-z]/i.test(key)
                ? `Key${key.toUpperCase()}`
                : /\d/.test(key)
                  ? `Digit${key}`
                  : undefined))
            : key;
        const windowsVirtualKeyCode = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
        const typed =
          modifiers === 0 || modifiers === MODIFIER.Shift
            ? key === "Enter"
              ? "\r"
              : key.length === 1
                ? key
                : undefined
            : undefined;
        const base = { key, ...(code ? { code } : {}), windowsVirtualKeyCode, modifiers };
        await send("Input.dispatchKeyEvent", {
          type: typed ? "keyDown" : "rawKeyDown",
          ...base,
          ...(typed ? { text: typed, unmodifiedText: typed } : {}),
        });
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      },
      hold: (key) =>
        send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key,
          code: `${key}Left`,
          modifiers: MODIFIER[key],
        }),
      release: (key) => send("Input.dispatchKeyEvent", { type: "keyUp", key, code: `${key}Left` }),
      assert(ok, label, detail = "") {
        if (ok) {
          passes++;
          console.log(`pass  ${label}`);
        } else {
          failures.push(label);
          console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
        }
      },
      /** Polls a page expression until it is truthy, counts as a check, and stops the module if it never is. */
      async waitFor(expression, label, timeout = WAIT_MS) {
        const end = Date.now() + timeout;
        for (;;) {
          if (await evaluate(`Boolean(${expression})`)) {
            t.assert(true, label);
            return;
          }
          if (Date.now() > end) throw new Error(`timed out: ${label}`);
          await sleep(POLL_MS);
        }
      },
      waitText(text, label = `shows "${text}"`, timeout) {
        return t.waitFor(
          `document.body.innerText.includes(${JSON.stringify(text)})`,
          label,
          timeout,
        );
      },
      async openGradingList() {
        await t.click("What's due", { within: '[data-testid="sidebar"]' });
        await t.click('[data-testid="grading-list-link"]');
        await t.waitFor(
          `document.querySelector('[data-testid="pinned-queue"]')`,
          "What's due links to the grading list",
        );
      },
      has: (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
      text: (selector) =>
        evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`),
      pageText: () => evaluate(`document.body.innerText`),
      box: (selector) =>
        evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; })()`,
        ),
      async shot(name, number = ++shotIndex) {
        await evaluate(
          `Promise.race([Promise.allSettled(document.getAnimations().filter((a) => a.effect.getTiming().iterations !== Infinity).map((a) => a.finished)), new Promise((done) => setTimeout(done, ${SETTLE_MS}))]).then(() => null)`,
        );
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        const words = await evaluate(`document.body.innerText`);
        t.assert(
          !/\bdiffs?\b/i.test(words) && !/\+\d+\s+-\d+/.test(words),
          `${name}: no diff wording or line counts on screen`,
        );
        const file =
          number === null ? `${name}.png` : `${String(number).padStart(2, "0")}-${name}.png`;
        await writeFile(join(SHOTS, file), Buffer.from(data, "base64"));
        const base = file.replace(/\.png$/, "");
        t.recordAudit(base, await evaluate(AUDIT_PAGE));
        if (t.size?.width !== TWIN.width && !name.startsWith("FAILED")) await t.twin(base);
      },
      recordAudit(state, { found, census }) {
        const total = CATEGORIES.reduce((sum, category) => sum + found[category].length, 0);
        auditStates.push({
          state,
          width: t.size?.width,
          height: t.size?.height,
          total,
          found,
          census,
        });
        if (AUDIT_GATE)
          t.assert(
            total === 0,
            `${state} at ${t.size?.width}: layout audit is clean`,
            CATEGORIES.flatMap((category) =>
              found[category].map((line) => `${category}: ${line}`),
            ).join("\n      "),
          );
      },
      // Sees the same state at 1180, then puts the window and every scroll position back, so the steps after the shot don't notice.
      async twin(base) {
        const { width, height } = t.size;
        const positions = `[...document.querySelectorAll("*")].filter((el) => el.scrollTop || el.scrollLeft)`;
        await evaluate(
          `void (window.__twinScroll = ${positions}.map((el) => [el, el.scrollTop, el.scrollLeft]))`,
        );
        await t.viewport(TWIN.width, TWIN.height);
        await sleep(TWIN_SETTLE_MS);
        await evaluate(
          `Promise.race([Promise.allSettled(document.getAnimations().filter((a) => a.effect.getTiming().iterations !== Infinity).map((a) => a.finished)), new Promise((done) => setTimeout(done, ${SETTLE_MS}))]).then(() => null)`,
        );
        t.recordAudit(`${base}-1180`, await evaluate(AUDIT_PAGE));
        if (twinImages.includes(unnumbered(base))) {
          twinned.add(unnumbered(base));
          const { data } = await send("Page.captureScreenshot", { format: "png" });
          await writeFile(join(SHOTS, `${base}-1180.png`), Buffer.from(data, "base64"));
        }
        await t.viewport(width, height);
        await sleep(TWIN_SETTLE_MS);
        await evaluate(
          `window.__twinScroll.forEach(([el, top, left]) => { el.scrollTop = top; el.scrollLeft = left; })`,
        );
      },
      // A passing audit only means something if the same code catches each defect on purpose.
      async auditSeeds() {
        await t.viewport(1000, 800);
        const seed = async (html) => {
          await evaluate(`document.body.innerHTML = ${JSON.stringify(html)}`);
          return evaluate(AUDIT_PAGE);
        };
        for (const [html, expectations] of SEED_PAGES) {
          const seeded = await seed(html);
          for (const [category, marker] of expectations) {
            t.assert(
              seeded.found[category].some((line) => line.includes(marker)),
              `audit seed: ${category} catches ${marker}`,
              JSON.stringify(seeded.found[category]),
            );
          }
        }
        const clean = await seed(CLEAN_SEED);
        const noise = CATEGORIES.flatMap((category) =>
          clean.found[category].map((line) => `${category}: ${line}`),
        );
        t.assert(noise.length === 0, "audit seed: a clean page raises nothing", noise.join("; "));
      },
      // The click check only means something if it fails a press that lands beside its target.
      async clickSeeds() {
        const seed = (html) => evaluate(`void (document.body.innerHTML = ${JSON.stringify(html)})`);
        const clickError = () =>
          t.click("Grade Speech 2").then(
            () => "",
            (error) => error.message,
          );
        await seed(CLICK_SEED.replace("<button", `<button onmousemove="this.style.top = '72px'"`));
        const missed = await clickError();
        t.assert(
          missed.includes(`landed on <a> "Reply to Wren Calloway"`) &&
            missed.includes("moved 0,-28 px"),
          "click seed: a press that lands on the neighbour fails at the click",
          missed || "the click passed",
        );
        await seed(CLICK_SEED);
        const held = await clickError();
        t.assert(
          held === "" && (await t.has("[data-clicked]")),
          "click seed: a click on a target that holds still passes",
          held,
        );
      },
    };

    console.log("\n== layout audit seeds");
    await t.auditSeeds();

    console.log("\n== click seeds");
    await t.clickSeeds();

    for (const name of MODULES) {
      console.log(`\n== ${name}`);
      const module = await import(new URL(`./verify/${name}.mjs`, import.meta.url));
      // Each module starts as a first-time visitor, so its checks can't lean on what the last one left behind.
      await freshPage();
      twinImages = TWIN_IMAGES[name] ?? [];
      try {
        await module.run(t);
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        console.log(`FAIL  ${name} stopped: ${error.message}`);
        // A frozen page never answers the screenshot, so give up on it rather than hang the run.
        await Promise.race([t.shot(`FAILED-${name}`), sleep(5000)]).catch(() => {});
      }
      for (const image of twinImages)
        t.assert(twinned.has(image), `${name}: twin image ${image} matches a shot`);
    }
    socket.close();
  } finally {
    await cleanup();
  }

  for (const error of pageErrors) {
    failures.push(`page error: ${error}`);
    console.log(`FAIL  page error: ${error}`);
  }
  const tally = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      auditStates.reduce((sum, state) => sum + state.found[category].length, 0),
    ]),
  );
  const fonts = {};
  const buttons = {};
  let exemptRows = 0;
  for (const { census } of auditStates) {
    for (const [key, count] of Object.entries(census.font)) fonts[key] = (fonts[key] ?? 0) + count;
    for (const [key, count] of Object.entries(census.button))
      buttons[key] = (buttons[key] ?? 0) + count;
    exemptRows += census.exemptRows;
  }
  await mkdir(dirname(AUDIT_OUT), { recursive: true });
  await writeFile(
    AUDIT_OUT,
    JSON.stringify(
      { states: auditStates.length, tally, fonts, buttons, exemptRows, detail: auditStates },
      null,
      1,
    ),
  );
  console.log(
    `\nlayout audit: ${auditStates.length} states, ${auditStates.filter((state) => state.total === 0).length} clean`,
  );
  console.log(`  violations ${JSON.stringify(tally)}`);
  console.log(`  button heights ${JSON.stringify(buttons)}`);
  console.log(`  smallest text ${Math.min(...Object.keys(fonts).map((key) => parseFloat(key)))}px`);
  console.log(`\n${passes} passed, ${failures.length} failed`);
  return failures.length === 0;
};

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
