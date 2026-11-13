import { addAiKey } from "./ai-key.mjs";
import { expandCourse } from "./sidebar.mjs";

const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const NORTH_STAR = "/threads/t-north-star";
const SIDEBAR = '[data-testid="sidebar"]';
const GROUP = '[data-testid="handoff-group"]';
const BANNER = '[data-testid="handed-off"]';
const WAIT = 20_000;
const COMPOSER = "[data-composer]";
const HEADLINE = '[data-testid="hero-headline"]';
const ENG_REPLY = '[data-reply="ENG 305"]';

const shot = (t, name) => t.shot(`north-star-${name}`, null);
const count = (t, selector) =>
  t.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const lastGroup = (t) =>
  t.eval(`[...document.querySelectorAll(${JSON.stringify(GROUP)})].at(-1)?.innerText ?? ""`);
const lastGroupLinks = (t) =>
  t.eval(
    `[...[...document.querySelectorAll(${JSON.stringify(GROUP)})].at(-1).querySelectorAll("a")].map((a) => a.getAttribute("href"))`,
  );
const THREAD_MAIN = '[data-testid="thread-main"]';
const HEADER = '[data-testid="screen-header"]';
const pathname = (t) => t.eval(`location.pathname`);
const sidebarLink = (href) => `${SIDEBAR} a[href="${href}"]`;
const chatRows = (t) =>
  t.eval(
    `(() => { const { threads } = JSON.parse(localStorage.getItem("lms-app.v1")).state; return [...document.querySelectorAll(${JSON.stringify(`${SIDEBAR} a[href^="/threads/"]`)})].map((a) => a.getAttribute("href")).filter((href) => threads[decodeURIComponent(href.split("/threads/")[1])]?.kind === "north-star-chat"); })()`,
  );
const onNorthStar = (t, what) =>
  t.waitFor(`location.pathname === ${JSON.stringify(NORTH_STAR)}`, what);
const settled = (t, what) =>
  t.waitFor(
    `![...document.querySelectorAll('[data-testid="agent-working"]')].length && !document.querySelector(${JSON.stringify(GROUP)})?.innerText.includes("Working")`,
    what,
    WAIT,
  );

const ask = async (t, text) => {
  await t.click("[data-composer]");
  await t.type(text);
  await t.click('[aria-label="Send to agent"]');
};

const clearComposer = async (t) => {
  await t.click(COMPOSER);
  await t.eval(`document.querySelector(${JSON.stringify(COMPOSER)}).select()`);
  await t.key("Backspace");
};

const composerFocused = `document.activeElement === document.querySelector(${JSON.stringify(COMPOSER)})`;
const composerCard = (t) =>
  t.eval(
    `(() => { const { top, bottom, left, right, width } = document.querySelector(${JSON.stringify(COMPOSER)}).parentElement.getBoundingClientRect(); return { top, bottom, left, right, width }; })()`,
  );

const NEXT_UP = '[data-testid="next-up"]';
const NEXT_UP_ALL = '[data-testid="next-up-all"]';
const nextUpRows = (t) =>
  t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${NEXT_UP} [data-row]`)})].map((row) => { const { height, bottom } = row.firstElementChild.getBoundingClientRect(); return { key: row.dataset.row, text: row.innerText.replace(/\\s+/g, " "), height, bottom }; })`,
  );
const openThread = (t) =>
  t.eval(
    `JSON.parse(localStorage.getItem("lms-app.v1")).state.threads[decodeURIComponent(location.pathname.split("/threads/")[1] ?? "")] ?? null`,
  );
const backHome = async (t) => {
  await t.click(`${SIDEBAR} a[href="${NORTH_STAR}"]`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(NORTH_STAR)} && document.querySelector(${JSON.stringify(NEXT_UP)})`,
    "the sidebar returns to North Star with Next up",
  );
};

const glided = (t) =>
  t.waitFor(
    `!document.getAnimations().some((a) => a.effect?.pseudoElement?.startsWith("::view-transition"))`,
    "the glide finishes",
  );
const askFromHome = async (t, text) => {
  await t.type(text);
  await t.key("Enter");
  await t.waitFor(
    `location.pathname !== ${JSON.stringify(NORTH_STAR)} && document.querySelector('[data-testid="chat"]')`,
    `asking "${text}" opens a chat`,
  );
  await glided(t);
  await settled(t, `"${text}" settled`);
  return pathname(t);
};
const cleanHome = async (t, gone, what) => {
  await t.waitFor(
    `location.pathname === ${JSON.stringify(NORTH_STAR)} && document.querySelector(${JSON.stringify(HEADLINE)}) && document.querySelector(${JSON.stringify(NEXT_UP)})`,
    `${what}: home shows the headline and Next up`,
  );
  t.assert(
    !(await t.has('[data-testid="chat"]')) && !(await t.text(THREAD_MAIN)).includes(gone),
    `${what}: no trace of the conversation`,
    await t.text(THREAD_MAIN),
  );
  await t.waitFor(composerFocused, `${what}: the composer has focus`);
};

const DUE_FRAMES = `(() => {
  window.__dueFrames = [];
  const frame = () => {
    if (location.pathname === "/due") {
      const summary = document.querySelector('[data-testid="due-summary"]')?.innerText ?? null;
      const next = document.querySelector('[data-due-group="next"]')?.dataset.row ?? null;
      const seen = JSON.stringify({ summary, next });
      if (window.__dueFrames.at(-1) !== seen) window.__dueFrames.push(seen);
    }
    requestAnimationFrame(frame);
  };
  frame();
})()`;

// Where each setup row and the No AI option sit below the address field, as "host top height", so scrolling doesn't count.
const SETUP_LAYOUT = `(() => { const field = document.querySelector('[data-testid="address-field"]').getBoundingClientRect().top; return [...document.querySelectorAll('[data-host], input[name="ai-source"][value="none"]')].map((el) => { const r = el.getBoundingClientRect(); return \`\${el.dataset.host ?? "no AI"} \${Math.round(r.top - field)} \${Math.round(r.height)}\`; }); })()`;

// Issue #21: a person who connects every school and finishes without waiting, at the fake LMS's default latency.
const finishWaitsForReads = async (t) => {
  await t.goto("/welcome");
  await t.click("Set up");
  await t.click("Use demo institutions and tokens");
  await t.waitFor(`document.querySelectorAll("[data-host]").length > 1`, "a row per demo school");
  const hosts = await t.eval(
    `[...document.querySelectorAll("[data-host]")].map((el) => el.dataset.host)`,
  );
  await t.eval(`window.__faultLab.holdReads(true)`);
  await t.eval(`(() => {
    window.__setupLayouts = [];
    const frame = () => {
      if (!window.__setupLayouts) return;
      const seen = JSON.stringify(${SETUP_LAYOUT});
      if (window.__setupLayouts.at(-1) !== seen) window.__setupLayouts.push(seen);
      requestAnimationFrame(frame);
    };
    frame();
  })()`);
  // Last row first, so a connected row that jumped to the top would show.
  for (const host of hosts.toReversed()) {
    await t.click(`[data-host="${host}"] button[type="submit"]`);
    await t.waitFor(
      `document.querySelector('[data-host="${host}"] [data-testid="connect-stage"]')?.innerText === "Reading your courses"`,
      `setup: ${host} says it is reading courses`,
    );
    const layouts = await t.eval(`window.__setupLayouts`);
    t.assert(
      layouts.length === 1,
      `setup: from Connect until ${host} reads its courses, no row or AI option moves or changes size`,
      layouts.join(" -> "),
    );
  }
  t.assert(
    !(await t.eval(`document.querySelector('[data-testid="ai-choices"]').disabled`)),
    "setup: the AI choice opens once a school connects",
  );
  await t.click(`input[name="ai-source"][value="none"]`);
  await t.waitFor(
    `document.querySelector('input[name="ai-source"][value="none"]').checked`,
    "setup: no AI is chosen while the courses are read",
  );
  t.assert(
    (await t.eval(`window.__setupLayouts.length`)) === 1,
    "setup: choosing No AI moves no row",
  );
  await t.eval(`window.__setupLayouts = null`);
  const finish = await t.eval(
    `(() => { const button = [...document.querySelectorAll("button")].find((b) => b.innerText === "Finish setup"); return { disabled: button.disabled, reason: document.getElementById("finish-reason").innerText }; })()`,
  );
  t.assert(
    finish.disabled && finish.reason.startsWith("Reading courses"),
    "setup: Finish waits while a school's courses are still being read, and says so",
    JSON.stringify(finish),
  );
  await t.eval(`window.__faultLab.holdReads(false)`);
  await t.eval(DUE_FRAMES);
  await t.click("Finish setup", { timeout: WAIT });
  await t.waitFor(`location.pathname === "/due"`, "no key: the demo tokens land on What's due");
  await t.sleep(3000);
  const frames = (await t.eval(`window.__dueFrames`)).map((frame) => JSON.parse(frame));
  t.assert(
    frames.length === 1 && frames[0].summary !== null && frames[0].next !== null,
    "setup: What's due opens on its full totals and one Do this next, and neither changes",
    JSON.stringify(frames),
  );
};

const hiddenWithoutKey = async (t) => {
  await finishWaitsForReads(t);
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  t.assert(
    !(await t.has(`${SIDEBAR} a[href="${NORTH_STAR}"]`)),
    "no key: the sidebar has no North Star row",
  );
  await t.goto(NORTH_STAR);
  await t.waitFor(`location.pathname === "/due"`, "no key: North Star's URL goes to What's due");
};

const landing = async (t) => {
  await addAiKey(t);
  await t.goto("/");
  await onNorthStar(t, "with a key: / lands on North Star");
  await t.waitFor(composerFocused, "the composer has focus on arrival");
  const headline = await t.eval(
    `(() => { const h = document.querySelector(${JSON.stringify(HEADLINE)}); if (!h) return null; const { fontSize, fontWeight, textAlign, paddingBottom } = getComputedStyle(h); const { bottom, height } = h.getBoundingClientRect(); return { text: h.innerText, fontSize, fontWeight, textAlign, paddingBottom, bottom, height }; })()`,
  );
  t.assert(
    headline?.text === "What should we work on?" && headline.height > 0,
    "the headline is visible",
    JSON.stringify(headline),
  );
  t.assert(
    headline.fontSize === "30px" &&
      headline.fontWeight === "500" &&
      headline.textAlign === "center",
    "the headline is medium weight, centered, and 30px",
    JSON.stringify(headline),
  );
  const pane = await t.eval(
    `(() => { const main = document.querySelector('[data-testid="thread-main"]').getBoundingClientRect(); return { top: document.querySelector('[data-testid="screen-header"]').getBoundingClientRect().bottom, left: main.left, right: main.right }; })()`,
  );
  const card = await composerCard(t);
  const headlineTop = await t.eval(
    `document.querySelector(${JSON.stringify(HEADLINE)}).getBoundingClientRect().top`,
  );
  t.assert(
    Math.abs(headlineTop - pane.top - 96) <= 1,
    "the headline sits 96px below the header, anchored near the top rather than centered",
    JSON.stringify({ headlineTop, pane }),
  );
  t.assert(
    Math.abs((card.left + card.right) / 2 - (pane.left + pane.right) / 2) <= 1,
    "the composer is centered across the pane",
    JSON.stringify({ card, pane }),
  );
  t.assert(
    Math.abs(card.top - headline.bottom) <= 1 && headline.paddingBottom === "16px",
    "the headline sits 16px above the composer",
    JSON.stringify({ card, headline }),
  );
  t.assert(!(await t.has('[data-testid="chat"]')), "an empty North Star has no chat timeline");
  t.assert(
    !(await t.pageText()).includes("What needs grading?"),
    "North Star has no example chips",
  );
  await t.type("x");
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(COMPOSER)}).value`)) === "x",
    "typing lands in the composer without a click",
  );
  await t.key("Backspace");
  t.assert(
    (await t.text('[data-testid="screen-header"]')).trim() === "North Star",
    "the header is only North Star",
    await t.text('[data-testid="screen-header"]'),
  );
  t.assert(!(await t.pageText()).includes("Preview"), "North Star has no Preview button");
  t.assert(!(await t.has('[data-testid="pinned-queue"]')), "North Star has no pinned list");
  await t.key("Meta+1");
  await onNorthStar(t, "⌘1 goes to North Star");
  await shot(t, "landing");
  await homeLayout(t);
  await sidebarMap(t);
  await nextUp(t);
};

const LONG_ASK =
  "Draft this week's announcement and remember the screening moved to Thursday. ".repeat(8);

const homeAnchors = (t) =>
  t.eval(
    `(() => { const top = (selector) => document.querySelector(selector).getBoundingClientRect().top; const card = document.querySelector(${JSON.stringify(COMPOSER)}).parentElement.getBoundingClientRect(); return { headline: top(${JSON.stringify(HEADLINE)}), cardTop: card.top, cardBottom: card.bottom, nextUp: top(${JSON.stringify(NEXT_UP)}) }; })()`,
  );

const lastRowReachable = (t) =>
  t.eval(
    `(() => { const rows = document.querySelectorAll(${JSON.stringify(`${NEXT_UP} [data-row]`)}); const last = rows[rows.length - 1]; last.scrollIntoView({ block: "end" }); const { bottom } = last.getBoundingClientRect(); return bottom <= innerHeight; })()`,
  );

const nextUpCells = (t) =>
  t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${NEXT_UP} [data-row]`)})].map((row) => [...row.firstElementChild.children].map((cell) => ({ left: Math.round(cell.getBoundingClientRect().left), text: cell.innerText, opacity: getComputedStyle(cell).opacity })))`,
  );

const homeLayout = async (t) => {
  t.assert(
    await t.eval(
      `document.querySelectorAll("h1").length === 1 && document.querySelector("h1").matches(${JSON.stringify(HEADLINE)})`,
    ),
    "the headline is home's only h1",
  );

  const rows = await nextUpCells(t);
  t.assert(
    rows[0].length === 5 &&
      [0, 1, 2, 3, 4].every(
        (column) => new Set(rows.map((cells) => cells[column].left)).size === 1,
      ),
    "Next up's title, badge, code, detail and chevron each share a left edge across rows",
    JSON.stringify(rows),
  );
  const box = await t.eval(
    `(() => { const list = document.querySelector(${JSON.stringify(`${NEXT_UP} ol`)}); const style = getComputedStyle(list); const rows = list.querySelectorAll(":scope > li[data-row]"); return { border: style.borderTopWidth, radius: style.borderTopLeftRadius, rows: rows.length, divided: [...rows].slice(0, -1).every((row) => getComputedStyle(row).borderBottomWidth === "1px"), chevrons: list.querySelectorAll("li svg.lucide-chevron-right").length }; })()`,
  );
  t.assert(
    box.border === "1px" && box.radius === "8px" && box.divided && box.chevrons === box.rows,
    "Next up's rows sit in What's due's bordered list, each ending in a chevron",
    JSON.stringify(box),
  );
  const all = await t.eval(
    `(() => { const link = document.querySelector(${JSON.stringify(NEXT_UP_ALL)}); const probe = document.createElement("span"); probe.className = "text-info-foreground"; document.body.append(probe); const accent = getComputedStyle(probe).color; probe.remove(); const heading = link.parentElement.querySelector("h2").getBoundingClientRect(); const r = link.getBoundingClientRect(); return { accent: getComputedStyle(link).color === accent, chevron: Boolean(link.querySelector("svg.lucide-chevron-right")), sameRow: r.top < heading.bottom && r.bottom > heading.top, rightOfHeading: r.left > heading.right }; })()`,
  );
  t.assert(
    Object.values(all).every(Boolean),
    "All of what's due is an accent link with the trailing chevron, at the right of the Next up heading",
    JSON.stringify(all),
  );
  const textLeft = await t.eval(
    `document.querySelector(${JSON.stringify(COMPOSER)}).getBoundingClientRect().left`,
  );
  t.assert(
    rows[0][0].left === Math.round(textLeft),
    "Next up's rows start where the composer's text starts",
    JSON.stringify({ textLeft, row: rows[0][0].left }),
  );

  rows.forEach((cells, i) => {
    t.assert(
      cells[2].text.trim().length > 0 &&
        cells[1].text.trim().length > 0 &&
        cells[2].opacity === "1",
      `Next up row ${i + 1} names its school and course without a hover`,
      JSON.stringify(cells),
    );
  });
  t.assert(
    new Set(rows.map((cells) => cells[2].text)).size === rows.length,
    "each Next up row is a different course, so the queue never reads as one course",
    JSON.stringify(rows),
  );

  t.assert(
    (await t.text(`${COMPOSER} + div`)).trim() === "You approve every write.",
    "the composer's footer says one thing, the approval promise",
    await t.text(`${COMPOSER} + div`),
  );

  for (const [width, height] of [
    [1440, 900],
    [1024, 640],
    [1024, 400],
  ]) {
    await t.viewport(width, height);
    await t.reload();
    await t.waitFor(composerFocused, `the composer has focus at ${width}x${height}`);
    const before = await homeAnchors(t);
    await t.type(LONG_ASK);
    const after = await homeAnchors(t);
    const where = `at ${width}x${height}`;
    t.assert(
      after.cardBottom > before.cardBottom + 40,
      `a long message grows the composer ${where}`,
      JSON.stringify({ before, after }),
    );
    t.assert(
      after.headline === before.headline && after.cardTop === before.cardTop,
      `the headline and the composer's top hold still as the message grows ${where}`,
      JSON.stringify({ before, after }),
    );
    t.assert(
      after.nextUp >= after.cardBottom,
      `Next up stays clear of the grown composer ${where}`,
      JSON.stringify(after),
    );
    t.assert(
      after.headline >=
        (await t.eval(
          `document.querySelector('[data-testid="screen-header"]').getBoundingClientRect().bottom`,
        )) && after.cardBottom <= height,
      `the headline and the composer are fully on screen ${where}`,
      JSON.stringify(after),
    );
    t.assert(await lastRowReachable(t), `the last Next up row can be reached ${where}`);
    await clearComposer(t);
  }
  await t.viewport(1440, 900);
  await t.reload();
  await t.waitFor(composerFocused, "the composer has focus again at 1440x900");
};

