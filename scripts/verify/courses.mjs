import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { addAiKey } from "./ai-key.mjs";
import { onboard } from "./onboard.mjs";

const SIDEBAR = '[data-testid="sidebar"]';
const PANEL = '[data-testid="thread-panel"]';
const CHAT = '[data-testid="chat"]';
const CARD = "[data-focused]";
const PREVIEWING = "[data-focused][data-previewing]";
const ACTIONS = '[data-testid="card-actions"]';

const previewOwnsTheDraft = async (t, reply) => {
  const row = await t.eval(
    `(() => { const card = document.querySelector(${JSON.stringify(PREVIEWING)}); if (!card) return null; const edit = card.querySelector("[data-card-edit]"); return { height: card.getBoundingClientRect().height, text: card.innerText, edit: edit?.innerText.trim(), badge: Boolean(card.querySelector('[data-slot="badge"]')), field: Boolean(card.querySelector("textarea, blockquote")), actions: Boolean(card.querySelector(${JSON.stringify(ACTIONS)})) }; })()`,
  );
  t.assert(
    row !== null &&
      row.height <= 34 &&
      row.edit === "Edit" &&
      row.badge &&
      !row.field &&
      !row.actions,
    "with the preview open the card is one row: school, title, status and Edit",
    JSON.stringify(row),
  );
  t.assert(
    !row.text.includes(reply.slice(0, 30)),
    "the reply's text shows once, in the preview",
    row.text,
  );
  const footer = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${PANEL} button`)})].filter((b) => b.closest(${JSON.stringify(PANEL)}) && !b.closest("[data-panel-scroll]")).map((b) => b.innerText.trim())`,
  );
  t.assert(
    footer.includes("Discard") &&
      footer.includes("Approve") &&
      !footer.some((label) => label.startsWith("Send to")),
    "the preview's footer offers Discard and Approve, and no Send before approval",
    JSON.stringify(footer),
  );
  await t.click("[data-card-edit]");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(PANEL)}) && document.activeElement?.matches('[aria-label="Reply"]')`,
    "Edit closes the preview and puts the cursor in the Reply field",
  );
  t.assert(
    (await t.has(ACTIONS)) && (await t.text(ACTIONS)).includes("Discard"),
    "the card opens back up with its own Discard and Review",
  );
  await t.click("Review before sending", { within: ACTIONS });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(PREVIEWING)}) && document.querySelector(${JSON.stringify(`${PANEL} [data-field="message"]`)})`,
    "the preview opens again on the collapsed card",
  );
};
const HEADING = `${CARD} h2`;
const BODY = '[aria-label="Announcement"]';
const LIST = '[data-testid="conversation-list"]';
const TABS = '[data-testid="course-tabs"]';
const SCROLL = '[data-testid="gradebook-scroll"]';
const CALENDAR = '[data-testid="calendar-grid"]';
const DAY_PANEL = '[data-testid="calendar-day-panel"]';
const MARKER_POPUP = "[data-calendar-popup]";
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const threeHoursBack = `(() => { const key = "lms-app.v1"; const data = JSON.parse(localStorage.getItem(key)); const school = Object.values(data.state.cache).find((c) => c.courses.some((x) => x.code === "ENG 101")).courses[0].school; data.state.connections[school].lastSyncedAt = new Date(Date.parse(data.state.connections[school].lastSyncedAt) - 3 * 3600000).toISOString(); localStorage.setItem(key, JSON.stringify(data)); })()`;

let shotNumber = 49;
const shot = (t, name) => t.shot(name, ++shotNumber);

const clearOwnShots = async (t) => {
  for (const file of await readdir(t.shots)) {
    const number = Number(file.slice(0, 2));
    if (number >= 50 && number <= 69) await rm(join(t.shots, file));
  }
};

const lms = (t, expression) =>
  t.eval(
    `(() => { const lms = JSON.parse(localStorage.getItem("lms-app.fake-canvas.v1")); return ${expression}; })()`,
  );
const stored = (t, expression) =>
  t.eval(
    `(() => { const state = JSON.parse(localStorage.getItem("lms-app.v1")).state; return ${expression}; })()`,
  );
const count = (t, selector) =>
  t.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const settled = (t, label) =>
  t.waitFor(`!document.querySelector('[data-testid="agent-working"]')`, label);
const path = (t) => t.eval("location.pathname");

const unreadInSidebar = async (t) => {
  const text = await t.eval(
    `document.querySelector(${JSON.stringify(`${SIDEBAR} a[href="/inbox"]`)})?.innerText ?? ""`,
  );
  return Number(text.match(/(\d+) unread/)?.[1] ?? 0);
};

const goCourse = async (t, code) => {
  await t.click(code, { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(TABS)}) && document.querySelector('[data-testid="screen-crumbs"]').innerText.includes(${JSON.stringify(code)})`,
    `${code}: the sidebar opens its page`,
  );
};

const goTab = async (t, code, tab) => {
  await goCourse(t, code);
  await t.click(tab, { within: TABS });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${TABS} a[aria-current="page"]`)})?.innerText === ${JSON.stringify(tab)}`,
    `${code}: ${tab} tab opens`,
  );
};

const titleFits = (t, label) =>
  t.waitFor(
    `(() => { const title = document.querySelector('[data-testid="screen-crumbs"] h1'); return title && title.scrollWidth <= title.clientWidth; })()`,
    `${label}: the thread title isn't cut off`,
  );

const pageFits = async (t, label) => {
  const fits = await t.eval(
    `document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight`,
  );
  t.assert(fits === true, `${label}: the page itself doesn't scroll`);
  const stray = await t.eval(
    `[...document.querySelectorAll("main button, main a, main p, section button, section a")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1; }).length`,
  );
  t.assert(stray === 0, `${label}: nothing runs past the right edge`, `${stray} elements`);
};

// The panel slides in over 200ms, so anything aimed or measured mid-slide is off by however far it has left to go.
const panelSettled = (t) =>
  t.waitFor(
    `document.querySelector(${JSON.stringify(PANEL)})?.getAnimations().length === 0`,
    "the panel has finished opening",
  );

const openPreview = async (t) => {
  await panelSettled(t);
  await t.click("Preview", { within: PANEL });
  await t.waitFor(
    `document.querySelector('${PANEL} [role="tab"][aria-selected="true"]')?.innerText === "Preview"`,
    "the Preview tab is showing",
  );
};

const setup = async (t) => {
  await t.viewport(1440, 900);
  await t.goto("/welcome");
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await t.reload();
  await onboard(t);
  await t.waitFor(`location.pathname === "/due"`, "demo tokens land on What's due");
  await addAiKey(t);
};