const navTops = (t) =>
  t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR} a[href="/due"], ${SIDEBAR} a[href="/inbox"], ${SIDEBAR} a[href="/calendar"], ${SIDEBAR} [data-testid="school-row"], ${SIDEBAR} a[title^="ENG 101 "]`)})].map((el) => el.getBoundingClientRect().top)`,
  );

const sidebarMap = async (t) => {
  await t.viewport(1280, 800);
  const assertListFits = async (what) => {
    const list = await t.eval(
      `(() => { const { scrollHeight, clientHeight } = document.querySelector('[data-testid="sidebar-list"]'); return { scrollHeight, clientHeight }; })()`,
    );
    t.assert(
      list.clientHeight > 0 && list.scrollHeight <= list.clientHeight,
      what,
      JSON.stringify(list),
    );
  };
  await assertListFits("the sidebar's list doesn't scroll on the seeded workspace at 1280x800");
  const OFFER_TOGGLE = `${SIDEBAR} [data-testid="setup-offers-toggle"]`;
  const OFFER = `${SIDEBAR} [data-testid="setup-offer"] button`;
  const toggles = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(OFFER_TOGGLE)})].map((row) => row.innerText.trim())`,
  );
  t.assert(
    JSON.stringify(toggles) ===
      JSON.stringify(["2 Spring 2027 courses to set up", "2 Spring 2027 courses to set up"]),
    "each school folds next term's courses into one row that names the term",
    JSON.stringify(toggles),
  );
  t.assert(!(await t.has(OFFER)), "a folded school lists no shells beside its real courses");
  await t.click(`${OFFER_TOGGLE}[data-offers-school="rsu"]`);
  const rsuOffers = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR} [data-testid="setup-offer"]`)})].map((row) => row.innerText.replace(/\\s+/g, " ").trim())`,
  );
  t.assert(
    rsuOffers.some((row) => row.includes("ENG 210") && row.includes("Empty")),
    "an empty shell says Empty",
    JSON.stringify(rsuOffers),
  );
  t.assert(
    rsuOffers.some((row) => row.includes("HUM 150") && row.includes("14 students, 3 items")),
    "a shell with things in it says what they are",
    JSON.stringify(rsuOffers),
  );
  const offerActionOpacity = () =>
    t.eval(
      `getComputedStyle(document.querySelector(${JSON.stringify(`${OFFER} span:last-child`)})).opacity`,
    );
  await t.hover(HEADLINE);
  t.assert((await offerActionOpacity()) === "0", "an offer's action is quiet at rest");
  await t.hover(OFFER);
  t.assert((await offerActionOpacity()) === "1", "an offer's action shows on hover");
  await t.hover(HEADLINE);
  await t.key("Tab");
  await t.eval(`document.querySelector(${JSON.stringify(OFFER)}).focus()`);
  t.assert((await offerActionOpacity()) === "1", "an offer's action shows on keyboard focus");
  await t.click(`${OFFER_TOGGLE}[data-offers-school="rsu"]`);
  t.assert(!(await t.has(OFFER)), "the shells fold away again");
  await t.click(COMPOSER);
  const unreadSignal = (code) =>
    `${SIDEBAR} a[title^=${JSON.stringify(`${code} `)}] [aria-label*="unread"]`;
  const engRow = await t.eval(
    `(() => { const row = document.querySelector(${JSON.stringify(`${SIDEBAR} a[title^="ENG 101 "]`)}); return { title: row.title, marks: row.querySelectorAll('[data-slot="badge"]').length, text: row.querySelector('[data-slot="badge"]').innerText.trim() }; })()`,
  );
  t.assert(
    engRow.marks === 1 && engRow.text === "10",
    "a course row shows one number at rest",
    JSON.stringify(engRow),
  );
  t.assert(
    engRow.title.endsWith("10 need you: 3 unread, 7 to grade"),
    "the row's tooltip says what the number is made of",
    engRow.title,
  );
  const schoolRow = (index) =>
    `document.querySelectorAll(${JSON.stringify(`${SIDEBAR} [data-testid="school-row"]`)})[${index}]`;
  t.assert(
    !/\d/.test(await t.eval(`${schoolRow(0)}.innerText`)),
    "an open school leaves the numbers to its courses",
  );
  t.assert(
    (await t.eval(`${schoolRow(0)}.title`)).includes("23 need you: 7 unread, 16 to grade"),
    "an open school's tooltip still has the total",
  );
  await t.click(`${SIDEBAR} [data-testid="school-row"]`);
  t.assert(
    (await t.eval(`${schoolRow(0)}.innerText`)).includes("23"),
    "a collapsed school shows the total, because its courses are hidden",
  );
  await t.click(`${SIDEBAR} [data-testid="school-row"]`);
  const plainCount = (selector) =>
    t.eval(
      `(() => { const signal = document.querySelector(${JSON.stringify(selector)}); return Boolean(signal) && !signal.querySelector("[data-status-dot]"); })()`,
    );
  const [unreadCourse] = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR} a[title] [aria-label*="unread"]`)})].map((signal) => signal.closest("a").querySelector("span").innerText)`,
  );
  t.assert(unreadCourse, "a collapsed course with unread messages shows its indicator");
  t.assert(
    await t.has(`[aria-label="Expand ${unreadCourse}"]`),
    `${unreadCourse} is collapsed and still shows it`,
  );
  const collapsedPlain = await plainCount(unreadSignal(unreadCourse));
  await expandCourse(t, unreadCourse);
  const threadPlain = await plainCount(`${SIDEBAR} li a[href^="/threads/"] [aria-label$="unread"]`);
  t.assert(
    collapsedPlain && threadPlain,
    "unread is a plain count on the course and its thread, with no dot to decode",
    JSON.stringify({ collapsedPlain, threadPlain }),
  );
  await t.click(`[aria-label="Collapse ${unreadCourse}"]`);
  t.assert(
    !(await t.has(`${SIDEBAR} li a[href^="/threads/"] [aria-label$="unread"]`)),
    "collapsing from elsewhere hides its threads again",
  );

  const [first] = await nextUpRows(t);
  await t.click(`${NEXT_UP} [data-row="${first.key}"] button`);
  await t.waitFor(
    `location.pathname !== ${JSON.stringify(NORTH_STAR)}`,
    "a Next up row leaves North Star",
  );
  const href = await pathname(t);
  const code = (await t.text(HEADER)).match(/[A-Z]+ \d+/)[0];
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${sidebarLink(href)}[aria-current]`)})`,
    "Next up reveals the course's threads with the active one highlighted",
  );
  t.assert(
    await t.has(`[aria-label="Collapse ${code}"][aria-expanded="true"]`),
    `${code} opened on arrival, without a click`,
  );
  await assertListFits("the sidebar's list still fits with the course you're in open");
  await shot(t, "sidebar-course-open");
  await t.click(`[aria-label="Collapse ${code}"]`);
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(sidebarLink(href))})`,
    "collapsing the course you're in hides its threads",
  );
  await t.reload();
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`[aria-label="Expand ${code}"]`)})`,
    "an explicit collapse of the active course sticks through a reload",
  );
  t.assert(
    (await pathname(t)) === href && !(await t.has(sidebarLink(href))),
    "after the reload the thread stays open and its row stays hidden",
    href,
  );
  await t.click(`[aria-label="Expand ${code}"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(sidebarLink(href))})`,
    "expanding it brings the threads back",
  );
  await backHome(t);
  t.assert(!(await t.has(sidebarLink(href))), "leaving the course closes it again");
  await t.viewport(1440, 900);
};

const dueRow = (key) =>
  `[data-testid="due-list"] li[data-row=${JSON.stringify(key)}] button, [data-testid="due-list"] section[data-row=${JSON.stringify(key)}] button`;

const dueRows = async (t) => {
  await t.click("What's due", { within: SIDEBAR });
  await t.waitFor(
    `location.pathname === "/due" && document.querySelector('[data-testid="due-list"]')`,
    "What's due opens",
  );
  return t.eval(
    `(() => { document.querySelectorAll('[data-testid="due-list"] details').forEach((sitting) => { sitting.open = true; }); return [...document.querySelectorAll('[data-testid="due-list"] [data-row]')].filter((row) => /^(grade|announcement|replies):/.test(row.dataset.row)).map((row) => ({ key: row.dataset.row, text: row.innerText })); })()`,
  );
};

const ACTION = "[data-card-primary]";
const actionFocused = `document.activeElement?.matches(${JSON.stringify(ACTION)})`;

const nextUp = async (t) => {
  const rows = await nextUpRows(t);
  t.assert(
    rows.length === 3 && rows.every((row) => row.height === 32),
    "Next up shows 3 one-line rows",
    JSON.stringify(rows),
  );
  for (const [width, height] of [
    [1180, 800],
    [1440, 900],
  ]) {
    await t.viewport(width, height);
    const [last] = (await nextUpRows(t)).slice(-1);
    t.assert(
      last.bottom <= height,
      `Next up fits on screen at ${width}x${height}`,
      JSON.stringify(last),
    );
  }

  const stepCount = Number((await t.text(NEXT_UP_ALL)).match(/All (\d+) of what's due/)?.[1]);
  t.assert(
    stepCount > rows.length,
    "the link says how much work sits behind the rows",
    String(stepCount),
  );
  await t.click(NEXT_UP_ALL);
  await t.waitFor(
    `location.pathname === "/due" && document.querySelector('[data-testid="due-list"]')`,
    "All of what's due opens What's due",
  );
  const sittings = await t.eval(
    `[...document.querySelectorAll('[data-testid="due-list"] [data-due-group="next"], [data-testid="due-list"] details')].map((sitting) => (sitting.querySelector('[data-row^="grade:"], [data-row^="announcement:"], [data-row^="replies:"], [data-row^="reconnect:"]') ?? sitting).dataset.row)`,
  );
  t.assert(
    JSON.stringify(rows.map((row) => row.key)) === JSON.stringify(sittings.slice(0, 3)),
    "Next up lists the first step of What's due's first sittings, in its order",
    JSON.stringify({ rows: rows.map((row) => row.key), sittings }),
  );

  await t.goto("/threads/t-e101-essay2");
  await t.waitFor(
    `document.querySelector('[data-testid="queue-start"]')`,
    "a grading thread with no draft yet opens on its list, ready to start",
  );
  t.assert(!(await t.has('[data-testid="chat"]')), "the list stands alone, with no chat beside it");
  t.assert(
    (await t.text('[data-testid="queue-list"] li[data-row]:last-of-type')).includes("Missing"),
    "a student with nothing turned in is a row at the end of the list, marked Missing",
  );

  await backHome(t);
  const first = rows[0];
  t.assert(first.key.startsWith("grade:"), "the first step is grading", first.key);
  await t.click(`${NEXT_UP} [data-row="${first.key}"] button`);
  await t.waitFor(
    `location.pathname !== ${JSON.stringify(NORTH_STAR)} && document.querySelector('[data-testid="pinned-queue"][data-open="false"]')`,
    "a grade row lands on the draft with its list folded, so the whole draft has the room",
  );
  const grading = await openThread(t);
  t.assert(
    grading?.kind === "grading" && first.key === `grade:${grading.assignment}`,
    "a grade row lands in that step's grading thread",
    JSON.stringify({ first, grading }),
  );

  await t.waitFor(
    `[...document.querySelectorAll("button")].some((button) => button.hasAttribute("data-approve"))`,
    "a grade row's click starts drafting the first submission in the list",
  );
  const draftFits = `(() => { const chat = document.querySelector('[data-testid="chat"]').getBoundingClientRect(); const card = document.querySelector("[data-focused]").getBoundingClientRect(); const bar = document.querySelector('[data-testid="card-actions"]').getBoundingClientRect(); const total = document.querySelector('[data-testid="draft-grade"]').getBoundingClientRect(); return card.top >= chat.top && total.bottom <= bar.top && bar.bottom <= chat.bottom + 1; })()`;
  await t.waitFor(draftFits, "the draft lands with its heading, total and main action all in view");
  await t.waitFor(
    `${actionFocused} && document.activeElement.hasAttribute("data-approve")`,
    "a Next up row lands with the keyboard on Approve",
  );
  t.assert(await t.eval(draftFits), "focus on arrival leaves the draft's top in view");
  await t.click("Preview", { within: '[role="tablist"]' });
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "the card's Preview opens the review",
  );
  t.assert(
    await t.eval(
      `document.querySelector('[data-testid="thread-panel"]').contains(document.activeElement)`,
    ),
    "the review takes the focus its button gave up, rather than dropping it on the page",
  );
  await t.key("Escape");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ACTION)})`,
    "Escape closes the review and the action comes back",
  );
  t.assert(
    !(await t.eval(actionFocused)),
    "closing the panel is not an arrival, so focus doesn't jump back",
  );
  const landedOn = await pathname(t);
  await backHome(t);
  await t.click(`${NEXT_UP} [data-row="${first.key}"] button`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(landedOn)} && ${actionFocused}`,
    "a second visit lands with the keyboard on the action too",
  );
  await t.viewport(1180, 800);
  await t.waitFor(
    draftFits,
    "at 1180x800 the draft still holds its heading, total and main action in view",
  );
  const readable = `(() => { const chat = document.querySelector('[data-testid="chat"]').getBoundingClientRect(); const card = document.querySelector("[data-focused]").getBoundingClientRect(); const bar = document.querySelector('[data-testid="card-actions"]').getBoundingClientRect(); const comment = document.querySelector("[data-edit-field]"); const box = comment.getBoundingClientRect(); const chips = [...document.querySelectorAll("[data-composer-examples] button")].map((chip) => chip.getBoundingClientRect().top); const reasons = [...document.querySelectorAll("[data-focused] [data-rationale]")]; return { commentWhole: comment.scrollHeight <= comment.clientHeight + 1, commentClear: box.bottom <= bar.top, cardClosed: card.bottom <= chat.bottom, reasons: reasons.length > 0 && reasons.every((reason) => reason.scrollWidth <= reason.clientWidth + 1 && reason.getBoundingClientRect().height >= 20), chipsOneRow: new Set(chips).size === 1 }; })()`;
  for (const [size, width, height] of [
    ["1180x800", 1180, 800],
    ["1440x900", 1440, 900],
  ]) {
    await t.viewport(width, height);
    await t.waitFor(draftFits, `at ${size} the draft settles again`);
    const seen = await t.eval(readable);
    t.assert(
      Object.values(seen).every(Boolean),
      `at ${size} the whole comment, every rubric reason, the card's end and one row of chips are in view`,
      JSON.stringify(seen),
    );
  }
  // The open list shows whole rows, up to its share of the screen, and gives up rows on a short screen so the card's grade and comment stay in view (#159, #207).
  await t.eval(
    `window.__layoutErrors = []; window.addEventListener("error", (event) => window.__layoutErrors.push(event.message))`,
  );
  const listed = `(() => { const list = document.querySelector('[data-testid="queue-list"]').getBoundingClientRect(); const rows = [...document.querySelectorAll('[data-testid="queue-list"] [data-row]')].map((row) => row.getBoundingClientRect()); const bar = document.querySelector('[data-testid="card-actions"]').getBoundingClientRect(); const chat = document.querySelector('[data-testid="chat"]').getBoundingClientRect(); const grade = document.querySelector('[data-testid="draft-grade"]').getBoundingClientRect(); const comment = document.querySelector("[data-focused] [data-edit-field]").getBoundingClientRect(); return { whole: rows.filter((row) => row.top >= list.top - 1 && row.bottom <= list.bottom + 1).length, cut: rows.filter((row) => row.top < list.bottom - 1 && row.bottom > list.bottom + 1).length, actions: bar.top >= chat.top && bar.bottom <= chat.bottom + 1, grade: grade.top >= chat.top && grade.bottom <= bar.top, comment: comment.top >= chat.top && comment.bottom <= bar.top + 1, commentStarts: comment.top >= chat.top && comment.top + 22 <= bar.top, errors: window.__layoutErrors }; })()`;
  await t.click('[aria-label="Expand queue"]');
  for (const [size, width, height, rows] of [
    ["1180x800", 1180, 800, 1],
    ["1280x720", 1280, 720, 1],
    ["1440x900", 1440, 900, 4],
  ]) {
    await t.viewport(width, height);
    const seen = await t.steady(listed);
    t.assert(
      seen.whole >= rows &&
        seen.cut === 0 &&
        seen.actions &&
        seen.grade &&
        seen.comment &&
        seen.errors.length === 0,
      `with the list open at ${size} it shows at least ${rows} whole rows and none cut, the grade, comment and actions stay in view, and nothing throws`,
      JSON.stringify(seen),
    );
  }
  await t.viewport(1280, 720);
  const tick = `[...document.querySelectorAll('[data-testid="queue-list"] [data-row] input[type="checkbox"]')].slice(1, 3).forEach((box) => box.click())`;
  await t.eval(tick);
  await t.sleep(150);
  const ticked = await t.eval(listed);
  t.assert(
    ticked.whole >= 1 &&
      ticked.cut === 0 &&
      ticked.grade &&
      ticked.commentStarts &&
      ticked.errors.length === 0,
    "with two rows ticked at 1280x720 the list gives way to one row, so the grade and the comment's first line stay in view",
    JSON.stringify(ticked),
  );
  await t.eval(tick);
  await t.viewport(1440, 900);

  const announcement = (await dueRows(t)).find(
    (row) => row.key.startsWith("announcement:") && row.text.includes("Not started"),
  );
  t.assert(
    announcement && /Write the announcement: .+/.test(announcement.text),
    "an announcement nobody has started asks you to write it",
    JSON.stringify(announcement),
  );
  await t.click(dueRow(announcement.key));
  await t.waitFor(
    `document.querySelector('[aria-label="Announcement"]')`,
    "clicking the announcement row starts the draft it promised",
  );
  await t.waitFor(actionFocused, "a What's due row lands with the keyboard on the action");
  const promised = announcement.text.match(/Write the announcement: (.+)/)[1].trim();
  const landed = await t.eval(
    `({ crumb: document.querySelector('main header h1').innerText, card: document.querySelector('[data-focused]').innerText })`,
  );
  t.assert(
    landed.crumb === promised && landed.card.includes(promised),
    "the row, the crumb and the card call the draft one name",
    JSON.stringify({ promised, landed }),
  );

  const afterDraft = (await dueRows(t)).find((row) => row.key === announcement.key);
  t.assert(
    afterDraft?.text.includes("Review draft: ") && afterDraft.text.includes("AI draft. Not sent"),
    "once drafted, the same row offers to review it",
    JSON.stringify(afterDraft),
  );
  await t.click(dueRow(announcement.key));
  await t.waitFor(
    `document.querySelector('[aria-label="Announcement"]') && document.querySelector("[data-approve]")`,
    "clicking the drafted row reopens that draft",
  );

  const reply = (await dueRows(t)).find(
    (row) => /^replies:.*:open$/.test(row.key) && row.text.includes("Not started"),
  );
  t.assert(reply, "the plan has an undrafted reply row", JSON.stringify(reply));
  await t.click(dueRow(reply.key));
  await t.waitFor(`location.pathname !== "/due"`, "a reply row leaves What's due");
  const replies = await openThread(t);
  t.assert(replies?.kind === "messages", "a reply row lands in a messages thread");
  t.assert(
    reply.key.includes(replies.course),
    "the messages thread is that course's",
    JSON.stringify({ reply, replies }),
  );
  await t.waitFor(
    `[...document.querySelectorAll("button")].some((button) => button.hasAttribute("data-approve"))`,
    "the reply row's click starts a draft",
  );
  const quoteState = () =>
    t.eval(
      `(() => { const card = document.querySelector("[data-focused]"); const top = card.getBoundingClientRect().top; const chat = document.querySelector('[data-testid="chat"]').getBoundingClientRect().top; return { quotes: card.querySelectorAll("blockquote").length, inView: top >= chat, pane: document.querySelector('[role="tab"][aria-selected="true"]')?.innerText ?? null }; })()`,
    );
  const beside = await quoteState();
  t.assert(
    beside.pane === "Student message" && beside.quotes === 0 && beside.inView,
    "with the student's message in the pane, the card leaves it out and its top stays in view",
    JSON.stringify(beside),
  );
  await t.click('[aria-label="Close panel"]');
  await t.sleep(150);
  const closed = await quoteState();
  t.assert(
    closed.quotes === 1 && closed.inView,
    "with the pane closed, the card carries the student's message and its top stays in view",
    JSON.stringify(closed),
  );
  await t.click('[aria-label="Open panel"]');
  await t.sleep(150);
  const reopened = await quoteState();
  t.assert(
    reopened.quotes === 0 && reopened.inView,
    "reopening the pane takes the quote back out without clipping the card",
    JSON.stringify(reopened),
  );
  await t.click("Preview", { within: '[role="tablist"]' });
  await t.sleep(150);
  const previewing = await quoteState();
  t.assert(
    previewing.quotes === 0 &&
      previewing.inView &&
      (await t.has("[data-focused][data-previewing] [data-card-edit]")),
    "on the Preview tab the card folds to one row with Edit, and the student's message is a tab away",
    JSON.stringify(previewing),
  );
  await t.click("Student message", { within: '[role="tablist"]' });

  const reviewing = (await dueRows(t)).find(
    (row) => row.key === reply.key.replace(/:open$/, ":review"),
  );
  t.assert(
    reviewing &&
      /Review the reply to \S+ \S+/.test(reviewing.text) &&
      reviewing.text.includes("AI draft. Not sent") &&
      !reviewing.text.includes(","),
    "once one reply is drafted, its row promises only that reply",
    JSON.stringify(reviewing),
  );

  await dueRows(t);
  const detailColors = await t.eval(
    `(() => { const probe = document.body.appendChild(Object.assign(document.createElement("span"), { className: "text-warning-foreground" })); const approval = getComputedStyle(probe).color; probe.remove(); const detail = [...document.querySelectorAll('[data-testid="due-list"] [data-slot="badge"]')].find((badge) => badge.innerText === "AI draft. Not sent"); return { approval, detail: detail && getComputedStyle(detail).color }; })()`,
  );
  t.assert(
    detailColors.detail === detailColors.approval,
    "AI draft. Not sent on a plan row is the same amber as everywhere else",
    JSON.stringify(detailColors),
  );
  await backHome(t);
  await t.eval(`void window.__faultLab.expireToken("lcc")`);
  await t.click("Settings", { within: SIDEBAR });
  await t.click("Sync now", { within: '[data-school="lcc"]' });
  await t.waitFor(
    `document.querySelector('[data-school="lcc"]')?.dataset.connection === "expired"`,
    "syncing finds the token expired",
  );
  await backHome(t);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${NEXT_UP} [data-row="reconnect:lcc"]`)})`,
    "an expired school adds a Reconnect row",
  );
  t.assert((await nextUpRows(t))[0].key === "reconnect:lcc", "the Reconnect row comes first");
  await t.click(`${NEXT_UP} [data-row="reconnect:lcc"] a`);
  await t.waitFor(
    `location.pathname === "/settings" && document.querySelector('[data-school="lcc"]')?.dataset.connection === "expired"`,
    "the Reconnect row opens Settings on the expired school",
  );
  await t.click("Reconnect", { within: '[data-school="lcc"]' });
  await t.waitFor(
    `document.querySelector('[role="dialog"] input[type="password"]')`,
    "reconnect opens the token dialog",
  );
  await t.click('[role="dialog"] input[type="password"]');
  await t.type("verify-next-up-token");
  await t.click("Connect", { within: '[role="dialog"]' });
  await t.waitFor(
    `!document.querySelector('[role="dialog"]') && document.querySelector('[data-school="lcc"]')?.dataset.connection !== "expired"`,
    "reconnecting clears the expired school",
  );

  await backHome(t);
  t.assert(
    !(await nextUpRows(t)).some((row) => row.key === "reconnect:lcc"),
    "the Reconnect row is gone after reconnecting",
  );

  const connectedCount = await t.text(NEXT_UP_ALL);
  await t.click("Settings", { within: SIDEBAR });
  await t.click("Disconnect", { within: '[data-school="lcc"]' });
  await t.click("Disconnect", { within: '[role="dialog"]' });
  await t.waitFor(
    `document.querySelector('[data-school="lcc"]')?.dataset.connection === "disconnected"`,
    "Disconnect leaves Lakeshore not connected",
  );
  await backHome(t);
  t.assert(
    (await t.text(NEXT_UP_ALL)) !== connectedCount,
    "the count drops the disconnected school's work",
    `${connectedCount} -> ${await t.text(NEXT_UP_ALL)}`,
  );
  t.assert(
    (await t.text(NEXT_UP)).includes(
      "Lakeshore Community College is disconnected. Its work is not shown.",
    ),
    "Next up names the disconnected school its count leaves out",
    await t.text(NEXT_UP),
  );
  await shot(t, "next-up-disconnected");

  await t.click("Settings", { within: SIDEBAR });
  await t.click("Connect", { within: '[data-school="lcc"]' });
  await t.click('[role="dialog"] input[type="password"]');
  await t.type("verify-next-up-token");
  await t.click("Connect", { within: '[role="dialog"]' });
  await t.waitFor(
    `!document.querySelector('[role="dialog"]') && document.querySelector('[data-school="lcc"]')?.dataset.connection === "connected"`,
    "connecting Lakeshore again brings it back",
    WAIT,
  );
  await backHome(t);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(NEXT_UP_ALL)}).innerText === ${JSON.stringify(connectedCount)}`,
    "the count comes back once Lakeshore is connected",
    WAIT,
  );
  t.assert(
    !(await t.text(NEXT_UP)).includes("is disconnected"),
    "the disconnected note goes once the school is back",
  );
};

const question = async (t) => {
  const navBeforeChats = await navTops(t);
  const hero = await composerCard(t);
  // When the glide starts animating, the chat's URL must already be showing. A skipped glide (Chrome skips one on a busy machine) holds nothing up.
  await t.eval(
    `(() => { const start = document.startViewTransition?.bind(document); if (start) document.startViewTransition = (...args) => { const glide = start(...args); window.__glide = glide.ready.then(() => location.pathname, () => "skipped"); return glide; }; })()`,
  );
  await t.type("What's due this week?");
  await t.key("Enter");
  const atGlideStart = await t.eval(`window.__glide ?? "no view transitions"`);
  t.assert(atGlideStart !== NORTH_STAR, "the glide does not hold up the navigation", atGlideStart);
  t.assert(
    await t.eval(`!document.startViewTransition || window.__glide instanceof Promise`),
    "the first send uses a view transition where the browser has one",
  );
  await t.waitFor(
    `document.querySelector('[data-testid="chat"]') && !document.querySelector(${JSON.stringify(HEADLINE)})`,
    "the first send opens the chat and drops the headline",
  );
  const chat = await pathname(t);
  t.assert(
    chat !== NORTH_STAR && chat.startsWith("/threads/"),
    "the first send lands on a chat of its own",
    chat,
  );
  await glided(t);
  const docked = await composerCard(t);
  t.assert(
    docked.bottom > hero.bottom + 100 && docked.width === hero.width,
    "the first send docks the composer at the bottom, at the same width",
    JSON.stringify({ hero, docked }),
  );
  t.assert(await t.eval(composerFocused), "the composer keeps focus through the first send");
  await t.waitFor(
    `document.querySelector('[data-testid="sources"] [data-source="assignment"]')`,
    "a question answers with assignment sources",
    WAIT,
  );
  await settled(t, "the question settled");
  const header = await t.text(HEADER);
  t.assert(
    /North Star\s*\/\s*What's due this week\?/.test(header) && header.includes("New chat"),
    "the header reads North Star / the request, with New chat",
    header,
  );
  t.assert(
    !header.includes("Preview") && !(await t.has(`${HEADER} [aria-label="Open panel"]`)),
    "a chat has no Preview or panel button",
    header,
  );
  t.assert(!(await t.has('[data-testid="pinned-queue"]')), "a chat has no pinned list");
  await shot(t, "question");

  await t.click('[data-testid="sources"] [data-source="assignment"]');
  await t.waitFor(
    `location.pathname !== ${JSON.stringify(chat)}`,
    "an assignment source opens its page",
  );
  await t.click(sidebarLink(NORTH_STAR));
  await cleanHome(t, "What's due this week?", "the sidebar's North Star");
  t.assert(
    await t.eval(
      `document.querySelector(${JSON.stringify(sidebarLink(NORTH_STAR))}).hasAttribute("aria-current")`,
    ),
    "the North Star row is active on home",
  );

  await t.click(sidebarLink(chat));
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector('[data-testid="sources"]')`,
    "the chat's sidebar row reopens the conversation",
  );
  t.assert(
    (await t.text('[data-testid="chat"]')).includes("What's due this week?"),
    "the reopened chat holds the question",
  );
  t.assert(
    !(await t.eval(
      `document.querySelector(${JSON.stringify(sidebarLink(NORTH_STAR))}).hasAttribute("aria-current")`,
    )) &&
      (await t.eval(
        `document.querySelector(${JSON.stringify(sidebarLink(chat))}).hasAttribute("aria-current")`,
      )),
    "on a chat, the chat's row is active and North Star's is not",
  );
  await t.waitFor(composerFocused, "reopening a chat focuses its composer");

  await t.reload();
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector('[data-testid="sources"]')`,
    "reloading on a chat stays on it",
  );

  await t.click("New chat", { within: HEADER });
  await cleanHome(t, "What's due this week?", "New chat");
  await t.click(sidebarLink(chat));
  await t.waitFor(`location.pathname === ${JSON.stringify(chat)}`, "back on the chat");
  await t.key("Meta+n");
  await cleanHome(t, "What's due this week?", "⌘N from a chat");
  await t.click(`${SIDEBAR} a[href="/due"]`);
  await t.waitFor(`location.pathname === "/due"`, "on What's due");
  await t.key("Meta+n");
  await cleanHome(t, "What's due this week?", "⌘N from a screen");

  const second = await askFromHome(t, "What needs grading?");
  t.assert(second !== chat, "two asks from home make two chats", `${chat} then ${second}`);
  t.assert(
    JSON.stringify((await chatRows(t)).slice(0, 2)) === JSON.stringify([second, chat]),
    "the Chats section lists chats newest first",
    JSON.stringify(await chatRows(t)),
  );
  await t.click("North Star", { within: HEADER });
  await cleanHome(t, "What needs grading?", "the header's North Star");
  const third = await askFromHome(t, "Where's the rubric for Essay 2?");
  await t.click(sidebarLink(NORTH_STAR));
  const fourth = await askFromHome(t, "Find anything about printed copies");
  const rows = await chatRows(t);
  t.assert(
    JSON.stringify(rows.slice(0, 3)) === JSON.stringify([fourth, third, second]) &&
      !rows.includes(chat),
    "the sidebar shows the newest 3 chats",
    JSON.stringify(rows),
  );
  t.assert(
    (await t.text('[data-testid="sidebar-chats"]')).includes("Show 1 more"),
    "older chats wait behind Show 1 more",
  );
  t.assert(
    JSON.stringify(await navTops(t)) === JSON.stringify(navBeforeChats),
    "chats leave What's due, Messages, Calendar, the schools and their courses where they were",
    JSON.stringify({ navBeforeChats, now: await navTops(t) }),
  );
  await t.goto(chat);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(sidebarLink(chat))})`,
    "the active chat stays in the sidebar past the cutoff",
  );
  await t.key("Meta+2");
  await t.waitFor(
    `location.pathname === ${JSON.stringify(fourth)}`,
    "with no course open, ⌘2 opens the newest chat, after North Star",
  );
  await t.goto(chat);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(COMPOSER)})`,
    "back on the first chat for the rest of the walk",
  );
  await t.waitFor(
    `document.querySelector('[data-testid="sources"]')`,
    "the first chat still has its answer",
  );
};

const find = async (t) => {
  const before = await count(t, '[data-testid="sources"]');
  await ask(t, "Find anything about the late policy");
  await t.waitFor(
    `document.querySelectorAll('[data-testid="sources"]').length > ${before}`,
    "a find answers with sources",
    WAIT,
  );
  await settled(t, "the find settled");
  const answer = await t.text('[data-testid="chat"]');
  t.assert(
    answer.includes("8 results.") && !answer.includes('"late policy"'),
    "a find leads with one line and quotes nothing the person didn't type",
    answer,
  );
  const links = await t.eval(
    `[...document.querySelectorAll('[data-testid="sources"]')].at(-1).querySelectorAll("button").length`,
  );
  t.assert(
    links === 8 && (answer.match(/Close Reading 2/g) ?? []).length === 1,
    "each result is one line, and the line is the link",
    String(links),
  );
  await shot(t, "find");
};

const fallsBackToNextWork = async (t) => {
  const chat = await pathname(t);
  await backHome(t);
  const planned = await nextUpRows(t);
  await t.goto(chat);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(COMPOSER)})`,
    "back on the chat with Next Up read",
  );
  const groups = await count(t, GROUP);
  await ask(t, "banana");
  await t.waitFor(
    `document.querySelector('[data-testid="replies"]')`,
    "a request it can't place offers work",
    WAIT,
  );
  await settled(t, "the fallback settled");
  const offered = await t.eval(
    `[...document.querySelectorAll("[data-reply]")].map((reply) => reply.dataset.reply)`,
  );
  const KIND = {
    grade: "Start grading",
    announcement: "Open the draft announcement",
    replies: "Draft replies",
  };
  t.assert(
    offered.length === 3 &&
      planned.every((row, index) => offered[index].startsWith(KIND[row.key.split(":")[0]])),
    "the fallback offers the same next work as Next Up, in its order",
    JSON.stringify({ offered, planned }),
  );
  await t.click(`[data-reply=${JSON.stringify(offered[0])}]`);
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(GROUP)}).length > ${groups}`,
    "a pill starts that work",
    WAIT,
  );
  await settled(t, "the pill settled");
  t.assert((await pathname(t)) === chat, "starting it stays in the chat", await pathname(t));
};

const typingKeepsFocus = async (t) => {
  await backHome(t);
  const rows = await nextUpRows(t);
  const row = rows.find((candidate) => candidate.key.startsWith("announcement:")) ?? rows[0];
  await t.click(`${NEXT_UP} [data-row="${row.key}"] button`);
  await t.key("/");
  await t.type("half");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ACTION)})`,
    "the draft arrives while the person is typing",
    WAIT,
  );
  await t.sleep(150);
  t.assert(
    await t.eval(
      `document.activeElement?.matches(${JSON.stringify(COMPOSER)}) && document.activeElement.value === "half"`,
    ),
    "a draft arriving doesn't take focus from someone typing",
  );
};

const singleHandoff = async (t) => {
  const chat = await pathname(t);
  await ask(t, "Start grading Close Reading 2");
  await t.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(GROUP)})].at(-1)?.querySelectorAll("a").length === 1`,
    "one course means one handoff card",
    WAIT,
  );
  await settled(t, "the single handoff settled");
  t.assert(
    (await pathname(t)) === chat,
    "a single handoff stays in the chat, with no jump to the course",
    await pathname(t),
  );
  t.assert(
    (await lastGroup(t)).includes("to grade"),
    "the card shows the thread's live status",
    await lastGroup(t),
  );
  t.assert((await lastGroup(t)).includes("Open"), "the card says it opens", await lastGroup(t));
  const reply = await t.eval(
    `(() => { const thread = JSON.parse(localStorage.getItem("lms-app.v1")).state.threads[decodeURIComponent(location.pathname.split("/threads/")[1])]; return thread.messages.filter((m) => m.type === "agent").at(-1)?.text ?? ""; })()`,
  );
  t.assert(
    !reply.includes("Opened the grading list") && reply.includes("choose Open"),
    "the reply offers Open instead of claiming the list already opened",
    reply,
  );
  await shot(t, "single-handoff");
};

const SLOW = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [1500, 2000] });
const CARD_STATUSES = `[...[...document.querySelectorAll(${JSON.stringify(GROUP)})].at(-1).querySelectorAll("a")].map((a) => [...a.querySelectorAll('[data-slot="badge"]')].slice(1).map((badge) => badge.innerText).join(""))`;

const multiHandoff = async (t) => {
  const chat = await pathname(t);
  const groups = await count(t, GROUP);
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(SLOW)})`);
  await t.reload();
  await ask(t, "Draft this week's announcement for COMM 110 and HUM 150");
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(GROUP)}).length > ${groups}`,
    "the handoff posts",
    WAIT,
  );
  await t.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(GROUP)})].at(-1).querySelectorAll("a").length === 2`,
    "two courses mean two cards",
    WAIT,
  );
  await t.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(GROUP)})].at(-1).innerText.includes("Working")`,
    "the cards say Working while the drafts are written",
    WAIT,
  );
  await shot(t, "reload-mid-handoff-before");
  await t.reload();
  await shot(t, "reload-mid-handoff-reloaded");
  await t.waitFor(
    `${CARD_STATUSES}.every((status) => status !== "" && status !== "Working")`,
    "after a reload mid-handoff, each card shows the draft it started",
    WAIT,
  );
  const group = await lastGroup(t);
  t.assert(
    group.includes("COMM 110") && group.includes("HUM 150"),
    "the group names both courses",
    group,
  );
  t.assert(group.includes("LCC") && group.includes("RSU"), "the group spans both schools", group);
  t.assert(
    (await pathname(t)) === chat,
    "a multi-course handoff stays in the chat, with no jump to a course",
    await pathname(t),
  );
  await shot(t, "multi-handoff");
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await t.reload();
};

const timelineOrder = (t) =>
  t.eval(
    `[...document.querySelector('[data-testid="chat"] > div').children].flatMap((el) => (el.matches(${JSON.stringify(BANNER)}) ? ["banner"] : el.matches("[data-change]") || el.querySelector("[data-change]") ? ["draft"] : []))`,
  );

const chatList = (t, chat) =>
  t.eval(
    `(() => { const { threads } = JSON.parse(localStorage.getItem("lms-app.v1")).state; const list = document.querySelector('[data-testid="sidebar-chats"]'); const rows = [...list.querySelectorAll("li")].map((li) => { const marked = Boolean(li.querySelector('[data-testid="handed-off-mark"]')); if (!li.querySelector("a")) return "more"; if (li.querySelector("a").getAttribute("href") === ${JSON.stringify(chat)}) return marked ? "from" : "unmarked from"; return marked ? "marked" : "chat"; }); const chats = Object.values(threads).filter((thread) => thread.kind === "north-star-chat" && thread.settledAt === undefined).length; return { rows, more: list.textContent.match(/Show (\\d+) more/)?.[1], hidden: chats - rows.filter((row) => row !== "more").length }; })()`,
  );

const oneMoreAtTheEnd = ({ rows, more, hidden }) =>
  rows.filter((row) => row === "more").length === 1 &&
  rows.at(-1) === "more" &&
  more === String(hidden);

const destination = async (t) => {
  const chat = await pathname(t);
  const [first] = await lastGroupLinks(t);
  await t.viewport(1280, 720);
  await t.click(`${GROUP} a[href="${first}"]`);
  await t.waitFor(`location.pathname === ${JSON.stringify(first)}`, "a card opens its thread");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(BANNER)})`,
    "the destination shows the banner",
    WAIT,
  );
  const sidebar = await t.eval(
    `(() => { const list = document.querySelector('[data-testid="sidebar-list"]').getBoundingClientRect(); const inView = (el) => { const r = el?.getBoundingClientRect(); return Boolean(r) && r.top >= list.top && r.bottom <= list.bottom; }; const chats = document.querySelector('[data-testid="sidebar-chats"]'); return { heading: inView(chats.querySelector("h2")), firstRow: inView(chats.querySelector("li")), from: inView(document.querySelector(${JSON.stringify(sidebarLink(chat))})), active: inView(document.querySelector('[data-testid="sidebar-list"] a[aria-current]')) }; })()`,
  );
  t.assert(
    sidebar.heading && sidebar.firstRow && sidebar.from && sidebar.active,
    "at 1280x720 a handoff's thread keeps the Chats heading with its rows, and the chat it came from in view",
    JSON.stringify(sidebar),
  );
  const nav = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR} button[title^="Search"], ${SIDEBAR} a[title="North Star"], ${sidebarLink("/due")}, ${sidebarLink("/inbox")}, ${sidebarLink("/calendar")}`)})].map((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) ? "shown" : el.title; })`,
  );
  t.assert(
    nav.length === 5 && nav.every((row) => row === "shown"),
    "at 1280x720 a handoff's thread keeps the main nav pinned in view",
    JSON.stringify(nav),
  );
  const before = await chatList(t, chat);
  t.assert(
    before.rows.includes("from") && !before.rows.includes("marked"),
    "the chat a thread came from is the only chat marked Handed off",
    JSON.stringify(before),
  );
  t.assert(
    oneMoreAtTheEnd(before),
    "the Chats list ends in one Show N more that counts every hidden chat, with the kept chat above it",
    JSON.stringify(before),
  );
  await shot(t, "destination-sidebar-1280x720");
  await t.viewport(1440, 900);
  await t.waitFor(actionFocused, "a handoff's Open lands with the keyboard on the action", WAIT);
  const banner = await t.text(BANNER);
  t.assert(
    banner.includes("From North Star") &&
      banner.includes("Draft this week's announcement for COMM 110 and HUM 150"),
    "the banner carries the request",
    banner,
  );
  t.assert(
    !banner.includes("Draft this week's announcement for COMM 110."),
    "the banner says the ask once, with no second brief",
    banner,
  );
  const order = await timelineOrder(t);
  t.assert(
    order.indexOf("banner") !== -1 &&
      order.indexOf("banner") < order.indexOf("draft") &&
      order.at(-1) !== "banner",
    "the ask reads above the draft it started",
    JSON.stringify(order),
  );
  const thread = await t.text('[data-testid="chat"]');
  t.assert(
    !thread.includes("Open the draft"),
    "the thread doesn't point at a draft that isn't there",
    thread,
  );
  t.assert(
    await t.eval(
      `document.querySelector('[data-testid="chat"] > div').firstElementChild.matches(${JSON.stringify(BANNER)})`,
    ),
    "the banner is the first thing in the thread",
    thread,
  );
  t.assert(
    !thread.includes("Your last post was"),
    "the lead-in the teacher never asked for is gone from a handoff",
    thread,
  );
  t.assert(
    thread.split("Draft this week's announcement").length === 2,
    "the thread says the ask once",
    thread,
  );
  await shot(t, "destination-banner");
  await t.click("Back to the chat", { within: BANNER });
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(GROUP)})`,
    "the banner links back to the chat",
  );
  t.assert((await lastGroup(t)).includes("COMM 110"), "coming back keeps the cards");
  t.assert(
    !(await t.has('[data-testid="handed-off-mark"]')),
    "on the chat itself, the chat is selected rather than marked Handed off",
  );
  await t.eval("history.back()");
  await t.waitFor(
    `location.pathname === ${JSON.stringify(first)} && document.querySelector(${JSON.stringify(`${sidebarLink(chat)} [data-testid="handed-off-mark"]`)})`,
    "Back returns to the thread with its chat marked Handed off",
  );
  await t.eval("history.forward()");
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(GROUP)})`,
    "Forward returns to the chat",
  );
  await t.eval(
    `(() => { const stored = JSON.parse(localStorage.getItem("lms-app.v1")); const from = stored.state.threads[${JSON.stringify(decodeURIComponent(chat.split("/threads/")[1]))}]; const at = "2000-01-01T00:00:00.000Z"; stored.state.threads["verify-older-chat"] = { ...from, id: "verify-older-chat", messages: [{ ...from.messages[0], at }], updatedAt: at }; localStorage.setItem("lms-app.v1", JSON.stringify(stored)); })()`,
  );
  await t.reload();
  await t.waitFor(
    `document.querySelector(${JSON.stringify(GROUP)})`,
    "an older chat joins the list",
    WAIT,
  );
  await t.viewport(1280, 720);
  await t.click(`${GROUP} a[href="${first}"]`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(first)} && document.querySelector(${JSON.stringify(`${sidebarLink(chat)} [data-testid="handed-off-mark"]`)})`,
    "with an older chat below it, the card still opens its thread with the chat marked",
    WAIT,
  );
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
  ]) {
    await t.viewport(width, height);
    const midList = {
      ...(await chatList(t, chat)),
      inView: await t.eval(
        `(() => { const list = document.querySelector('[data-testid="sidebar-list"]').getBoundingClientRect(); const r = document.querySelector(${JSON.stringify(sidebarLink(chat))}).getBoundingClientRect(); return r.top >= list.top && r.bottom <= list.bottom; })()`,
      ),
    };
    t.assert(
      midList.inView &&
        midList.rows.at(-2) === "from" &&
        oneMoreAtTheEnd(midList) &&
        midList.more === "2",
      `at ${width}x${height} a kept chat mid-list stays in view, with one Show 2 more below it`,
      JSON.stringify(midList),
    );
    await shot(t, `destination-sidebar-mid-list-${width}x${height}`);
  }
  await t.eval("history.back()");
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(GROUP)})`,
    "Back from the mid-list case returns to the chat",
  );
  await t.eval(
    `(() => { const stored = JSON.parse(localStorage.getItem("lms-app.v1")); delete stored.state.threads["verify-older-chat"]; localStorage.setItem("lms-app.v1", JSON.stringify(stored)); })()`,
  );
  await t.reload();
  await t.waitFor(
    `document.querySelector(${JSON.stringify(GROUP)})`,
    "the older chat is gone again",
    WAIT,
  );
};