const batchAndTimeline = async (t) => {
  const labels = await t.eval(
    `[...document.querySelectorAll('[data-row] input')].slice(0, 3).map((box) => box.getAttribute("aria-label"))`,
  );
  const names = labels.map((label) => label.replace("Select ", ""));
  t.assert(
    !(await t.has(CHAT)) && !(await t.has("[data-composer]")),
    "with no draft yet, the list stands alone with no chat or composer",
  );
  for (const label of labels) await t.click(`[aria-label="${label}"]`);
  await t.waitFor(
    `document.body.innerText.includes("3 selected")`,
    "the bar counts three selected",
  );
  await t.click("Draft 3");
  await t.waitFor(
    `document.body.innerText.includes("Review 3")`,
    "three drafted rows offer Review 3",
    20_000,
  );
  await t.click("Review 3");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 3`,
    "the batch holds all three",
  );
  await t.click(
    `[aria-label="Remove ${await t.eval(`document.querySelector('[data-batch-item] [aria-label^="Remove"]').getAttribute("aria-label").replace("Remove ", "")`)}"]`,
  );
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 2`,
    "removing takes it out of the panel",
  );
  t.assert(
    (await t.pageText()).includes("2 selected"),
    "removing from the batch deselects its row, so the bar says 2",
  );
  t.assert(
    (await t.text('[data-testid="batch-header"]')).includes("Review 2 changes"),
    "the panel and the bar agree",
  );
  t.assert((await count(t, "[data-row] input:checked")) === 2, "the removed row's box is unticked");
  await titleFits(t, "batch at 1440");
  await shot(t, "batch-one-list");
  await t.viewport(1180, 800);
  await titleFits(t, "batch at 1180");
  t.assert(
    (await t.box('[data-testid="thread-main"]')).width >= 440,
    "batch at 1180 leaves the chat usable",
  );
  await t.viewport(1440, 900);
  await t.click('[aria-label="Close batch"]');

  await t.click(names[1], { within: '[data-testid="queue-list"]' });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes(${JSON.stringify(names[1])})`,
    `${names[1]}: the card shows`,
  );
  await settled(t, "the agent is done");
  const chat = await t.text(CHAT);
  t.assert(
    !chat.includes(names[0]) && !chat.includes(names[2]),
    "another student's work lines stay out of this student's timeline",
  );
  t.assert(
    /^Earlier: 2 students$/.test((await t.text('[data-testid="earlier"]')).trim()),
    "everything else sits behind one quiet row",
    await t.text('[data-testid="earlier"]'),
  );
  await shot(t, "scoped-timeline");
  await t.click('[data-testid="earlier"]');
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CHAT)}).innerText.includes(${JSON.stringify(names[0])})`,
    "the row expands in place",
  );
  t.assert(
    (await t.eval(
      `document.querySelector('[data-testid="earlier"]').getAttribute("aria-expanded")`,
    )) === "true",
    "the row says it's open",
  );
  await shot(t, "earlier-expanded");
  await t.click('[data-testid="earlier"]');
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(CHAT)}).innerText.includes(${JSON.stringify(names[0])})`,
    "and it closes again",
  );
  await t.click("Expand queue");
  await t.click("Clear");
  await t.waitFor(`!document.body.innerText.includes("selected")`, "Clear empties the selection");
};

const whatsDue = async (t) => {
  await t.click("What's due", { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector('[data-testid="due-summary"]')`,
    "What's due opens from the sidebar",
  );
  const summary = await t.text('[data-testid="due-summary"]');
  t.assert(
    /^\d+ submissions? to grade, \d+ unread messages?, \d+ unsent announcements?\.$/.test(
      summary.trim(),
    ),
    "the summary is one line",
    summary,
  );
  t.assert(
    new RegExp(`${await unreadInSidebar(t)} unread`).test(summary),
    "the summary and the sidebar agree on unread",
  );
  const groups = await t.eval(
    `[...document.querySelectorAll('[data-due-group] h2')].map((h) => h.innerText)`,
  );
  t.assert(
    groups[0] === "Do this next" &&
      groups.includes("Then, in this order") &&
      groups.some((h) => h.startsWith("Not yet")),
    "the page reads as a plan",
    groups.join(", "),
  );
  const page = await t.text('[data-testid="due-list"] [data-due-group]');
  t.assert(
    page.startsWith("Do this next\n\nReview grades for Sequence Analysis"),
    "work waiting on approval goes first",
    page.slice(0, 80),
  );
  t.assert(
    (await t.text('[data-due-group="next"] [data-slot=button]')).trim() === "Review and approve",
    "its button says what happens next",
  );
  t.assert(
    (await t.text('[data-due-group="next"] p:nth-of-type(3)')).trim().length > 0,
    "the next step says why it's first",
  );
  t.assert(
    (await count(t, '[data-due-group="next"] [data-slot=button]')) === 1,
    "the next step has one button",
  );
  t.assert(
    (await count(t, "button.bg-primary, a.bg-primary")) === 1,
    "the page has one primary action",
  );
  t.assert((await count(t, "[data-due-unread]")) > 0, "students waiting on a reply have rows");
  t.assert((await count(t, "[data-due-draft]")) > 0, "unsent announcements have their own rows");
  t.assert(
    (await t.eval(
      `document.querySelector('[data-testid="offer-banner"]').compareDocumentPosition(document.querySelector('[data-due-group="not-yet"]')) & Node.DOCUMENT_POSITION_PRECEDING`,
    )) !== 0,
    "next-term courses come after this term's work",
  );
  await pageFits(t, "due at 1440");
  await shot(t, "due");

  const courses = await count(t, "[data-due-course]");
  t.assert(courses > 0, "later work is one line per course");
  const closed = await t.eval(
    `[...document.querySelectorAll("[data-due-course] [data-row]")].filter((row) => row.checkVisibility()).length`,
  );
  t.assert(closed === courses, "a later course's steps stay folded");
  await t.click("[data-due-course] summary");
  await t.waitFor(
    `document.querySelector("[data-due-course] li[data-row]")?.checkVisibility()`,
    "a later course opens to its steps",
  );

  await t.click("RSU", { within: '[aria-label="Filter by school"]' });
  await t.waitFor(
    `document.querySelectorAll('[data-due-course]').length < ${courses}`,
    "the school filter narrows the plan",
  );
  const badges = await t.eval(
    `[...document.querySelectorAll('[data-testid="due-list"] [data-slot="badge"][title]')].map((badge) => badge.textContent)`,
  );
  t.assert(
    badges.length > 0 && badges.every((badge) => badge === "RSU"),
    "every badge left is from that school",
    JSON.stringify(badges),
  );
  t.assert(
    (await t.text('[data-testid="due-summary"]')) !== summary,
    "the summary follows the filter",
  );
  await shot(t, "due-school-filter");
  await t.click("All schools");
  await t.waitFor(
    `document.querySelectorAll('[data-due-course]').length === ${courses}`,
    "All schools brings them back",
  );

  const ref = await t.eval(
    `document.querySelector('[data-due-group="next"] [data-due-row]').dataset.dueRow`,
  );
  await t.click('[data-due-group="next"] [data-due-row]');
  await t.waitFor(
    `location.pathname.startsWith("/threads/")`,
    "the next step's button opens a thread",
  );
  t.assert(
    (await stored(
      t,
      `state.threads[${JSON.stringify(decodeURIComponent((await path(t)).split("/").pop()))}].assignment`,
    )) === ref,
    "it's that assignment's grading thread",
  );
  await t.click('[aria-label="Expand queue"]');
  t.assert((await count(t, "[data-row]")) > 0, "the thread lists that assignment's submissions");

  await t.click("What's due", { within: SIDEBAR });
  const future = await t.eval(
    `[...document.querySelectorAll('[data-due-group="not-yet"] [data-due-row]')].find((row) => !row.innerText.includes("submitted")).dataset.dueRow`,
  );
  await t.click(`[data-due-row="${future}"]`);
  await t.waitFor(
    `document.querySelector('[data-testid="pinned-queue"]')?.innerText.includes("Nothing to grade here")`,
    "a future assignment still has a thread to open",
  );
  const created = await path(t);
  await t.click("What's due", { within: SIDEBAR });
  await t.click(`[data-due-row="${future}"]`);
  await t.waitFor(
    `location.pathname === ${JSON.stringify(created)}`,
    "the second visit finds the same thread rather than starting another",
  );

  await t.click("What's due", { within: SIDEBAR });
  await t.click("[data-due-draft]");
  await t.waitFor(
    `location.pathname.startsWith("/threads/") && document.querySelector('[aria-label="Announcement"]')`,
    "an announcement row starts the draft it promised",
  );
};

const gradableAgrees = async (t) => {
  await t.click("Calendar", { within: SIDEBAR });
  await t.waitFor(`document.querySelector("[data-calendar-marker]")`, "Calendar shows markers");
  const toGrade = await t.eval(
    `[...document.querySelectorAll("[data-calendar-marker]")].filter((m) => /: [1-9]\\d* to grade$/.test(m.getAttribute("aria-label"))).map((m) => m.dataset.calendarMarker)`,
  );
  t.assert(toGrade.length > 0, "the Calendar shows work to grade this week");
  await t.click("What's due", { within: SIDEBAR });
  await t.waitFor(`document.querySelector('[data-testid="due-summary"]')`, "What's due opens");
  const notYet = await t.eval(
    `[...document.querySelectorAll('[data-due-group="not-yet"] [data-due-row]')].map((row) => row.dataset.dueRow)`,
  );
  const steps = await t.eval(
    `[...document.querySelectorAll('[data-row^="grade:"]')].map((row) => row.dataset.row.slice(6))`,
  );
  const disagree = toGrade.filter((ref) => notYet.includes(ref) || !steps.includes(ref));
  t.assert(
    disagree.length === 0,
    "everything the Calendar says to grade is a grade step on What's due, not a Not yet row",
    disagree.join(", "),
  );
};

const dueReplies = async (t) => {
  await t.click("What's due", { within: SIDEBAR });
  await t.click("[data-due-unread]");
  await t.waitFor(
    `location.pathname.startsWith("/threads/") && document.querySelector('[data-testid="pinned-queue"]')`,
    "a reply row opens its messages thread",
  );
};

// The day column weeksThatFit wants before it shows two weeks, past the 160px course lane.
const MIN_DAY_WIDTH = 83;