const askingTwice = async (t) => {
  const first = await lastGroupLinks(t);
  const groups = await count(t, GROUP);
  await ask(t, "Draft this week's announcement for COMM 110 and HUM 150");
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(GROUP)}).length > ${groups}`,
    "asking again posts new cards",
    WAIT,
  );
  await t.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(GROUP)})].at(-1).querySelectorAll("a").length === 2`,
    "asking again names both courses",
    WAIT,
  );
  await settled(t, "asking again settled");
  const second = await lastGroupLinks(t);
  t.assert(
    JSON.stringify(first) === JSON.stringify(second),
    "asking twice reuses the threads",
    `${first} then ${second}`,
  );
  t.assert(
    (await t.text('[data-testid="chat"]')).includes("already have drafts"),
    "asking twice says the drafts already exist",
    await t.text('[data-testid="chat"]'),
  );
  t.assert(
    (await lastGroup(t)).includes("Already drafted"),
    "the cards don't announce existing drafts as new",
    await lastGroup(t),
  );
  const chat = await pathname(t);
  await t.click(`${GROUP} a[href="${second[0]}"]`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(second[0])} && document.querySelector(${JSON.stringify(BANNER)})`,
    "the existing thread opens",
  );
  t.assert(
    (await count(t, BANNER)) === 1,
    "asking twice adds no second banner",
    String(await count(t, BANNER)),
  );
  t.assert(
    (await timelineOrder(t)).at(-1) === "draft",
    "the draft stays the latest thing in the thread",
    JSON.stringify(await timelineOrder(t)),
  );
  await t.click("Back to the chat", { within: BANNER });
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(GROUP)})`,
    "back on the chat after asking twice",
  );
};

const answersInPlace = async (t) => {
  const chat = await pathname(t);
  const groups = await count(t, GROUP);
  await ask(t, "Draft this week's announcement");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ENG_REPLY)})`,
    "asking with no course offers the courses as answers",
    WAIT,
  );
  await settled(t, "the question settled");
  t.assert(
    (await t.text('[data-testid="replies"]')).includes("All my courses"),
    "the answers include All my courses",
    await t.text('[data-testid="replies"]'),
  );
  const sidebarText = await t.text(SIDEBAR);
  const replyCodes = await t.eval(
    `[...document.querySelectorAll("[data-reply]")].map((reply) => reply.dataset.reply).filter((reply) => reply !== "All my courses")`,
  );
  const places = replyCodes.map((code) => sidebarText.indexOf(code));
  t.assert(
    replyCodes.length === 6 &&
      !places.includes(-1) &&
      places.every((place, index) => index === 0 || place > places[index - 1]),
    "the answers run in sidebar order",
    JSON.stringify(replyCodes),
  );
  t.assert(
    !(await t.has('[data-source="course"]')),
    "the question has no course chips that leave the chat",
  );
  await shot(t, "replies");
  await t.click(ENG_REPLY);
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(GROUP)}).length > ${groups}`,
    "clicking an answer yields a handoff card",
    WAIT,
  );
  await settled(t, "the answer settled");
  t.assert((await pathname(t)) === chat, "answering stays in the chat", await pathname(t));
  t.assert(
    (await lastGroup(t)).includes("ENG 305"),
    "the card is for the answer clicked",
    await lastGroup(t),
  );
  t.assert(
    (await t.text('[data-testid="chat"]')).includes("ENG 305"),
    "the answer shows as the person's message",
  );
  t.assert(!(await t.has("[data-reply]")), "the answers are gone once answered");
  t.assert(await t.eval(composerFocused), "the composer has focus after answering");
  t.assert(
    (await t.text('[data-testid="chat"]')).includes(
      "Started a draft announcement in your ENG 305 thread. Students see nothing until you approve it.",
    ),
    "one course says the draft is theirs and nothing went out, in the singular",
    await t.text('[data-testid="chat"]'),
  );
  const [answered] = (await lastGroupLinks(t)).slice(-1);
  await t.click(`${GROUP} a[href="${answered}"]`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(answered)} && document.querySelector(${JSON.stringify(BANNER)})`,
    "the answered course's thread opens",
  );
  const banner = await t.text(BANNER);
  t.assert(
    banner.includes("Draft this week's announcement") && !banner.includes("ENG 305"),
    "the banner shows the original ask, not the answer",
    banner,
  );
  await t.click("Back to the chat", { within: BANNER });
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(GROUP)})`,
    "back on the chat after the answer",
  );
};