const calendar = async (t) => {
  const dayCount = (expected, label) =>
    t.waitFor(`document.querySelectorAll('[data-calendar-day]').length === ${expected}`, label);
  const range = () => t.text('[data-testid="calendar-range"]');
  const loadOf = async (offset) =>
    Number(
      (
        await t.eval(
          `document.querySelector('[data-calendar-load="${offset}"]').getAttribute("aria-label")`,
        )
      ).split(" ")[0],
    );
  const neverSideways = async (label) =>
    t.assert(
      await t.eval(
        `(() => { const grid = document.querySelector(${JSON.stringify(CALENDAR)}); return grid.scrollWidth <= grid.clientWidth; })()`,
      ),
      `${label}: the grid doesn't scroll sideways`,
    );
  const pickedInView = async (offset, label) =>
    t.assert(
      await t.eval(
        `(() => { const day = document.querySelector('[data-calendar-day="${offset}"]'); if (day?.getAttribute("aria-pressed") !== "true") return false; const r = day.getBoundingClientRect(), g = document.querySelector(${JSON.stringify(CALENDAR)}).getBoundingClientRect(); return r.left >= g.left && r.right <= g.right + 1; })()`,
      ),
      `${label}: the picked day is in view`,
    );

  const links = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR} a[href]`)})].map((link) => link.getAttribute("href"))`,
  );
  t.assert(
    links[links.indexOf("/inbox") + 1] === "/calendar",
    "Calendar sits right after Messages in the sidebar",
    links.join(", "),
  );
  await t.click("Calendar", { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector('[data-testid="calendar-summary"]')`,
    "Calendar opens from the sidebar",
  );
  await dayCount(
    7,
    "1440 with the sidebar open shows one week, where a chip title fits its column",
  );
  const chromeWidth = 1440 - (await t.box(CALENDAR)).width;
  const narrowestTwoWeeks = chromeWidth + 160 + 14 * MIN_DAY_WIDTH;
  await t.viewport(narrowestTwoWeeks, 900);
  await dayCount(14, "the narrowest window that fits two weeks shows two weeks");
  const summary = await t.text('[data-testid="calendar-summary"]');
  t.assert(
    (await range()) === "Oct 25 to Nov 7",
    "the window starts on the Sunday before today",
    await range(),
  );
  t.assert(
    summary.trim().startsWith("15 due, "),
    "the summary counts what's due in the window",
    summary,
  );
  t.assert(
    (await count(t, "[data-calendar-marker]")) === 15,
    "and the grid shows that many markers",
  );
  t.assert(
    (await t.text('[data-testid="calendar-next-due"]')) === "Nothing due after Nov 7",
    "the toolbar says nothing is due after the window",
    await t.text('[data-testid="calendar-next-due"]'),
  );
  t.assert(
    (await t.text('[aria-current="date"]')).replace(/\s+/g, " ").trim() === "Fri 30",
    "today is marked",
    await t.text('[aria-current="date"]'),
  );
  await neverSideways("two weeks");
  await pageFits(t, "calendar at two weeks");
  await t.shot("calendar", null);

  await t.click('[aria-label="Next week"]');
  await t.waitFor(
    `document.querySelector('[data-testid="calendar-range"]').innerText === "Nov 1 to Nov 14"`,
    "next week moves the window",
  );
  t.assert(
    (await t.eval("location.search")) === "?week=2026-11-01",
    "the URL names the week by its date, so a saved link opens the same week later",
    await t.eval("location.search"),
  );
  await t.click('[aria-label="Previous week"]');
  await t.click('[aria-label="Previous week"]');
  await t.waitFor(
    `document.querySelector('[data-testid="calendar-range"]').innerText === "Oct 18 to Oct 31"`,
    "previous week moves it back",
  );
  for (let step = 0; step < 5; step++) await t.click('[aria-label="Next week"]');
  await t.waitFor(
    `document.querySelector('[data-testid="calendar-range"]').innerText === "Nov 22 to Dec 5"`,
    "four weeks on",
  );
  t.assert(
    (await count(t, "[data-calendar-marker]")) === 0 &&
      (await t.text('[data-testid="calendar-summary"]')).startsWith("0 due"),
    "an empty window counts zero, like its grid",
    await t.text('[data-testid="calendar-summary"]'),
  );
  t.assert(
    (await t.text('[data-testid="calendar-next-due"]')) === "Nothing due after Dec 5",
    "and says nothing is due later, so paging on is pointless",
    await t.text('[data-testid="calendar-next-due"]'),
  );
  await t.click("Today");
  await t.waitFor(
    `document.querySelector('[data-testid="calendar-range"]').innerText === "Oct 25 to Nov 7"`,
    "Today returns to the current window",
  );
  await t.eval(`document.querySelector('[data-calendar-day="8"]').focus()`);
  await t.key("ArrowRight");
  await t.waitFor(
    `document.querySelector('[data-testid="calendar-range"]').innerText === "Nov 8 to Nov 21" && document.activeElement?.dataset.calendarDay === "9"`,
    "ArrowRight on the last day moves the window on, and focus to the day after",
  );
  await t.click("Today");

  await t.eval(`document.querySelector('[data-calendar-day="-1"]').focus()`);
  await t.key("ArrowRight");
  t.assert(
    (await t.eval(`document.activeElement?.dataset.calendarDay`)) === "0",
    "ArrowRight moves focus to the next day",
    await t.eval(`document.activeElement?.dataset.calendarDay`),
  );
  await t.key("ArrowLeft");
  t.assert(
    (await t.eval(`document.activeElement?.dataset.calendarDay`)) === "-1",
    "ArrowLeft moves it back",
  );
  await t.eval(`[...document.querySelectorAll("[data-calendar-day]")].at(-1).focus()`);
  await t.key("Tab");
  t.assert(
    (await t.eval(`document.activeElement?.dataset.calendarMarker !== undefined`)) === true,
    "each day is one Tab stop, so Tab from the last day reaches the first marker",
    await t.eval(`document.activeElement?.outerHTML.slice(0, 120)`),
  );

  const thursday = await loadOf(-1);
  t.assert(thursday === 2, "the load row counts Thursday's two assignments", String(thursday));
  await t.click('[data-calendar-day="-1"]');
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})?.innerText.includes("Thursday, October 29")`,
    "picking a day opens its panel",
  );
  await dayCount(7, "the panel narrows the grid to one week");
  t.assert(
    (await count(t, "[data-calendar-day-row]")) === thursday,
    "the panel has one row per assignment due that day",
  );
  await pickedInView(-1, "Thursday");
  await neverSideways("panel at two weeks");
  await pageFits(t, "calendar with panel at two weeks");
  await t.shot("calendar-day", null);

  await t.eval(`document.querySelector('[data-calendar-day="1"]').focus()`);
  await t.key("ArrowRight");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})?.innerText.includes("Sunday, November 1") && document.querySelector('[data-testid="calendar-range"]').innerText === "Nov 1 to Nov 7" && document.activeElement?.dataset.calendarDay === "2"`,
    "with a day open, ArrowRight on Saturday opens Sunday in the next week",
  );
  t.assert(
    (await t.eval("location.search")) === "?day=2026-11-01",
    "the URL names the open day by its date",
    await t.eval("location.search"),
  );
  await t.shot("calendar-day-next-week", null);
  await t.key("ArrowLeft");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})?.innerText.includes("Saturday, October 31") && document.activeElement?.dataset.calendarDay === "1"`,
    "and ArrowLeft on Sunday goes back to Saturday",
  );

  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DAY_PANEL)})`,
    "Escape closes the panel",
  );
  await dayCount(14, "closing the panel brings two weeks back");

  await t.click('[data-calendar-load="6"]');
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})?.innerText.includes("Thursday, November 5")`,
    "the load row picks a day in the second week",
  );
  await pickedInView(6, "a day in the second week");
  await t.waitFor(
    `document.querySelector('[data-testid="calendar-range"]').innerText === "Nov 1 to Nov 7"`,
    "the window moves to the picked day's week",
  );
  await t.click('[aria-label="Next week"]');
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})?.innerText.includes("Thursday, November 12")`,
    "next week carries the open day along",
  );
  await pickedInView(13, "the carried day");
  await t.eval(`document.querySelector('[data-calendar-day="13"]').focus()`);
  await t.key("ArrowLeft");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})?.innerText.includes("Wednesday, November 11")`,
    "with a day open, ArrowLeft opens the day before",
  );
  t.assert(
    (await t.eval(`document.activeElement?.dataset.calendarDay`)) === "12",
    "and focus moves with it",
    await t.eval(`document.activeElement?.dataset.calendarDay`),
  );
  await t.click("Messages", { within: SIDEBAR });
  await t.waitFor(`location.pathname === "/inbox"`, "Messages opens over the calendar");
  await t.eval("history.back()");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})?.innerText.includes("Wednesday, November 11") && document.querySelector('[data-testid="calendar-range"]')?.innerText === "Nov 8 to Nov 14"`,
    "Back returns to the open day and its week",
  );
  await t.click("Today");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})?.innerText.includes("Friday, October 30")`,
    "Today moves the open day to today",
  );

  await t.click("Search threads and students", { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector('[data-testid="palette"]')`,
    "the palette opens over the panel",
  );
  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector('[data-testid="palette"]')`,
    "Escape closes the palette",
  );
  t.assert(await t.has(DAY_PANEL), "and leaves the panel open");
  await t.click('[aria-label="Close day"]');
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DAY_PANEL)})`,
    "the close button closes the panel",
  );

  await t.viewport(1180, 800);
  await dayCount(7, "1180 shows one week");
  await neverSideways("one week at 1180");
  await pageFits(t, "calendar at 1180");
  await t.click('[data-calendar-day="-1"]');
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})`,
    "the panel opens at 1180",
  );
  await neverSideways("panel at 1180");
  await pageFits(t, "calendar with panel at 1180");
  t.assert(
    (await t.text('[data-testid="calendar-next-due"]')) === "Next due Nov 3",
    "a one-week window offers the next due date after it",
    await t.text('[data-testid="calendar-next-due"]'),
  );
  const broken = await t.eval(
    `(() => { const lanes = [...document.querySelectorAll("[data-calendar-course] > span, [data-calendar-school] > span")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent); const titles = [...document.querySelectorAll("[data-calendar-title]")].filter((title) => title.getClientRects().length > 1 || title.clientHeight > 2 * parseFloat(getComputedStyle(title).lineHeight) + 1 || getComputedStyle(title).webkitLineClamp !== "2").map((title) => title.textContent); return [...lanes, ...titles]; })()`,
  );
  t.assert(
    broken.length === 0,
    "at 1180 with the panel open, lane names show whole, and each chip title takes at most two lines, clamped when it runs long",
    broken.join(" | "),
  );
  await shot(t, "calendar-day-1180");
  await t.viewport(1280, 720);
  // The lane width follows a ResizeObserver, so it lags a resize by a frame. Measure once the day width holds across frames.
  await t.eval(
    `new Promise((done) => { let last = -1, steady = 0, frames = 0; const tick = () => { const width = document.querySelector("[data-calendar-day]").getBoundingClientRect().width; steady = width === last ? steady + 1 : 0; last = width; if (steady >= 3 || ++frames > 120) done(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`,
  );
  const splitWords = await t.eval(
    `[...document.querySelectorAll("[data-calendar-title]")].flatMap((title) => [...title.textContent.matchAll(/\\S+/g)].filter((word) => { const range = document.createRange(); range.setStart(title.firstChild, word.index); range.setEnd(title.firstChild, word.index + word[0].length); return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1; }).map((word) => word[0]))`,
  );
  t.assert(
    splitWords.length === 0,
    "at 1280x720 with the panel open, no chip title breaks a word across lines",
    splitWords.join(" | "),
  );
  await shot(t, "calendar-day-1280");
  await t.viewport(1180, 800);
  await t.click('[data-testid="calendar-next-due"]');
  await t.waitFor(
    `document.querySelector('[data-testid="calendar-range"]').innerText === "Nov 1 to Nov 7"`,
    "Next due jumps to the week it names",
  );
  await t.click("Today");
  await t.click('[aria-label="Close day"]');
  await t.viewport(narrowestTwoWeeks, 900);
  await dayCount(14, "back at the wide window it shows two weeks");

  const courses = await count(t, "[data-calendar-course]");
  await t.click("RSU", { within: '[aria-label="Filter by school"]' });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(`${CALENDAR} [data-school-star="lcc"]`)})`,
    "a school chip removes the other school's rows",
  );
  t.assert(await t.has(`${CALENDAR} [data-school-star="rsu"]`), "the chosen school stays");
  await t.click("Messages", { within: SIDEBAR });
  await t.waitFor(`location.pathname === "/inbox"`, "Messages opens over the filtered calendar");
  await t.eval("history.back()");
  await t.waitFor(
    `new URLSearchParams(location.search).get("school") === "rsu" && !document.querySelector(${JSON.stringify(`${CALENDAR} [data-school-star="lcc"]`)})`,
    "Back returns to the calendar with its school filter kept in the URL",
  );
  t.assert(
    (await count(t, "[data-calendar-course]")) < courses,
    "that school's courses are all that's left",
  );
  t.assert(
    (await t.text('[data-testid="calendar-summary"]')) !== summary,
    "the summary follows the filter",
  );
  await t.click("All schools");
  await t.waitFor(
    `document.querySelectorAll('[data-calendar-course]').length === ${courses}`,
    "All schools brings them back",
  );

  const markerAt = (ref) => `[data-calendar-marker="${ref}"]`;
  const pointerOff = async (label) => {
    await t.hover('[data-testid="calendar-range"]');
    await t.waitFor(
      `!document.querySelector(${JSON.stringify(MARKER_POPUP)})`,
      `${label}: the popup goes away when the pointer moves off`,
    );
  };
  const expectedLines = (ref) =>
    stored(
      t,
      `(() => { const cache = Object.values(state.cache).find((c) => c.assignments.some((a) => a.ref === ${JSON.stringify(ref)})); const assignment = cache.assignments.find((a) => a.ref === ${JSON.stringify(ref)}); const toGrade = cache.submissions.filter((s) => s.assignment === assignment.ref && s.workflow === "submitted").length; return [state.schools.find((s) => s.id === assignment.school).name, assignment.title, toGrade + " to grade"]; })()`,
    );
  const popupOpen = (label) =>
    t.waitFor(
      `(() => { const popup = document.querySelector(${JSON.stringify(MARKER_POPUP)}); return popup && popup.getAnimations().length === 0; })()`,
      `${label}: the popup opens`,
    );
  const popupCovers = async (ref, label) => {
    const fits = await t.eval(
      `(() => { const p = document.querySelector(${JSON.stringify(MARKER_POPUP)}).getBoundingClientRect(), m = document.querySelector(${JSON.stringify(markerAt(ref))}).getBoundingClientRect(); return { inside: p.left >= 0 && p.top >= 0 && p.right <= innerWidth && p.bottom <= innerHeight, covers: p.left <= m.left + 0.5 && p.top <= m.top + 0.5 && p.right >= m.right - 0.5 && p.bottom >= m.bottom - 0.5, popup: [p.left, p.top, p.right, p.bottom], marker: [m.left, m.top, m.right, m.bottom], viewport: [innerWidth, innerHeight] }; })()`,
    );
    t.assert(fits.inside, `${label}: the popup stays inside the window`, JSON.stringify(fits));
    t.assert(fits.covers, `${label}: the popup covers its marker`, JSON.stringify(fits));
  };
  const showsItsAssignment = async (ref, label) => {
    const expected = await expectedLines(ref);
    const lines = (await t.text(MARKER_POPUP))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    t.assert(
      JSON.stringify(lines) === JSON.stringify(expected),
      `${label}: the popup shows school, full title, and how many to grade`,
      `${lines.join(" | ")} vs ${expected.join(" | ")}`,
    );
  };
  const placedOn = (attribute) =>
    t.eval(`document.querySelector(${JSON.stringify(MARKER_POPUP)}).dataset.${attribute}`);
  const layoutOf = (ref) =>
    t.eval(
      `(() => { const m = document.querySelector(${JSON.stringify(markerAt(ref))}).getBoundingClientRect(), g = document.querySelector(${JSON.stringify(CALENDAR)}); return JSON.stringify({ marker: [m.x, m.y, m.width, m.height], grid: [g.scrollHeight, g.scrollWidth, g.clientHeight] }); })()`,
    );

  await dayCount(14, "the narrowest window that still fits two weeks shows two weeks");
  t.assert(
    (await t.box("[data-calendar-day]")).width < MIN_DAY_WIDTH,
    "and the day columns are at their narrowest",
    String((await t.box("[data-calendar-day]")).width),
  );
  const refs = await t.eval(
    `[...document.querySelectorAll('[data-calendar-marker]')].map((el) => el.dataset.calendarMarker)`,
  );
  const clamped = await stored(
    t,
    `Object.values(state.cache).flatMap((c) => c.assignments).find((a) => ${JSON.stringify(refs)}.includes(a.ref) && a.shortTitle !== a.title)?.ref`,
  );
  t.assert(Boolean(clamped), "a marker's short title differs from its full title", refs.join(", "));
  const before = await layoutOf(clamped);
  await t.hover(markerAt(clamped));
  await popupOpen("hovering a marker");
  await showsItsAssignment(clamped, "hovering a marker");
  await popupCovers(clamped, "hovering a marker");
  t.assert(
    (await layoutOf(clamped)) === before,
    "the popup doesn't move the marker or resize the grid",
    `${before} then ${await layoutOf(clamped)}`,
  );
  await pageFits(t, "calendar with a popup open");
  await t.shot("calendar-hover", null);
  await pointerOff("hovering a marker");
  t.assert((await layoutOf(clamped)) === before, "and the grid is unchanged after it closes");

  const rightmost = await t.eval(
    `[...document.querySelectorAll('[data-calendar-marker]')].sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0].dataset.calendarMarker`,
  );
  await t.hover(markerAt(clamped));
  await popupOpen("back on the marker");
  await t.hover(markerAt(rightmost));
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(MARKER_POPUP)}).length === 1 && document.querySelector(${JSON.stringify(MARKER_POPUP)}).innerText.includes(${JSON.stringify((await expectedLines(rightmost))[1])}) && document.querySelector(${JSON.stringify(MARKER_POPUP)}).dataset.instant === "delay"`,
    "moving straight to another marker swaps the popup with no delay",
  );
  await popupOpen("the rightmost marker");
  await showsItsAssignment(rightmost, "the rightmost marker");
  await popupCovers(rightmost, "the rightmost marker");
  t.assert(
    (await placedOn("align")) === "end",
    "the rightmost marker: the popup flips to end at its right edge",
    await placedOn("align"),
  );
  await pointerOff("the rightmost marker");

  // Short enough that the lowest marker starts below the fold, so scrolling can bring it flush.
  const edgeHeight = 440;
  await t.viewport(narrowestTwoWeeks, edgeHeight);
  const lowest = await t.eval(
    `(() => { const markers = [...document.querySelectorAll('[data-calendar-marker]')].map((el) => ({ ref: el.dataset.calendarMarker, bottom: el.getBoundingClientRect().bottom })); const lastRow = Math.max(...markers.map((m) => m.bottom)); return markers.filter((m) => m.bottom < lastRow - 40).sort((a, b) => b.bottom - a.bottom)[0].ref; })()`,
  );
  await t.eval(
    `(() => { const grid = document.querySelector(${JSON.stringify(CALENDAR)}); grid.scrollTop += document.querySelector(${JSON.stringify(markerAt(lowest))}).getBoundingClientRect().bottom - grid.getBoundingClientRect().bottom; })()`,
  );
  t.assert(
    (await t.box(markerAt(lowest))).bottom >= edgeHeight - 1,
    "a marker sits flush with the window's bottom edge",
    String((await t.box(markerAt(lowest))).bottom),
  );
  await t.hover(markerAt(lowest));
  await popupOpen("the bottom-edge marker");
  await showsItsAssignment(lowest, "the bottom-edge marker");
  await popupCovers(lowest, "the bottom-edge marker");
  t.assert(
    (await placedOn("side")) === "top",
    "the bottom-edge marker: the popup flips upward",
    await placedOn("side"),
  );
  await pointerOff("the bottom-edge marker");
  await t.viewport(narrowestTwoWeeks, 900);
  await dayCount(14, "back at the wide window it still shows two weeks");

  const first = await t.eval(
    `document.querySelector('[data-calendar-marker]').dataset.calendarMarker`,
  );
  await t.eval(`[...document.querySelectorAll('[data-calendar-load]')].at(-1).focus()`);
  await t.key("Tab");
  await t.waitFor(
    `document.activeElement?.dataset.calendarMarker === ${JSON.stringify(first)}`,
    "Tab reaches a marker",
  );
  await popupOpen("keyboard focus");
  await showsItsAssignment(first, "keyboard focus");
  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(MARKER_POPUP)})`,
    "Escape closes a popup opened by focus",
  );
  await t.eval(`document.activeElement.blur()`);

  await t.click('[data-calendar-day="-1"]');
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DAY_PANEL)})`,
    "a day is open for the Escape check",
  );
  await t.hover("[data-calendar-marker]");
  await popupOpen("with a day open");
  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(MARKER_POPUP)})`,
    "with a day open, the first Escape closes the popup",
  );
  t.assert(await t.has(DAY_PANEL), "and leaves the day open");
  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DAY_PANEL)})`,
    "the second Escape closes the day",
  );
  await t.hover('[data-testid="calendar-range"]');
  await dayCount(14, "two weeks are back after the day closes");

  const ref = await t.eval(
    `document.querySelector('[data-calendar-marker]').dataset.calendarMarker`,
  );
  await t.hover("[data-calendar-marker]");
  await popupOpen("before the click");
  await t.click("[data-calendar-marker]");
  await t.waitFor(
    `location.pathname.startsWith("/threads/") && !document.querySelector(${JSON.stringify(MARKER_POPUP)})`,
    "a click through the open popup opens a thread, and the popup doesn't follow",
  );
  t.assert(
    (await stored(
      t,
      `state.threads[${JSON.stringify(decodeURIComponent((await path(t)).split("/").pop()))}].assignment`,
    )) === ref,
    "it's that assignment's grading thread",
    ref,
  );

  await t.click("Search threads and students", { within: SIDEBAR });
  await t.waitFor(`document.querySelector('[data-testid="palette"]')`, "the palette opens");
  await t.type("calendar");
  await t.waitFor(
    `document.querySelector('[data-testid="palette"]').innerText.includes("Calendar")`,
    "the palette finds Calendar",
  );
  await t.key("Enter");
  await t.waitFor(`location.pathname === "/calendar"`, "and goes there");
  await t.viewport(1440, 900);
};