const leftOutDetail = async (t) => {
  const groups = await count(t, GROUP);
  await ask(t, "Draft this week's announcement for ENG 210 about Thursday at 7pm");
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(GROUP)}).length > ${groups}`,
    "a detailed ask still hands off",
    WAIT,
  );
  await settled(t, "the detailed ask settled");
  t.assert(
    (await t.text('[data-testid="chat"]')).includes('I left out "Thursday at 7pm"'),
    "the chat names the detail it didn't use",
    await t.text('[data-testid="chat"]'),
  );
  const chat = await pathname(t);
  const [card] = (await lastGroupLinks(t)).slice(-1);
  await t.click(`${GROUP} a[href="${card}"]`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(card)} && document.querySelector(${JSON.stringify(BANNER)})`,
    "the detailed ask's thread opens",
  );
  t.assert(
    (await t.text(BANNER)).includes('Left out of this draft: "Thursday at 7pm"'),
    "the banner names it above the draft",
    await t.text(BANNER),
  );
  await shot(t, "left-out");
  await t.click("Back to the chat", { within: BANNER });
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(GROUP)})`,
    "back on the chat after the detailed ask",
  );
};

const singleReply = async (t) => {
  const groups = await count(t, GROUP);
  await ask(t, "Reply to Imani Okafor");
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(GROUP)}).length > ${groups}`,
    "a reply to one student hands off",
    WAIT,
  );
  await settled(t, "the single reply settled");
  const group = await lastGroup(t);
  t.assert(
    group.includes("Reply to Imani Okafor") && !group.includes("Reply to Imani Okafor and"),
    "a one-student reply card names only that student",
    group,
  );
  await shot(t, "single-reply");
  await replyEditsSurviveLeaving(t);
  await followUps(t);
};

const answerTo = (text) =>
  `(() => { const rows = [...document.querySelector('[data-testid="chat"]').firstElementChild.children]; const at = rows.findLastIndex((row) => row.innerText.trim() === ${JSON.stringify(text)}); if (at < 0 || document.querySelector('[data-testid="agent-working"]')) return null; const after = rows.slice(at + 1); const pills = after.flatMap((row) => [...row.querySelectorAll("[data-reply]")].map((pill) => pill.dataset.reply)); return after.some((row) => row.innerText.trim()) ? { text: after.map((row) => row.innerText).join("\\n"), sources: after.flatMap((row) => [...row.querySelectorAll("[data-source]")].map((line) => line.dataset.source)), pills } : null; })()`;

const followUp = async (t, text) => {
  await ask(t, text);
  await t.waitFor(answerTo(text), `"${text}" gets an answer with pills`, WAIT);
  await settled(t, `"${text}" settled`);
  return t.eval(answerTo(text));
};

const followUps = async (t) => {
  const asked = await followUp(t, "What did she ask about?");
  t.assert(
    asked.text.includes("Imani Okafor wrote to you: Essay 2 is going to be late") &&
      !asked.text.includes("I didn't catch that"),
    "a follow-up question answers about the chat's last handoff",
    asked.text,
  );
  t.assert(
    asked.sources.includes("conversation"),
    "the answer links her message",
    JSON.stringify(asked.sources),
  );
  t.assert(
    !asked.pills.includes("Reply to Imani Okafor") && asked.sources.includes("change"),
    "the answer links her draft instead of offering the reply again",
    JSON.stringify(asked),
  );
  await shot(t, "followup-question");
  const changed = await followUp(t, "make it friendlier");
  t.assert(
    changed.text.includes("Open it in your ENG 101 thread") &&
      !changed.text.includes("I didn't catch that"),
    "a follow-up change points at the draft it started",
    changed.text,
  );
  t.assert(
    changed.sources.includes("change"),
    "the answer links the draft",
    JSON.stringify(changed.sources),
  );
  t.assert(
    !changed.pills.includes("Reply to Imani Okafor"),
    "no pill offers the drafted reply again",
    JSON.stringify(changed.pills),
  );
  await shot(t, "followup-friendlier");
  const groups = await count(t, GROUP);
  await ask(t, "now do the same for Malik");
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(GROUP)}).length > ${groups}`,
    "doing the same for Malik hands off his reply",
    WAIT,
  );
  await settled(t, "the reply to Malik settled");
  const malik = await lastGroup(t);
  t.assert(
    malik.includes("Malik Greene") && !malik.includes("I didn't catch that"),
    "the same for Malik starts his reply",
    malik,
  );
  await shot(t, "followup-same-for-malik");
};

const REPLY_FIELD = 'textarea[aria-label="Reply"]';
const REPLY_OPEN = `document.querySelector(${JSON.stringify(REPLY_FIELD)})`;

const replyEditsSurviveLeaving = async (t) => {
  const chat = await pathname(t);
  const [reply] = await lastGroupLinks(t);
  const typeKept = async (token, how) => {
    await t.waitFor(REPLY_OPEN, `the reply is open before ${how}`);
    await t.click(REPLY_FIELD);
    await t.type(` ${token}`);
    t.assert(
      await t.eval(`document.activeElement === ${REPLY_OPEN}`),
      `the Reply box still has focus before ${how}`,
    );
  };
  const kept = async (token, how) => {
    await t.waitFor(REPLY_OPEN, `the reply reopens after ${how}`);
    const value = await t.eval(`${REPLY_OPEN}.value`);
    t.assert(
      value.includes(token),
      `a typed edit survives ${how} with the box still focused`,
      value,
    );
  };
  await t.click(`${GROUP} a[href="${reply}"]`);
  await typeKept("kept-through-back", "Back");
  await t.eval(`history.back()`);
  await t.waitFor(`location.pathname === ${JSON.stringify(chat)}`, "Back returns to the chat");
  await t.click(`${GROUP} a[href="${reply}"]`);
  await kept("kept-through-back", "Back");
  await typeKept("kept-through-cmd1", "⌘1");
  await t.key("Meta+1");
  await onNorthStar(t, "⌘1 leaves the reply for North Star");
  await t.goto(reply);
  await kept("kept-through-cmd1", "⌘1");
  await typeKept("kept-through-reload", "a reload");
  await t.reload();
  await kept("kept-through-reload", "a reload");
  await shot(t, "reply-edits-kept");
  await t.goto(chat);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(COMPOSER)})`,
    "back on the chat after the reply edits",
  );
};