const inbox = async (t) => {
  await t.click("Messages", { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(LIST)})`,
    "the inbox opens from the sidebar",
  );
  const total = await lms(t, "lms.conversations.length");
  t.assert(
    (await count(t, "[data-conversation]")) === total,
    "every conversation from both schools is listed",
    String(total),
  );
  const expected = await lms(
    t,
    `lms.conversations.map((c) => [c.ref, c.messages.at(-1)?.at ?? ""]).sort((a, b) => b[1].localeCompare(a[1])).map((c) => c[0])`,
  );
  const listed = await t.eval(
    `[...document.querySelectorAll('[data-conversation]')].map((row) => row.dataset.conversation)`,
  );
  const times = await lms(
    t,
    `Object.fromEntries(lms.conversations.map((c) => [c.ref, c.messages.at(-1)?.at ?? ""]))`,
  );
  t.assert(
    listed.every((ref, index) => index === 0 || times[listed[index - 1]] >= times[ref]) &&
      expected.length === listed.length,
    "newest is first",
  );

  const startUnread = await unreadInSidebar(t);
  const STATUS = '[data-testid="inbox-list"] [aria-label="Filter by status"]';
  const SCHOOL = '[data-testid="inbox-list"] [aria-label="Filter by school"]';
  const chips = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${STATUS} button, ${SCHOOL} button`)})].map((b) => b.innerText.replace(/\\s+/g, " ").trim())`,
  );
  t.assert(
    chips.length === 4 &&
      chips[0].startsWith("All ") &&
      chips[1].startsWith("Needs reply ") &&
      chips[2] === "LCC" &&
      chips[3] === "RSU",
    "the top row is All, Needs reply and one chip per school, with no Unread twin",
    JSON.stringify(chips),
  );
  const needsReply = Number(chips[1].split(" ").at(-1));
  await t.click("Needs reply", { within: STATUS });
  await t.waitFor(
    `document.querySelectorAll('[data-conversation]').length === ${needsReply} && ${needsReply} > 0`,
    "Needs reply lists what the students are waiting on",
  );
  const filterRow = `document.querySelector(${JSON.stringify(STATUS)}).parentElement`;
  t.assert(
    await t.eval(
      `(() => { const row = ${filterRow}; const last = row.lastElementChild.getBoundingClientRect(); return row.scrollWidth <= row.clientWidth && last.right <= row.getBoundingClientRect().right - 12; })()`,
    ),
    "the filters fit on one row inside the list column",
  );
  await t.click("RSU", { within: SCHOOL });
  await t.waitFor(
    `document.querySelectorAll('[data-conversation]').length > 0 && [...document.querySelectorAll('[data-conversation]')].every((row) => row.innerText.includes("RSU")) && document.querySelectorAll('[data-conversation]').length < ${needsReply}`,
    "one click on a school narrows it to that school",
  );
  await shot(t, "inbox-school-filter");
  await t.click("RSU", { within: SCHOOL });
  await t.waitFor(
    `document.querySelectorAll('[data-conversation]').length === ${needsReply} && !document.querySelector(${JSON.stringify(`${SCHOOL} [aria-pressed="true"]`)})`,
    "a second click on the school clears it",
  );
  await t.click("More", { within: '[data-testid="inbox-list"]' });
  await t.click("Waiting on approval", { within: '[data-testid="inbox-filter-menu"]' });
  await t.waitFor(
    `document.querySelectorAll('[data-conversation]').length === 0 && document.body.innerText.includes("Nothing in this view")`,
    "with no drafts, nothing waits on approval",
  );
  await t.click("All", { within: '[aria-label="Filter by status"]' });

  const target = await t.eval(
    `document.querySelector('[data-conversation][data-unread="true"]').dataset.conversation`,
  );
  await t.click(`[data-conversation="${target}"] button`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})`,
    "opening a conversation drafts a reply",
    15_000,
  );
  await settled(t, "the draft is done");
  t.assert(
    (await t.eval(`document.querySelectorAll('[data-testid="history"] [data-message]').length`)) ===
      (await lms(
        t,
        `lms.conversations.find((c) => c.ref === ${JSON.stringify(target)}).messages.length`,
      )),
    "the full history shows above the draft",
  );
  t.assert(
    (await unreadInSidebar(t)) === startUnread - 1,
    "opening it marks it read in the sidebar",
  );
  await t.click('[aria-label="Mark unread"]');
  await t.waitFor(
    `document.querySelector('[data-conversation=${JSON.stringify(target)}]').dataset.unread === "true"`,
    "Mark unread puts the dot back",
  );
  t.assert((await unreadInSidebar(t)) === startUnread, "and the sidebar counts it again");
  await t.click(`[data-conversation="${target}"] button`);
  await t.waitFor(
    `document.querySelector('[data-conversation=${JSON.stringify(target)}]').dataset.unread === "false"`,
    "opening it again reads it",
  );

  const before = await t.eval(`document.querySelector('[aria-label="Reply"]').value`);
  await t.click("[data-composer]");
  await t.type("make it shorter");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector('[aria-label="Reply"]').value !== ${JSON.stringify(before)}`,
    "the composer corrects the reply",
  );
  await settled(t, "the correction is done");
  t.assert(
    (await t.eval(`document.querySelector('[aria-label="Reply"]').value.length`)) < before.length,
    "and it really is shorter",
  );
  await shot(t, "inbox-draft-corrected");

  t.assert(
    /^Message in [A-Z]+ \d+$/.test(await t.text(`${CARD} [data-card-line]`)),
    "a reply's card says it's a message and in which course",
    await t.text(`${CARD} [data-card-line]`),
  );
  const reply = await t.eval(`document.querySelector('[aria-label="Reply"]').value`);
  await t.click("Review before sending", { within: ACTIONS });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${PANEL} [data-field="message"]`)})?.innerText.includes(${JSON.stringify(reply)})`,
    "the preview shows the whole reply",
  );
  await previewOwnsTheDraft(t, reply);
  t.assert(
    await t.eval(
      `(() => { const title = document.querySelector('[data-testid="conversation-header"] h2'); return title.scrollWidth <= title.clientWidth; })()`,
    ),
    "the subject stays whole with the panel open",
  );
  await shot(t, "inbox-review");
  await t.click("[data-approve]");
  await t.waitFor(`document.body.innerText.includes("Undo approval")`, "a real click approves it");
  const history = await count(t, '[data-testid="history"] [data-message]');
  await t.click("Send to", { within: PANEL });
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]')`,
    "the reply sends",
    15_000,
  );
  await t.waitFor(
    `document.querySelectorAll('[data-testid="history"] [data-message]').length === ${history + 1}`,
    "the reply joins the history",
  );
  const lastInLms = await lms(
    t,
    `(() => { const m = lms.conversations.find((c) => c.ref === ${JSON.stringify(target)}).messages.at(-1); return { id: m.id, mine: m.mine, text: m.text }; })()`,
  );
  t.assert(lastInLms.mine === true, "the LMS holds the reply");
  t.assert(
    (await t.eval(
      `document.querySelector('[data-testid="history"] [data-message]:last-child').dataset.message`,
    )) === lastInLms.id,
    "the history shows the provider's own message",
  );
  t.assert(
    (
      await t.eval(
        `document.querySelector('[data-testid="history"] [data-message]:last-child').innerText`,
      )
    ).includes(lastInLms.text.slice(0, 30)),
    "with the provider's text",
  );
  t.assert((await unreadInSidebar(t)) === startUnread - 1, "the count holds after the send");
  await shot(t, "inbox-sent");
  await t.click("Close preview", { within: PANEL });
  await t.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, "the panel closes");

  const changesFor = (ref) =>
    stored(
      t,
      `Object.values(state.changes).filter((c) => c.content.target === ${JSON.stringify(ref)}).length`,
    );
  const other = await t.eval(
    `document.querySelector('[data-conversation][data-unread="true"]').dataset.conversation`,
  );
  await t.click(`[data-conversation="${other}"] button`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.dataset`,
    "another conversation drafts too",
    15_000,
  );
  await settled(t, "that draft is done");
  await t.click("Review before sending", { within: ACTIONS });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${CARD}[data-previewing]`)})`,
    "the preview opens on the other draft",
  );
  await t.click("[data-approve]");
  await t.waitFor(`document.body.innerText.includes("Undo approval")`, "the other draft approves");
  await t.click("Undo approval");
  await t.waitFor(
    `!document.body.innerText.includes("Undo approval")`,
    "Undo approval puts it back to a draft",
  );
  await shot(t, "inbox-approval-undone");
  await t.click("Discard", { within: PANEL });
  await t.waitFor(
    `document.body.innerText.includes("Draft a reply") && !document.querySelector(${JSON.stringify(PANEL)})`,
    "Discard in the preview's footer discards the draft, closes the preview, and offers the way back",
  );
  t.assert(!(await t.has(CARD)), "the discarded card is gone");
  t.assert(
    (await t.eval(`document.querySelector("[data-composer]").placeholder`)) ===
      "Draft a reply, then correct it here",
    "with the conversation still open, the composer doesn't ask you to open a message",
    await t.eval(`document.querySelector("[data-composer]").placeholder`),
  );
  await t.click("Draft a reply");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})`,
    "drafting again works",
    15_000,
  );
  await settled(t, "the new draft is done");
  await t.click(`[data-conversation="${target}"] button`);
  await t.waitFor(
    `document.querySelector('[data-testid="conversation-header"]') && document.querySelector('[data-testid="receipt"]')`,
    "the answered conversation shows what was sent",
  );
  await settled(t, "reopening is quiet");
  t.assert(
    (await changesFor(target)) === 1,
    "reopening an answered conversation doesn't draft another reply",
  );
  await t.click("Close conversation");
  await t.waitFor(
    `document.body.innerText.includes("Pick a conversation")`,
    "a conversation can be closed",
  );
  const [first, second] = await t.eval(
    `[...document.querySelectorAll('[data-conversation][data-unread="false"]')].slice(0, 2).map((row) => row.dataset.conversation)`,
  );
  const showing = (ref) =>
    `location.pathname === "/inbox" && document.querySelector('[data-conversation=${JSON.stringify(ref)}]')?.dataset.current === "true" && document.querySelector('[data-testid="conversation-header"]') !== null`;
  await t.click(`[data-conversation="${first}"] button`);
  await t.waitFor(showing(first), "one conversation opens");
  await settled(t, "the first conversation is quiet");
  await t.click(`[data-conversation="${second}"] button`);
  await t.waitFor(showing(second), "then another");
  await settled(t, "the second conversation is quiet");
  await shot(t, "inbox-before-back");
  await t.eval("history.back()");
  await t.waitFor(showing(first), "Back returns to the conversation before it");
  await shot(t, "inbox-after-back");
  await t.eval("history.back()");
  await t.waitFor(
    `location.pathname === "/inbox" && document.body.innerText.includes("Pick a conversation")`,
    "Back again returns to Messages with nothing open",
  );
  await t.eval("history.forward()");
  await t.waitFor(showing(first), "Forward opens it again");
  await t.click("Close conversation");
  await t.waitFor(`document.body.innerText.includes("Pick a conversation")`, "and it closes");

  const unreadBefore = await unreadInSidebar(t);
  const two = await t.eval(
    `[...document.querySelectorAll('[data-conversation][data-unread="true"] input')].slice(0, 2).map((box) => box.getAttribute("aria-label"))`,
  );
  for (const label of two) await t.click(`[aria-label="${label}"]`);
  await t.waitFor(`document.body.innerText.includes("2 selected")`, "two conversations selected");
  await t.click("Draft 2");
  await t.waitFor(`document.body.innerText.includes("Review 2")`, "both drafted", 20_000);
  t.assert(
    (await unreadInSidebar(t)) === unreadBefore,
    "drafting alone doesn't change the unread count",
  );
  await t.click("Review 2");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 2`,
    "the queue's batch review opens here",
  );
  await shot(t, "inbox-batch");
  await t.click("Approve 2");
  await t.waitFor(
    `[...document.querySelectorAll('[data-testid="batch-header"] button')].some((b) => b.innerText === "Send 2" && !b.disabled)`,
    "both approved by one click",
  );
  await t.click("Send 2");
  await t.waitFor(
    `document.querySelector('[data-testid="batch-outcome"]')?.innerText === "2 sent"`,
    "both replies send",
    20_000,
  );
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${SIDEBAR} a[href="/inbox"]`)}).innerText.includes(${JSON.stringify(`${unreadBefore - 2} unread`)})`,
    "the sidebar's count drops by two as they go out",
  );
  await t.click('[aria-label="Close batch"]');
  await t.waitFor(
    `!document.querySelector('[data-batch-item]') && !document.body.innerText.includes("2 selected")`,
    "closing the batch ends the selection",
  );
};

const announcements = async (t) => {
  await goTab(t, "ENG 101", "Announcements");
  const course = await lms(
    t,
    `(() => { const c = lms.courses.find((c) => c.code === "ENG 101"); return { ref: c.ref, students: c.studentCount ?? lms.students.filter((s) => s.course === c.ref).length }; })()`,
  );
  const postedBefore = await count(t, "[data-posted]");
  await t.click("New announcement");
  await t.waitFor(
    `document.querySelector('[aria-label="Announcement"]')?.closest(${JSON.stringify(CARD)})`,
    "the agent drafts it in the course's thread",
    15_000,
  );
  await settled(t, "the announcement is drafted");
  t.assert((await path(t)).startsWith("/threads/"), "it opens a thread");
  const original = await t.text(HEADING);
  t.assert(
    !(await t.has('[aria-label="Title"]')),
    "the title shows once, as the card's heading, with no separate field",
    original,
  );
  await t.click(HEADING);
  await t.waitFor(
    `document.activeElement?.matches('[aria-label="Title"]') && document.activeElement.value === ${JSON.stringify(original)}`,
    "a click on the heading edits it in place",
  );
  await t.type(" (scrapped)");
  await shot(t, "announcement-title-editing");
  await t.key("Escape");
  await t.waitFor(
    `document.activeElement?.matches('[aria-label="Edit title"]')`,
    "Escape closes the edit and keeps the keyboard on the card",
  );
  t.assert(
    (await t.text(HEADING)) === original,
    "Escape puts the title back",
    await t.text(HEADING),
  );

  await t.key("Enter");
  await t.waitFor(
    `document.activeElement?.matches('[aria-label="Title"]')`,
    "the keyboard reaches the title through Edit title",
  );
  await t.eval(`document.activeElement.select()`);
  await t.key("Backspace");
  await t.key("Enter");
  await t.waitFor(
    `document.activeElement?.matches('[aria-label="Title"]') && document.activeElement.value === "" && !document.querySelector(${JSON.stringify(HEADING)})`,
    "clearing the title asks for one in a plain Title field",
  );
  await shot(t, "announcement-title-empty");
  t.assert(
    !(await t.has(`${CARD} [data-card-line]`)),
    "an untitled announcement's heading already says its kind and course",
  );
  await t.click("See what's left", { within: ACTIONS });
  t.assert(
    (await t.text('[data-testid="still-missing"]')).includes("Title"),
    "and an empty title can't be approved",
    await t.text('[data-testid="still-missing"]'),
  );
  t.assert(!(await t.has("[data-approve]")), "there is nothing to approve yet");
  await t.key("Escape");
  await t.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, "Escape closes the preview");
  await t.click('[aria-label="Title"]');
  await t.type(original);
  await t.click(BODY);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(HEADING)})?.innerText === ${JSON.stringify(original)} && !document.querySelector('[aria-label="Title"]')`,
    "a new title goes back to being the heading",
  );

  await t.click('[aria-label="Edit title"]');
  await t.type(" (edited)");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(HEADING)})?.innerText.endsWith("(edited)")`,
    "Enter commits the new title",
  );
  const renamed = await t.text(HEADING);
  t.assert(
    (await t.text("main header h1")) === renamed,
    "the crumb follows the rename",
    await t.text("main header h1"),
  );
  t.assert(
    await t.eval(
      `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR} a`)})].some((row) => row.getAttribute("title")?.includes(${JSON.stringify(renamed)}) || row.innerText.includes(${JSON.stringify(renamed)}))`,
    ),
    "and so does the sidebar row",
  );
  t.assert(
    (await t.text(`${CARD} [data-card-line]`)) === "Announcement to ENG 101",
    "a titled announcement's card says its kind and audience",
    await t.text(`${CARD} [data-card-line]`),
  );
  await t.click("Review before sending", { within: ACTIONS });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${PANEL} [data-field="post"]`)})?.innerText.includes("(edited)")`,
    "the edit shows in the preview",
  );
  t.assert(
    (await t.text('[data-testid="audience"]')).trim() ===
      `Posts to all ${course.students} ENG 101 students`,
    "the review says who it reaches",
    await t.text('[data-testid="audience"]'),
  );
  await shot(t, "announcement-review");
  await t.click("[data-approve]");
  await t.waitFor(`document.body.innerText.includes("Undo approval")`, "approved");
  await t.click("[data-card-edit]", { within: CARD });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(PANEL)}) && document.activeElement?.matches('[aria-label="Announcement"]')`,
    "Edit closes the preview and puts the cursor in the announcement",
  );
  await t.eval(`document.querySelector('[aria-label="Announcement"]').setSelectionRange(1e6, 1e6)`);
  await t.type(" Thanks.");
  await t.eval(`document.activeElement.blur()`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${CARD} [data-approval-reset]`)})`,
    "the card says the edit needs approval again",
  );
  await t.click("Review before sending", { within: ACTIONS });
  await t.waitFor(
    `document.querySelector("[data-approve]") && document.querySelector(${JSON.stringify(`${PANEL} [data-approval-reset]`)})`,
    "editing after approval resets it",
  );
  await shot(t, "announcement-reset");
  await t.click("[data-approve]");
  await t.waitFor(`document.body.innerText.includes("Undo approval")`, "approved again");
  await t.click("[data-card-edit]", { within: CARD });
  await t.click('[aria-label="Edit title"]');
  await t.type(" again");
  await t.key("Enter");
  await t.click("Review before sending", { within: ACTIONS });
  await t.waitFor(
    `document.querySelector("[data-approve]") && !document.body.innerText.includes("Undo approval") && document.querySelector(${JSON.stringify(`${PANEL} [data-field="post"]`)})?.innerText.includes("(edited) again")`,
    "a title edit after approval resets it and reaches the preview",
  );
  await t.click("[data-approve]");
  await t.waitFor(
    `document.body.innerText.includes("Undo approval")`,
    "approved after the title edit",
  );
  await t.click("Send to", { within: PANEL });
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]')`,
    "the announcement posts",
    15_000,
  );
  await t.click("See posted announcements");
  await t.waitFor(
    `document.querySelectorAll('[data-posted]').length === ${postedBefore + 1}`,
    "it appears in the posted list",
  );
  t.assert(
    (await t.text("[data-posted]")).includes("(edited)"),
    "at the top, with the edited title",
  );
  const newest = await lms(
    t,
    `lms.announcements.filter((a) => a.course === ${JSON.stringify(course.ref)}).sort((a, b) => b.postedAt.localeCompare(a.postedAt))[0].ref`,
  );
  t.assert(
    (await t.eval(`document.querySelector("[data-posted]").dataset.posted`)) === newest,
    "and it's the provider's own record",
  );
  t.assert(!(await t.has('[data-testid="announcement-drafts"]')), "nothing is left in drafts");
  await shot(t, "announcements-posted");

  await t.click("New announcement");
  await t.waitFor(
    `document.querySelector('[aria-label="Announcement"]')?.closest(${JSON.stringify(CARD)})`,
    "a second one starts a fresh draft",
    15_000,
  );
  await settled(t, "the second draft is done");
  const named = await t.text(HEADING);
  const longBody = await t.eval(`document.querySelector(${JSON.stringify(BODY)}).value`);
  await t.click("[data-composer]");
  await t.type("Make it shorter");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(BODY)}).value !== ${JSON.stringify(longBody)}`,
    "Make it shorter lands on the body",
    15_000,
  );
  await settled(t, "the correction is done");
  t.assert((await t.text(HEADING)) === named, "and leaves the title alone", await t.text(HEADING));
  await t.click("Posted announcements");
  await t.waitFor(
    `document.querySelector('[data-announcement-draft]')`,
    "the thread leads to the list, which shows the draft",
  );
  await t.click("[data-announcement-draft]");
  await t.waitFor(
    `document.querySelector('[aria-label="Announcement"]')?.closest(${JSON.stringify(CARD)})`,
    "the draft row opens it",
  );
  await t.click("Discard");
  await t.waitFor(
    `document.body.innerText.includes("Draft the announcement")`,
    "the draft can be discarded",
  );
  await t.click("Posted announcements");
  await t.waitFor(
    `document.querySelector('[data-testid="announcements-posted"]') && !document.querySelector('[data-announcement-draft]')`,
    "and it's gone from the list",
  );
};

const gradebook = async (t) => {
  await goTab(t, "ENG 101", "Gradebook");
  t.assert(
    (await count(t, '[data-testid="class-average"] [data-average]')) ===
      (await count(t, "[data-column]")),
    "every assignment has a class average",
  );
  t.assert(
    /ungraded/i.test(await t.text('[data-testid="gradebook-footnote"]')),
    "a footnote says what the totals leave out",
  );
  for (const mark of ["ungraded", "late", "missing", "resubmitted"])
    t.assert((await count(t, `[data-mark="${mark}"]`)) > 0, `a cell says ${mark} in words`);
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll("[data-mark]")].every((mark) => /[a-z]/.test(mark.innerText))`,
    )) === true,
    "each mark is more than a color",
  );
  const rr6 = await t.eval(
    `[...document.querySelectorAll("[data-column]")].findIndex((th) => th.innerText.includes("Reading Response 6"))`,
  );
  t.assert(rr6 >= 0, "Reading Response 6, past due, is a column");
  t.assert(
    await t.eval(
      `[...document.querySelectorAll("tr[data-student]")].every((row) => { const grade = row.querySelectorAll("td")[${rr6}].querySelector("[data-grade]"); return !grade || /\\d/.test(grade.innerText); })`,
    ),
    "past-due work with nothing turned in says missing, not a dash",
  );
  const everyone = await count(t, "tr[data-student]");
  for (const mark of ["missing", "late"]) {
    await t.click(`[data-filter="${mark}"]`);
    await t.waitFor(
      `(() => { const rows = [...document.querySelectorAll("tr[data-student]")]; return rows.length > 0 && rows.length < ${everyone} && rows.every((row) => row.querySelector('[data-mark="${mark}"]')); })()`,
      `the ${mark} filter shows only students with ${mark} work`,
    );
    if (mark === "missing") await shot(t, "gradebook-missing");
  }
  await t.click('[data-filter="all"]');
  await t.waitFor(
    `document.querySelectorAll("tr[data-student]").length === ${everyone}`,
    "Everyone shows the whole class again",
  );

  // ENG 101 has few enough assignments to fit at 1180 wide, so it takes a narrower window to make it scroll sideways.
  await t.viewport(860, 520);
  await t.waitFor(
    `(() => { const s = document.querySelector(${JSON.stringify(SCROLL)}); return s.scrollWidth > s.clientWidth && s.scrollHeight > s.clientHeight; })()`,
    "the table overflows inside its own scroller",
  );
  const corner = await t.box("[data-corner]");
  const column = await t.box("[data-column]");
  const first = await t.box("[data-first-col]");
  t.assert(
    await t.eval(
      `(() => { const row = document.querySelector("[data-student]"); const tops = [...row.querySelectorAll("[data-first-col], [data-grade], [data-total] span")].map((el) => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().top; }).slice(0, 2); return Math.abs(tops[0] - tops[1]) < 3; })()`,
    ),
    "a student's name lines up with their first grade",
  );
  await t.wheel(SCROLL, 300);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(SCROLL)}).scrollTop > 0`,
    "the table scrolls down",
  );
  await t.sleep(50);
  t.assert(
    (await t.box("[data-column]")).y === column.y,
    "the header row stays put scrolling down",
  );
  t.assert((await t.box("[data-corner]")).y === corner.y, "and so does the corner");
  t.assert((await t.box("[data-first-col]")).y < first.y, "while the rows move under it");
  await t.wheel(SCROLL, 0, 400);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(SCROLL)}).scrollLeft > 0`,
    "the table scrolls sideways",
  );
  await t.sleep(50);
  t.assert(
    (await t.box("[data-first-col]")).x === first.x,
    "the first column stays put scrolling sideways",
  );
  t.assert((await t.box("[data-column]")).x < column.x, "while the columns move under it");
  t.assert(
    (await t.eval(
      `document.documentElement.scrollWidth <= innerWidth && document.scrollingElement.scrollLeft === 0`,
    )) === true,
    "the page itself never scrolls sideways",
  );
  await shot(t, "gradebook-sticky-scrolled");
  await t.viewport(1440, 900);

  const luisCell = `[...document.querySelectorAll("tr[data-student]")].find((row) => row.innerText.includes("Luis Cardenas")).querySelector('[data-cell]:has([data-mark="resubmitted"])')`;
  const ref = await t.eval(`${luisCell}.dataset.cell`);
  const held = await lms(t, `lms.submissions.find((s) => s.ref === ${JSON.stringify(ref)}).grade`);
  t.assert(held !== null, "this submission already has a grade in the LMS", String(held));
  await t.click(`[data-cell="${ref}"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes("Luis Cardenas")`,
    "clicking a cell opens that submission in its grading thread",
    15_000,
  );
  await settled(t, "Luis's draft is done");
  t.assert(
    (await stored(
      t,
      `state.threads[${JSON.stringify(decodeURIComponent((await path(t)).split("/").pop()))}].kind`,
    )) === "grading",
    "and it is a grading thread",
  );
  await goTab(t, "ENG 101", "Gradebook");
  const pending = await t.eval(
    `document.querySelector(${JSON.stringify(`[data-cell="${ref}"] [data-pending]`)}).title`,
  );
  t.assert(
    /^\d+ pending approval$/.test(pending.trim()),
    "a pending change says its grade and its state, in its tooltip and to screen readers",
    pending,
  );
  t.assert(
    (await t.text(`[data-cell="${ref}"] [data-grade]`)).trim() === String(held),
    "beside the grade the LMS holds, not in place of it",
  );
  await shot(t, "gradebook-pending");

  await t.click(`[data-cell="${ref}"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes("Luis Cardenas")`,
    "the pending cell goes back to the draft",
  );
  await openPreview(t);
  await t.click("[data-approve]");
  await t.waitFor(`document.body.innerText.includes("Undo approval")`, "the grade is approved");
  await t.click("Send to", { within: PANEL });
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]')`,
    "the grade sends",
    15_000,
  );
  const written = await lms(
    t,
    `lms.submissions.find((s) => s.ref === ${JSON.stringify(ref)}).grade`,
  );
  await goTab(t, "ENG 101", "Gradebook");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`[data-cell="${ref}"] [data-grade]`)})?.innerText.trim() === ${JSON.stringify(String(written))}`,
    "once the sync after a send lands, the gradebook shows what the LMS now holds",
  );
  t.assert(
    !(await t.has(`[data-cell="${ref}"] [data-pending]`)),
    "and nothing is pending any more",
  );
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`[data-cell="${ref}"]`)}).dataset.target === "record"`,
    "the cell now leads to the record",
  );
  await shot(t, "gradebook-sent");
  await t.click(`[data-cell="${ref}"]`);
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]')`,
    "a sent cell opens the record of what was sent",
  );

  await goTab(t, "ENG 101", "Gradebook");
  await t.click("Total", { within: '[data-testid="gradebook"] thead' });
  const percents = await t.eval(
    `[...document.querySelectorAll("[data-total] span:first-child")].map((el) => parseInt(el.innerText, 10)).filter((n) => !Number.isNaN(n))`,
  );
  t.assert(
    percents.every((value, index) => index === 0 || percents[index - 1] >= value),
    "Total sorts highest first",
  );
  const firstColumn = await t.eval(`document.querySelector("[data-column] button").innerText`);
  await t.click("[data-column] button");
  await t.waitFor(
    `document.querySelector("[data-column] button").getAttribute("aria-pressed") === "true"`,
    "an assignment header sorts by that assignment",
    3000,
  );
  await t.click("Student", { within: '[data-testid="gradebook"] thead' });
  const names = await t.eval(
    `[...document.querySelectorAll("[data-first-col]")].map((el) => el.innerText)`,
  );
  t.assert(
    names.every((name, index) => index === 0 || names[index - 1].localeCompare(name) <= 0),
    "Student sorts by name",
  );
  await t.click("Title");
  const titles = await t.eval(
    `[...document.querySelectorAll("[data-column] button")].map((b) => b.innerText)`,
  );
  t.assert(
    titles.every((title, index) => index === 0 || titles[index - 1].localeCompare(title) <= 0) &&
      titles.includes(firstColumn),
    "assignments can sort by title too",
  );

  const ungraded = await t.eval(
    `document.querySelector('[data-cell]:has([data-mark="ungraded"])').dataset.cell`,
  );
  await t.click(`[data-cell="${ungraded}"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})`,
    "an ungraded cell opens its draft",
    15_000,
  );
  await settled(t, "the ungraded draft is done");
  await goTab(t, "ENG 101", "Gradebook");
  const marks = await t.eval(
    `[...document.querySelectorAll('[data-cell="${ungraded}"] [data-mark], [data-cell="${ungraded}"] [data-pending]')].map((el) => el.innerText.trim())`,
  );
  t.assert(
    (await t.has(`[data-cell="${ungraded}"] [data-pending]`)) &&
      !(await t.has(`[data-cell="${ungraded}"] [data-mark="ungraded"]`)),
    "a drafted cell shows its pending grade and not ungraded too",
    marks.join(" | "),
  );
  await shot(t, "gradebook-drafted");
};

const overview = async (t) => {
  await goCourse(t, "ENG 101");
  const details = await t.text('[data-testid="course-details"]');
  t.assert(
    details.length > 0 && (await t.has('[data-testid="sync-age"]')),
    "the header shows section, modality, host, and sync age",
    details,
  );
  for (const name of ["needs-you", "assignments", "threads", "announcements", "messages", "roster"])
    t.assert(await t.has(`[data-section="${name}"]`), `the ${name} section is there`);
  for (const name of ["to-grade", "due-this-week", "unread", "average"])
    t.assert(await t.has(`[data-stat="${name}"]`), `the ${name} stat is there`);
  const course = await lms(t, `lms.courses.find((c) => c.code === "ENG 101").ref`);
  const toGrade = await lms(
    t,
    `lms.submissions.filter((s) => s.course === ${JSON.stringify(course)} && s.workflow === "submitted").length`,
  );
  t.assert(
    (await t.text('[data-stat="to-grade"]')).includes(String(toGrade)),
    "To grade matches the LMS",
    String(toGrade),
  );
  t.assert(
    (await count(t, "[data-roster]")) ===
      (await lms(t, `lms.students.filter((s) => s.course === ${JSON.stringify(course)}).length`)),
    "every student is on the roster",
  );
  t.assert((await count(t, "[data-missing-flag]")) > 0, "missing work is flagged on the roster");
  await t.click("[data-sort-behind]");
  await t.waitFor(
    `(() => { const rows = [...document.querySelectorAll("[data-roster]")].map((row) => Number(row.querySelector("[data-missing-flag]")?.innerText.match(/\\d+/)?.[0] ?? 0)); return rows[0] > 0 && rows.every((n, i) => i === 0 || rows[i - 1] >= n); })()`,
    "Behind first puts the students with the most missing work at the top",
  );
  await t.eval(`document.querySelector('[data-section="roster"]').scrollIntoView()`);
  await shot(t, "roster-behind");
  await t.click("[data-sort-behind]");
  await pageFits(t, "overview at 1440");
  await shot(t, "overview");

  await t.click("[data-course-assignment]");
  await t.waitFor(
    `location.pathname.startsWith("/threads/") && document.querySelector('[data-testid="pinned-queue"]')`,
    "an assignment leads to its thread",
  );
  await goCourse(t, "ENG 101");
  await t.click("[data-roster]");
  await t.waitFor(
    `document.querySelector('[data-highlighted="true"]')`,
    "a student leads to their row in the gradebook",
  );
  await goCourse(t, "ENG 101");
  await t.click("[data-course-announcement]");
  await t.waitFor(
    `location.pathname.endsWith("/announcements")`,
    "an announcement leads to the list",
  );
  await goCourse(t, "ENG 101");
  await t.click("[data-course-message]");
  await t.waitFor(
    `location.pathname === "/inbox" && document.querySelector('[data-testid="conversation-header"]')`,
    "a message opens in the inbox",
  );
  await settled(t, "the inbox is quiet");
  await goCourse(t, "ENG 101");
  await t.click("[data-course-thread]");
  await t.waitFor(
    `location.pathname.startsWith("/threads/")`,
    "a thread opens from the course page",
  );
  await goCourse(t, "ENG 101");
  await t.click("New thread", { within: '[data-section="threads"]' });
  await t.waitFor(
    `document.body.innerText.includes("New thread in ENG 101") && location.pathname.startsWith("/threads/")`,
    "New thread starts one in this course",
  );
  await goCourse(t, "ENG 101");

  await t.eval(threeHoursBack);
  await t.reload();
  await t.waitFor(
    `document.querySelector('[data-testid="sync-age"]')?.dataset.stale === "true"`,
    "stale data says so",
  );
  t.assert(
    /hours? ago/.test(await t.text('[data-testid="sync-age"]')),
    "and gives its age",
    await t.text('[data-testid="sync-age"]'),
  );
  await t.click("Sync now", { within: '[data-testid="sync-line"]' });
  await t.waitFor(
    `document.querySelector('[data-testid="sync-age"]')?.dataset.stale === "false" && document.querySelector('[data-testid="sync-age"]').innerText.includes("just now")`,
    "Sync now brings it up to date",
    15_000,
  );

  const roster = await count(t, "[data-roster]");
  await t.eval(`window.__faultLab.setNoise({ rate5xx: 1 })`);
  await t.click("Sync now", { within: '[data-testid="sync-line"]' });
  await t.waitFor(
    `document.querySelector('[data-testid="sync-failed"]')`,
    "a failed sync says so",
    15_000,
  );
  t.assert(
    (await t.text('[data-testid="sync-failed"]')).includes("Showing data from"),
    "and says the data is the old data",
  );
  t.assert((await count(t, "[data-roster]")) === roster, "the old data stays on screen");
  await shot(t, "failed-sync");
  await t.eval(`window.__faultLab.setNoise({ rate5xx: 0 })`);
  await t.click("Sync now", { within: '[data-testid="sync-line"]' });
  await t.waitFor(
    `document.querySelector('[data-testid="sync-age"]')`,
    "the next good sync clears the failure",
    15_000,
  );
};