const declines = async (t) => {
  const writes = () =>
    t.eval(`(async () => JSON.parse(await window.__faultLab.stored()).writeLog.length)()`);
  const before = await writes();
  await ask(t, "approve them all");
  await t.waitFor(
    `document.querySelector("[data-declined]")`,
    "North Star declines to approve",
    WAIT,
  );
  const note = await t.text("[data-declined]");
  t.assert(
    note.includes("Approve on the draft") && !note.includes("Approve and Send"),
    "the note names the button on screen",
    note,
  );
  t.assert(!(await t.has("[data-refusal]")), "an ordinary no doesn't read as an error");
  t.assert(await t.has('[data-declined] [data-source="due"]'), "the note links What's due");
  const chat = await pathname(t);
  await t.click('[data-declined] [data-source="change"]');
  await t.waitFor(
    `location.pathname !== ${JSON.stringify(chat)} && [...document.querySelectorAll("button")].some((button) => button.hasAttribute("data-approve"))`,
    "the note's draft link lands on a draft that can be approved",
  );
  await t.goto(chat);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(COMPOSER)})`,
    "back on the chat after the note's link",
  );
  await ask(t, "Delete all the grades in ENG 101");
  await t.waitFor(
    `document.querySelectorAll("[data-declined]").length === 2`,
    "North Star declines to delete",
    WAIT,
  );
  const deleted = await t.eval(
    `[...document.querySelectorAll("[data-declined]")].at(-1).innerText`,
  );
  t.assert(
    deleted.includes("can't delete") && !deleted.includes("didn't catch that"),
    "a destructive ask reads as a no, not as a misunderstanding",
    deleted,
  );
  await shot(t, "declines-delete");
  t.assert((await writes()) === before, "none of this wrote to the LMS");
};

const focusStaysHome = async (t) => {
  await expandCourse(t, "ENG 101");
  await t.click(`${SIDEBAR} a[href="/threads/t-e101-ann"]`);
  await t.waitFor(
    `location.pathname === "/threads/t-e101-ann" && document.querySelector(${JSON.stringify(COMPOSER)})`,
    "a course thread opens",
  );
  t.assert(
    !(await t.eval(composerFocused)),
    "a course thread does not take focus for its composer",
  );
  await t.key("Meta+k");
  await t.waitFor(
    `document.activeElement === document.querySelector('[role="dialog"] input')`,
    "the palette opens",
  );
  await t.type("North Star");
  await t.key("Enter");
  await onNorthStar(t, "the palette goes to North Star");
  await t.waitFor(composerFocused, "arriving from the palette focuses the composer");
  await t.key("Meta+k");
  await t.waitFor(
    `document.activeElement === document.querySelector('[role="dialog"] input')`,
    "the palette opens again",
  );
  await t.type("printed copies");
  await t.waitFor(
    `document.querySelector('[role="dialog"]').innerText.includes("North Star chat")`,
    "the palette lists a chat by its title",
  );
  await t.key("Enter");
  await t.waitFor(
    `location.pathname !== ${JSON.stringify(NORTH_STAR)} && document.querySelector('[data-testid="screen-crumbs"]').innerText.includes("Find anything about printed copies")`,
    "the palette opens that chat",
  );
};

const missingWork = async (t) => {
  await backHome(t);
  await t.click(COMPOSER);
  await askFromHome(t, "Who hasn't turned in Essay 2?");
  const answer = await t.text('[data-testid="chat"]');
  t.assert(
    answer.includes("1 student hasn't turned in Essay 2 in ENG 101."),
    "the chat answers who hasn't turned the assignment in",
    answer,
  );
  const student = '[data-testid="sources"] [data-source="submission"]';
  t.assert(
    (await count(t, student)) === 1 && (await t.text(student)).includes("Imani Okafor"),
    "the answer names the missing student as a link",
    await t.text('[data-testid="sources"]'),
  );
  await shot(t, "missing-work-answer");

  await t.click(student);
  const row = '[data-testid="queue-list"] li[data-current="true"]';
  await t.waitFor(
    `document.querySelector(${JSON.stringify(row)})?.innerText.includes("Imani Okafor")`,
    "the link opens the grading list on the student's row",
  );
  t.assert(
    (await t.text(row)).includes("Missing") &&
      (await t.text('[data-testid="screen-crumbs"]')).includes("Essay 2"),
    "the row is the missing one, in that assignment's grading list",
    await t.text(row),
  );
  t.assert(
    !(await t.has('[data-testid="agent-working"]')) && !(await t.has(ACTION)),
    "following the link drafts nothing",
  );
  await shot(t, "missing-work-row");
};

const COMPOSER_VALUE = `document.querySelector(${JSON.stringify(COMPOSER)})?.value`;

const composerTextSurvivesLeaving = async (t) => {
  const half = "Draft a reminder for ENG 101 about";
  await backHome(t);
  await t.click(COMPOSER);
  await t.type(half);
  await t.click(sidebarLink("/due"));
  await t.waitFor(`location.pathname === "/due"`, "the sidebar leaves North Star for What's due");
  await backHome(t);
  const back = await t.eval(COMPOSER_VALUE);
  t.assert(back === half, "a half-typed ask survives going to another screen and back", back);
  await t.reload();
  await t.waitFor(
    `document.querySelector(${JSON.stringify(COMPOSER)})`,
    "the composer is back after a reload",
  );
  const reloaded = await t.eval(COMPOSER_VALUE);
  t.assert(reloaded === half, "a half-typed ask survives a reload", reloaded);
  await shot(t, "composer-text-kept");
  await clearComposer(t);
  await t.click(sidebarLink("/due"));
  await t.waitFor(`location.pathname === "/due"`, "leaving with the composer cleared");
  await backHome(t);
  const cleared = await t.eval(COMPOSER_VALUE);
  t.assert(cleared === "", "a cleared composer stays cleared", cleared);
};

const CHATS = '[data-testid="sidebar-chats"]';
const SETTLED_AREA = '[data-testid="settled-area"]';
const rowAction = (scope, href, label) =>
  `${scope} li:has(> a[href="${href}"]) > button[aria-label="${label}"]`;

const settlesChats = async (t) => {
  await t.goto(NORTH_STAR);
  await onNorthStar(t, "on North Star to settle a chat");
  const [chat] = await chatRows(t);
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
  ]) {
    await t.viewport(width, height);
    await t.hover(`${CHATS} a[href="${chat}"]`);
    await t.waitFor(
      `getComputedStyle(document.querySelector(${JSON.stringify(rowAction(CHATS, chat, "Settle thread"))})).opacity === "1"`,
      `at ${width}x${height} hovering a chat row offers Settle`,
    );
    await shot(t, `chat-row-settle-${width}`);
  }
  await t.click(rowAction(CHATS, chat, "Settle thread"));
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(`${CHATS} a[href="${chat}"]`)})`,
    "Settle takes the chat out of Chats",
  );
  t.assert(
    (await pathname(t)) === NORTH_STAR,
    "settling a chat leaves the page where it was",
    await pathname(t),
  );
  await t.waitFor(
    `document.querySelector('[data-testid="undo-toast"]')?.innerText.includes("Settled")`,
    "settling a chat shows the Undo toast",
  );
  await t.click("Undo", { within: '[data-testid="undo-toast"]' });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${CHATS} a[href="${chat}"]`)})`,
    "Undo puts the chat back in Chats",
  );
  await t.hover(`${CHATS} a[href="${chat}"]`);
  await t.click(rowAction(CHATS, chat, "Settle thread"));
  await t.waitFor(
    `!document.querySelector('[data-testid="undo-toast"]')`,
    "the Undo toast goes away on its own",
    WAIT,
  );
  await t.click("Settled", { within: SETTLED_AREA });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${SETTLED_AREA} a[href="${chat}"]`)})`,
    "the settled chat waits in the Settled area",
  );
  await shot(t, "chat-settled");
  await t.hover(`${SETTLED_AREA} a[href="${chat}"]`);
  await t.click(rowAction(SETTLED_AREA, chat, "Resume thread"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${CHATS} a[href="${chat}"]`)})`,
    "Resume puts the chat back in Chats",
  );
};

const RAIL_CHATS = `${SIDEBAR} button[title="Chats"]`;
const railWidth = `document.querySelector(${JSON.stringify(SIDEBAR)}).getBoundingClientRect().width`;

const railReachesChats = async (t) => {
  await t.goto(NORTH_STAR);
  await onNorthStar(t, "on North Star to reach chats from the rail");
  const [chat] = await chatRows(t);
  await t.viewport(1280, 720);
  t.assert(
    !(await t.eval(
      `document.querySelector(${JSON.stringify(RAIL_CHATS)})?.getClientRects().length > 0`,
    )),
    "at 1280 the full sidebar lists chats, so there is no Chats rail item",
  );
  for (const [width, height] of [
    [1180, 800],
    [1024, 768],
  ]) {
    await t.viewport(width, height);
    await t.waitFor(`${railWidth} === 48`, `at ${width} the sidebar is a rail`);
    t.assert(
      await t.eval(
        `(() => { const r = document.querySelector(${JSON.stringify(RAIL_CHATS)})?.getBoundingClientRect(); return Boolean(r && r.width > 0 && r.right <= 48); })()`,
      ),
      `at ${width} the rail shows a Chats item`,
    );
    await shot(t, `rail-chats-${width}`);
    await t.click(RAIL_CHATS);
    await t.waitFor(
      `${railWidth} === 256 && document.activeElement?.closest('[data-testid="sidebar-chats"]') && document.activeElement.matches("a")`,
      `at ${width} Chats opens the sidebar with focus on the first chat`,
    );
    t.assert(
      await t.eval(
        `(() => { const list = document.querySelector('[data-testid="sidebar-list"]').getBoundingClientRect(); const r = document.activeElement.getBoundingClientRect(); return r.top >= list.top && r.bottom <= list.bottom; })()`,
      ),
      `at ${width} the focused chat is in view`,
    );
    await t.key("Escape");
    await t.waitFor(
      `!document.querySelector('[data-testid="sidebar-scrim"]')`,
      `at ${width} Escape closes the opened sidebar`,
    );
    t.assert(
      await t.eval(`document.activeElement?.matches(${JSON.stringify(RAIL_CHATS)})`),
      `at ${width} Escape hands focus back to the Chats item`,
    );
  }
  await t.click(RAIL_CHATS);
  await t.click(`${SIDEBAR} [data-testid="sidebar-chats"] a[href="${chat}"]`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && !document.querySelector('[data-testid="sidebar-scrim"]') && ${railWidth} === 48`,
    "opening a chat from the rail goes there and folds the sidebar back",
  );
  await t.eval(`history.back()`);
  await onNorthStar(t, "Back after opening a chat from the rail returns to North Star");
  t.assert(
    (await t.eval(railWidth)) === 48,
    "and the sidebar is still a rail",
    String(await t.eval(railWidth)),
  );
  await t.viewport(1440, 900);
};

const TOAST = '[data-testid="undo-toast"]';
const SETTLED_MARK = `${HEADER} [data-testid="settled-mark"]`;
const RAIL_SETTLED = `${SIDEBAR} [data-testid="rail-settled"]`;
const listedChats = (t) =>
  t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${CHATS} a[href^="/threads/"]`)})].map((a) => a.getAttribute("href"))`,
  );
const inChats = (href) => `document.querySelector(${JSON.stringify(`${CHATS} a[href="${href}"]`)})`;
const overlaps = (a, b) =>
  `(() => { const a = document.querySelector(${JSON.stringify(a)})?.getBoundingClientRect(); const b = document.querySelector(${JSON.stringify(b)})?.getBoundingClientRect(); return Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; })()`;
const settleRow = async (t, chat) => {
  await t.hover(`${CHATS} a[href="${chat}"]`);
  await t.click(rowAction(CHATS, chat, "Settle thread"));
  await t.waitFor(`!${inChats(chat)}`, `Settle takes ${chat} out of Chats`);
};

// Issue #256: one Undo covers every settle, the open chat says it is settled, the toast clears the send button, and the rail reaches Settled.
const settlingEveryChat = async (t) => {
  await t.viewport(1440, 900);
  await t.goto(NORTH_STAR);
  await onNorthStar(t, "on North Star to settle chats");
  const [open, other] = await listedChats(t);
  t.assert(Boolean(open && other), "two chats to settle", JSON.stringify([open, other]));
  await t.goto(open);
  await t.waitFor(`location.pathname === ${JSON.stringify(open)}`, "the first chat is open");
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
  ]) {
    await t.viewport(width, height);
    await settleRow(t, open);
    await t.waitFor(
      `document.querySelector(${JSON.stringify(SETTLED_MARK)})`,
      `at ${width}x${height} settling the open chat marks it Settled in its header`,
    );
    await t.waitFor(`document.querySelector(${JSON.stringify(TOAST)})`, "the Undo toast shows");
    t.assert(
      !(await t.eval(overlaps(TOAST, '[aria-label="Send to agent"]'))),
      `at ${width}x${height} the Undo toast clears the composer's send button`,
    );
    await shot(t, `settled-open-chat-${width}`);
    await t.click("Resume", { within: HEADER });
    await t.waitFor(
      `${inChats(open)} && !document.querySelector(${JSON.stringify(SETTLED_MARK)})`,
      `at ${width}x${height} Resume in the header puts the open chat back in Chats`,
    );
  }
  await t.viewport(1440, 900);
  await settleRow(t, open);
  await settleRow(t, other);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(TOAST)})?.innerText.includes("Settled 2 threads")`,
    "a second settle adds to the toast",
  );
  await shot(t, "settled-two-toast");
  await t.click("Undo", { within: TOAST });
  await t.waitFor(`${inChats(open)} && ${inChats(other)}`, "one Undo puts back both chats");
  for (let left = await listedChats(t), i = 0; left.length > 0 && i < 30; i++) {
    await settleRow(t, left[0]);
    left = await listedChats(t);
  }
  t.assert(!(await t.has(CHATS)), "every chat is settled, so Chats is gone");
  for (const [width, height] of [
    [1024, 768],
    [800, 600],
  ]) {
    await t.viewport(width, height);
    await t.waitFor(`${railWidth} === 48`, `at ${width} the sidebar is a rail`);
    t.assert(
      await t.eval(
        `(() => { const el = document.querySelector(${JSON.stringify(RAIL_SETTLED)}); const r = el?.getBoundingClientRect(); return Boolean(r && r.width > 0 && r.right <= 48 && el.matches("[data-rail-selected]")); })()`,
      ),
      `at ${width} the rail shows a Settled item, selected for the open settled chat`,
    );
    await shot(t, `rail-settled-${width}`);
    await t.click(RAIL_SETTLED);
    await t.waitFor(
      `${railWidth} === 256 && document.activeElement?.closest('[data-testid="settled-area"]') && document.activeElement.matches("a")`,
      `at ${width} Settled opens the sidebar with focus on the first settled chat`,
    );
    t.assert(
      await t.eval(
        `document.querySelector('[data-testid="settled-area"] a[href=${JSON.stringify(open)}]')?.matches(".row-selected")`,
      ),
      `at ${width} the open chat's settled row is selected`,
    );
    await t.key("Escape");
    await t.waitFor(
      `!document.querySelector('[data-testid="sidebar-scrim"]')`,
      `at ${width} Escape closes the opened sidebar`,
    );
    t.assert(
      await t.eval(`document.activeElement?.matches(${JSON.stringify(RAIL_SETTLED)})`),
      `at ${width} Escape hands focus back to the Settled item`,
    );
  }
  await t.click(RAIL_SETTLED);
  await t.click(`${SIDEBAR} [data-testid="settled-area"] a[href="${other}"]`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(other)} && !document.querySelector('[data-testid="sidebar-scrim"]') && ${railWidth} === 48`,
    "opening a settled chat from the rail goes there and folds the sidebar back",
  );
  await t.eval(`history.back()`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(open)} && ${railWidth} === 48`,
    "Back returns to the first chat with the sidebar still a rail",
  );
  await t.viewport(1440, 900);
};

const slowGlide = async (t) => {
  await backHome(t);
  await t.eval(
    `(() => { window.__rejections = []; addEventListener("unhandledrejection", (e) => window.__rejections.push(String(e.reason))); const start = document.startViewTransition.bind(document); document.startViewTransition = (update) => { document.startViewTransition = start; return start(async () => { await update(); await new Promise((done) => setTimeout(done, 4500)); }); }; })()`,
  );
  await t.click(COMPOSER);
  await askFromHome(t, "What needs grading?");
  await t.sleep(5000);
  t.assert(
    (await t.eval(`window.__rejections.length`)) === 0,
    "a glide the browser gives up on, when the chat takes over 4 s to draw, is not an error",
    JSON.stringify(await t.eval(`window.__rejections`)),
  );
};

const handedOffFrom = (thread) =>
  `JSON.parse(localStorage.getItem("lms-app.v1")).state.threads[${JSON.stringify(thread)}]?.messages.filter((m) => m.type === "handed-off").map((m) => "/threads/" + encodeURIComponent(m.from)) ?? []`;
const markedChats = `[...document.querySelectorAll('[data-testid="sidebar-chats"] li')].flatMap((li) => li.querySelector('[data-testid="handed-off-mark"]') ? [li.querySelector("a").getAttribute("href")] : [])`;
const inSidebarView = (href) =>
  `(() => { const list = document.querySelector('[data-testid="sidebar-list"]').getBoundingClientRect(); const r = document.querySelector(${JSON.stringify(sidebarLink(href))})?.getBoundingClientRect(); return Boolean(r) && r.top >= list.top && r.bottom <= list.bottom; })()`;

// Issue #255: two chats hand off to one thread, and the card in the older chat opens it.
const markFollowsTheCard = async (t) => {
  await backHome(t);
  const older = await askFromHome(t, "Reply to Owen Tierney");
  const [card] = (await lastGroupLinks(t)).slice(-1);
  for (const between of ["What needs grading?", "What's due this week?"]) {
    await backHome(t);
    await askFromHome(t, between);
  }
  await backHome(t);
  const newer = await askFromHome(t, "Draft replies in ENG 101");
  t.assert(
    (await lastGroupLinks(t)).includes(card),
    "both chats hand off to the same thread",
    JSON.stringify(await lastGroupLinks(t)),
  );
  await backHome(t);
  t.assert(
    !(await t.has(sidebarLink(older))),
    "newer chats push the older chat behind Show N more",
    JSON.stringify(await chatRows(t)),
  );
  const from = await t.eval(handedOffFrom(decodeURIComponent(card.split("/threads/")[1])));
  t.assert(
    from.includes(older) && from.at(-1) === newer,
    "the thread was handed off by the older chat, then the newer one",
    JSON.stringify(from),
  );
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
  ]) {
    await t.viewport(width, height);
    await t.goto(older);
    await t.waitFor(
      `location.pathname === ${JSON.stringify(older)} && document.querySelector(${JSON.stringify(GROUP)})`,
      `at ${width}x${height} the older chat opens with its card`,
    );
    await t.click(`${GROUP} a[href="${card}"]`);
    await t.waitFor(
      `location.pathname === ${JSON.stringify(card)} && document.querySelector(${JSON.stringify(BANNER)})`,
      `at ${width}x${height} the older chat's card opens the thread`,
    );
    t.assert(
      JSON.stringify(await t.eval(markedChats)) === JSON.stringify([older]),
      `at ${width}x${height} the chat the card was in is the one marked Handed off`,
      JSON.stringify({ marked: await t.eval(markedChats), older, newer }),
    );
    await t.waitFor(
      inSidebarView(older),
      `at ${width}x${height} the chat the card was in shows in the sidebar`,
    );
    await shot(t, `mark-follows-card-${width}x${height}`);
  }
  await t.eval("history.back()");
  await t.waitFor(
    `location.pathname === ${JSON.stringify(older)} && document.querySelector(${JSON.stringify(GROUP)})`,
    "Back returns to the older chat",
  );
  t.assert(
    !(await t.has('[data-testid="handed-off-mark"]')),
    "back on the older chat, no chat is marked Handed off",
    JSON.stringify(await t.eval(markedChats)),
  );
  await t.eval("history.forward()");
  await t.waitFor(
    `location.pathname === ${JSON.stringify(card)} && document.querySelector(${JSON.stringify(BANNER)})`,
    "Forward returns to the thread",
  );
  t.assert(
    JSON.stringify(await t.eval(markedChats)) === JSON.stringify([older]),
    "after Forward the older chat is still the one marked",
    JSON.stringify(await t.eval(markedChats)),
  );
};

const CARD_NAME = `${GROUP} a[data-handoff] .text-body`;
const cardName = (t) =>
  t.eval(`[...document.querySelectorAll(${JSON.stringify(CARD_NAME)})].at(-1)?.innerText ?? ""`);

// Issue #263: a replies card keeps the name it was handed off with after a send.
const repliesCardKeepsItsName = async (t) => {
  await t.viewport(1440, 900);
  await backHome(t);
  const chat = await askFromHome(t, "Draft replies in ENG 101");
  const before = await cardName(t);
  t.assert(
    /^Reply to .+ and \d+ others?$/.test(before),
    "the replies card names the people it handed off",
    before,
  );
  await shot(t, "replies-card-before-send");
  await t.click(`${GROUP} a[data-handoff]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(BANNER)}) && document.querySelector('[data-testid="card-actions"]')`,
    "the replies card opens the thread on its first draft",
  );
  await t.click("[data-approve]");
  await t.waitFor(`document.querySelector("[data-send]")`, "the first reply approves");
  await t.click("[data-send]");
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]') || document.querySelector("[data-focused]")?.innerText.includes("Written to")`,
    "the first reply sends",
    WAIT,
  );
  await t.eval("history.back()");
  await t.waitFor(
    `location.pathname === ${JSON.stringify(chat)} && document.querySelector(${JSON.stringify(CARD_NAME)})`,
    "Back returns to the chat with its card",
  );
  const after = await cardName(t);
  await shot(t, "replies-card-after-send");
  t.assert(
    after === before,
    "after a send the replies card still names who it handed off",
    JSON.stringify({ before, after }),
  );
  await t.reload();
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD_NAME)})`,
    "the chat reloads with its card",
  );
  t.assert(
    (await cardName(t)) === before,
    "after a reload the replies card still names who it handed off",
    JSON.stringify({ before, reloaded: await cardName(t) }),
  );
};

export const run = async (t) => {
  await t.viewport(1440, 900);
  await hiddenWithoutKey(t);
  await landing(t);
  await question(t);
  await find(t);
  await fallsBackToNextWork(t);
  await singleHandoff(t);
  await multiHandoff(t);
  await destination(t);
  await askingTwice(t);
  await answersInPlace(t);
  await leftOutDetail(t);
  await singleReply(t);
  await declines(t);
  await focusStaysHome(t);
  await typingKeepsFocus(t);
  await missingWork(t);
  await composerTextSurvivesLeaving(t);
  await settlesChats(t);
  await railReachesChats(t);
  await slowGlide(t);
  await markFollowsTheCard(t);
  await repliesCardKeepsItsName(t);
  await settlingEveryChat(t);
};