const palette = async (t) => {
  await t.click("Search threads and students", { within: SIDEBAR });
  await t.waitFor(`document.querySelector('[data-testid="palette"]')`, "the palette opens");
  await t.type("eng 101 gradebook");
  await t.waitFor(
    `document.querySelector('[data-testid="palette"]').innerText.includes("ENG 101 gradebook")`,
    "it finds a course's gradebook",
  );
  await t.key("Enter");
  await t.waitFor(`location.pathname.endsWith("/gradebook")`, "and goes there");

  await t.eval(threeHoursBack);
  await t.reload();
  await t.waitFor(
    `document.querySelector('[data-testid="sync-age"]')?.dataset.stale === "true"`,
    "the gradebook's data is stale before a palette sync",
  );
  await t.click("Search threads and students", { within: SIDEBAR });
  await t.waitFor(`document.querySelector('[data-testid="palette"]')`, "the palette opens again");
  await t.type("sync");
  await t.waitFor(
    `[...document.querySelectorAll('[data-testid="palette"] button')][0]?.innerText.includes("Sync Lakeshore Community College")`,
    "sync lists a Sync row per connected school, this course's school first",
  );
  await shot(t, "palette-sync");
  await t.key("Enter");
  await t.waitFor(
    `!document.querySelector('[data-testid="palette"]') && document.querySelector('[data-testid="sync-age"]')?.dataset.stale === "false" && document.querySelector('[data-testid="sync-age"]').innerText.includes("just now")`,
    "Enter syncs the school, and the course header says just now",
    15_000,
  );

  await t.click("Search threads and students", { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector('[data-testid="palette"]')`,
    "the palette opens once more",
  );
  await t.type("approve");
  await t.waitFor(
    `[...document.querySelectorAll('[data-testid="palette"] button')].every((row) => row.innerText.includes(", to approve")) && document.querySelector('[data-testid="palette"] button')`,
    "approve lists the threads awaiting approval",
  );
  await shot(t, "palette-approve");
  await t.key("Enter");
  await t.waitFor(
    `location.pathname.startsWith("/threads/")`,
    "Enter opens the thread; the palette approves nothing",
  );
};

const layouts = async (t) => {
  const course = encodeURIComponent(
    await lms(t, `lms.courses.find((c) => c.code === "ENG 101").ref`),
  );
  for (const [width, height] of [
    [1440, 900],
    [1180, 800],
  ]) {
    await t.viewport(width, height);
    for (const [name, route, ready] of [
      ["due", "/due", '[data-testid="due-list"]'],
      ["inbox", "/inbox", LIST],
      ["calendar", "/calendar", CALENDAR],
      ["overview", `/courses/${course}`, '[data-testid="course-overview"]'],
      ["gradebook", `/courses/${course}/gradebook`, SCROLL],
      ["announcements", `/courses/${course}/announcements`, '[data-testid="announcements"]'],
    ]) {
      await t.goto(route);
      await t.waitFor(
        `document.querySelector(${JSON.stringify(ready)})`,
        `${name} at ${width}: loaded`,
      );
      await pageFits(t, `${name} at ${width}`);
      t.assert((await t.box(ready)).width > 300, `${name} at ${width}: the content has room`);
    }
    await t.goto("/inbox");
    await t.waitFor(`document.querySelector(${JSON.stringify(LIST)})`, `inbox at ${width}: loaded`);
    await t.click('[data-conversation][data-unread="true"] button');
    await t.waitFor(
      `document.querySelector(${JSON.stringify(CARD)})`,
      `inbox at ${width}: a conversation drafts`,
      15_000,
    );
    await settled(t, `inbox at ${width}: quiet`);
    t.assert(
      (await t.box('[data-testid="thread-main"]')).width >= 440,
      `inbox at ${width}: the conversation has a usable column`,
    );
    await t.click("Review before sending", { within: ACTIONS });
    await t.waitFor(
      `document.querySelector(${JSON.stringify(`${PANEL} [data-field]`)})`,
      `inbox at ${width}: the panel opens`,
    );
    await panelSettled(t);
    const panel = await t.box(PANEL);
    const main = await t.box('[data-testid="thread-main"]');
    t.assert(
      panel.x >= main.x + main.width - 1 && panel.x + panel.width <= width + 1,
      `inbox at ${width}: the preview sits beside the conversation`,
    );
    t.assert(main.width >= 440, `inbox at ${width}: the conversation keeps a usable column`);
    t.assert(
      (await t.box(`${CARD}[data-previewing]`)).height <= 34,
      `inbox at ${width}: the card is one line while the preview is open`,
    );
    for (const [what, query] of [
      ["the card", `${CARD}[data-previewing]`],
      ["the composer", "[data-composer]"],
    ]) {
      t.assert(
        await t.eval(
          `(() => { const el = document.querySelector(${JSON.stringify(query)}); const r = el.getBoundingClientRect(); return r.width > 200 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 12))); })()`,
        ),
        `inbox at ${width}: ${what} stays in view with the preview open`,
      );
    }
    t.assert(
      (await t.box('[data-testid="inbox-list"]')).width === (width === 1180 ? 0 : 320),
      width === 1180
        ? "inbox at 1180: the list steps aside while the preview is open"
        : `inbox at ${width}: the list stays beside the preview`,
    );
    await pageFits(t, `inbox with panel at ${width}`);
    if (width === 1180) {
      await shot(t, "inbox-1180");
      await t.viewport(880, 800);
      await t.waitFor(
        `getComputedStyle(document.querySelector("[data-scrim]")).display === "block"`,
        "below 900 the inbox preview sits over a scrim",
      );
      await panelSettled(t);
      t.assert(
        await t.eval(
          `getComputedStyle(document.querySelector(${JSON.stringify(PANEL)})).boxShadow !== "none"`,
        ),
        "the overlay has a shadow",
      );
      const scrim = await t.box("[data-scrim]");
      await t.cdp("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: scrim.x + 8,
        y: scrim.y + 200,
        button: "left",
        clickCount: 1,
      });
      await t.cdp("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: scrim.x + 8,
        y: scrim.y + 200,
        button: "left",
        clickCount: 1,
      });
      await t.waitFor(
        `!document.querySelector(${JSON.stringify(PANEL)})`,
        "clicking the scrim closes the preview",
      );
      await t.click("Review before sending", { within: ACTIONS });
      await t.waitFor(
        `document.querySelector(${JSON.stringify(`${PANEL} [data-field]`)})`,
        "the preview opens again",
      );
      await panelSettled(t);
      t.assert(
        await t.eval(`document.querySelector('[data-testid="thread-main"]').inert`),
        "the conversation behind the scrim can't take keyboard focus",
      );
      t.assert(
        await t.eval(
          `document.querySelector(${JSON.stringify(PANEL)}).contains(document.activeElement)`,
        ),
        "focus moves into the panel that covers it",
      );
      await t.key("j");
      t.assert(
        !(await t.has('[data-cursor="true"]')),
        "the queue keys don't move a cursor behind the scrim",
      );
      await t.key("/");
      t.assert(
        !(await t.eval(`document.activeElement?.hasAttribute("data-composer")`)),
        "the composer key doesn't reach behind the scrim",
      );
      await t.viewport(1180, 800);
    }
    await t.click("Close preview", { within: PANEL });
    await t.waitFor(
      `!document.querySelector(${JSON.stringify(PANEL)})`,
      `inbox at ${width}: the panel closes`,
    );
  }
  await t.goto(`/courses/${course}`);
  await t.waitFor(
    `document.querySelector('[data-testid="course-overview"]')`,
    "overview at 1180: loaded again",
  );
  await shot(t, "overview-1180");
  await t.viewport(1440, 900);
};

export const run = async (t) => {
  await clearOwnShots(t);
  await setup(t);
  await batchAndTimeline(t);
  await whatsDue(t);
  await calendar(t);
  await gradableAgrees(t);
  await inbox(t);
  await announcements(t);
  await gradebook(t);
  await overview(t);
  await palette(t);
  await layouts(t);
  await dueReplies(t);
};
