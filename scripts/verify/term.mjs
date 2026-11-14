import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { addAiKey } from "./ai-key.mjs";
import { assertTemplateEdge, STANDARD_EDGE } from "./followups.mjs";
import { onboard } from "./onboard.mjs";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const id = (name) => `[data-testid="${name}"]`;
const WAIT = 25_000;

let shots = 0;
const shot = (t, name) => t.shot(`term-${String(++shots).padStart(2, "0")}-${name}`, null);

const clearOwnShots = async (t) => {
  for (const file of await readdir(t.shots))
    if (file.startsWith("term-")) await rm(join(t.shots, file));
};

const lms = (t, expression) =>
  t.eval(
    `(async () => { const lms = JSON.parse(await window.__faultLab.stored()); return ${expression}; })()`,
  );
const count = (t, selector) =>
  t.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const enabled = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && !el.disabled; })()`;
const writesTo = (t) => lms(t, "lms.writeLog.length");
const migrationsFor = (t, code) =>
  lms(
    t,
    `lms.term.migrations.filter((m) => m.course_id === lms.term.shells.find((s) => s.code === ${JSON.stringify(code)}).canvasId).length`,
  );
const isPublished = (t, code) =>
  lms(
    t,
    `lms.term.shells.find((s) => s.code === ${JSON.stringify(code)}).workflow_state === "available"`,
  );

const setField = (t, selector, value) =>
  t.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);

/** The desktop app's own path: main's picker, answered through verify's stand-in for the native dialog. */
const pickPackage = async (t, file) => {
  await t.pickPackage(file && `${FIXTURES}${file}`);
  await t.click(id("cartridge-pick"));
};
const value = (t, testId) => t.eval(`document.querySelector(${JSON.stringify(id(testId))}).value`);

const setup = async (t) => {
  await t.viewport(1440, 900);
  await t.goto("/welcome");
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await t.reload();
  await onboard(t);
  await t.waitFor(`location.pathname === "/due"`, "demo tokens land on What's due");
  await addAiKey(t);
};

const offerSelector = async (t, code, surface = "sidebar") => {
  if (surface === "sidebar") {
    const folded = await t.eval(
      `[...document.querySelectorAll('[data-testid="setup-offers-toggle"][aria-expanded="false"]')].map((row) => row.dataset.offersSchool)`,
    );
    for (const school of folded)
      await t.click(`[data-testid="setup-offers-toggle"][data-offers-school="${school}"]`);
  }
  const ref = await t.eval(
    `[...document.querySelectorAll('[data-testid="setup-offer"][data-surface="${surface}"]')].find((el) => el.innerText.includes(${JSON.stringify(code)}))?.dataset.course ?? null`,
  );
  t.assert(ref !== null, `${code}: the ${surface} shows an offer`);
  return `[data-testid="setup-offer"][data-surface="${surface}"][data-course="${ref}"]`;
};

const openOffer = async (t, code) => {
  await t.click(`${await offerSelector(t, code)} button`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("setup-rail"))})`,
    `${code}: the setup thread opens with its rail`,
  );
};

const rail = (t, step) =>
  t.eval(`document.querySelector(${JSON.stringify(id(`setup-step-${step}`))})?.dataset.state`);

const heights = (t, selector) =>
  t.eval(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.getBoundingClientRect().height)`,
  );

const assertDatesSpacing = async (t) => {
  t.assert(
    (await heights(t, `${id("dates-card")} input`)).every((height) => height === 36),
    "dates: every input is 36px tall",
  );
  t.assert(
    (await heights(t, `[data-testid^="day-new-"]`)).every((height) => height === 32),
    "dates: day toggles are 32px",
  );
  t.assert(
    (await t.eval(
      `getComputedStyle(document.querySelector(${JSON.stringify(id("day-new-0"))}).parentElement).columnGap`,
    )) === "4px",
    "dates: day toggles sit 4px apart",
  );
  t.assert(
    (await heights(t, id("shift-row"))).every((height) => height >= 36),
    "dates: shift table rows are at least 36px",
  );
};

const assertReviewSpacing = async (t) => {
  t.assert((await count(t, id("finding-list"))) === 1, "review: findings are one grouped list");
  t.assert(
    (await heights(t, `${id("finding-row")} > [data-row-hit]`)).every((height) => height === 36),
    "review: finding rows are 36px",
  );
  const lefts = await t.eval(
    `[...document.querySelectorAll('${id("finding-row")} > [data-row-hit] > button')].map((el) => el.getBoundingClientRect().left)`,
  );
  t.assert(new Set(lefts).size === 1, "review: chevrons line up with and without a checkbox");
  t.assert(
    (await t.eval(
      `[...document.querySelector(${JSON.stringify(id("batch-bar"))}).parentElement.querySelectorAll('*')].filter((el) => getComputedStyle(el).position === "sticky").length`,
    )) === 1,
    "review: there is one sticky action bar in the review card",
  );
  const clear = await t.eval(
    `document.querySelector("textarea[data-composer]").parentElement.getBoundingClientRect().top - document.querySelector(${JSON.stringify(id("batch-bar"))}).getBoundingClientRect().bottom`,
  );
  t.assert(clear >= 16, "review: the action bar stays 16px clear of the composer", String(clear));
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(id("work-log"))})?.open`)) === false,
    "review: the tool log starts collapsed",
  );
};

// The review note named this screen, so it gets measured here as well as wherever the button actually renders.
const assertReviewScreenEdge = async (t) => {
  const { width, height } = t.size;
  for (const [w, h] of [
    [width, height],
    [1180, 800],
  ]) {
    await t.viewport(w, h);
    await t.sleep(120);
    t.assert(
      !(await t.has(id("save-template"))),
      `term-08 at ${w}: Save as template is not on this screen, the course isn't published yet`,
    );
    const inset = await t.eval(
      `Math.min(...[...document.querySelectorAll('${id("screen-header")} button')].map((el) => innerWidth - el.getBoundingClientRect().right))`,
    );
    t.assert(
      inset >= STANDARD_EDGE,
      `term-08 at ${w}: the header's last control sits ${inset}px from the window edge, at least ${STANDARD_EDGE}`,
    );
  }
  await t.viewport(width, height);
  await t.sleep(120);
};

const addBreak = async (t) => {
  await t.click(id("add-break"));
  await setField(t, `${id("break-row")} input:nth-of-type(1)`, "Spring break");
  await t.waitFor(
    `document.querySelectorAll('${id("break-row")} input[type="date"]').length === 2`,
    "the break row has start and end",
  );
  await t.eval(`(() => {
    const [start, end] = document.querySelectorAll('${id("break-row")} input[type="date"]');
    const set = (el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    set(start, "2027-03-08");
    set(end, "2027-03-12");
  })()`);
};

const fillOldTerm = async (t, name, start, end) => {
  await setField(t, id("old-term-name"), name);
  await setField(t, id("old-term-start"), start);
  await setField(t, id("old-term-end"), end);
};

const pickDaysIfBlank = async (t, side, days) => {
  for (const day of days) {
    if (
      (await t.eval(
        `document.querySelector(${JSON.stringify(id(`day-${side}-${day}`))}).getAttribute("aria-pressed")`,
      )) !== "true"
    )
      await t.click(id(`day-${side}-${day}`));
  }
};

// In a window too short for the card, Approve stays on screen while the card scrolls under it.
const assertFooterPins = async (t, code) => {
  const { width, height } = t.size;
  await t.viewport(1180, 420);
  await t.sleep(150);
  const footer = `${id("copy-card")} [data-action-bar]`;
  await t.eval(
    `void document.querySelector(${JSON.stringify(id("copy-card"))}).scrollIntoView({ block: "start" })`,
  );
  await t.sleep(100);
  const place = await t.eval(
    `(() => { const card = document.querySelector(${JSON.stringify(id("copy-card"))}); let scroller = card; while (!/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement; return { footerBottom: document.querySelector(${JSON.stringify(footer)}).getBoundingClientRect().bottom, cardBottom: card.getBoundingClientRect().bottom, scrollerBottom: scroller.getBoundingClientRect().bottom }; })()`,
  );
  t.assert(
    place.footerBottom <= place.scrollerBottom + 1 && place.cardBottom > place.scrollerBottom,
    `${code}: the card's footer pins on screen while the card runs past it`,
    JSON.stringify(place),
  );
  await t.viewport(width, height);
  await t.sleep(150);
};

const approveCopy = async (t, code, earlier = 0) => {
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("copy-card"))})`,
    `${code}: the copy shows as a change to approve`,
    WAIT,
  );
  t.assert(!(await t.eval(enabled(id("copy-send")))), `${code}: Send stays off until Approve`);
  t.assert(
    (await migrationsFor(t, code)) === earlier,
    `${code}: no new migration exists before approval`,
  );
  await assertFooterPins(t, code);
  await t.click(id("copy-approve"));
  await t.waitFor(enabled(id("copy-send")), `${code}: approving turns Send on`);
  t.assert((await migrationsFor(t, code)) === earlier, `${code}: approval alone starts nothing`);
};

const waitReview = async (t, code) => {
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("finding-row"))})`,
    `${code}: the scan lists findings`,
    WAIT,
  );
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("setup-step-5"))})?.dataset.state === "current"`,
    `${code}: the rail reaches Review`,
  );
};

const openRow = async (t, status) => {
  const key = await t.eval(
    `document.querySelector('${id("finding-row")}[data-status="${status}"]')?.dataset.findingKey ?? null`,
  );
  if (key === null) return null;
  const row = `${id("finding-row")}[data-finding-key="${key}"]`;
  if (!(await t.has(`${row} button[aria-expanded="true"]`)))
    await t.click(`${row} button[aria-expanded]`);
  return row;
};

const editFix = async (t, row, text) => {
  await t.click(`${row} ${id("finding-edit")}`);
  await setField(t, `${row} ${id("finding-edit-text")}`, text);
  await t.click(`${row} ${id("finding-edit-save")}`);
};

const statementEdits = async (t, code) => {
  const key = await t.eval(
    `document.querySelector('${id("finding-group-missing-statement")} ${id("finding-row")}[data-status="fix"]')?.dataset.findingKey ?? null`,
  );
  t.assert(key !== null, `${code}: a missing statement has a fix`);
  const row = `${id("finding-row")}[data-finding-key="${key}"]`;
  const showsAlone = (text) =>
    t.eval(
      `[...document.querySelector(${JSON.stringify(row)}).querySelectorAll("p")].some((p) => p.innerText.trim() === ${JSON.stringify(text)})`,
    );
  await t.click(`${row} button[aria-expanded]`);
  await t.click(`${row} ${id("finding-approve")}`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(row)})?.innerText.includes("Ready to send")`,
    `${code}: the statement fix approves`,
  );
  await t.click(`${row} ${id("finding-edit")}`);
  t.assert(
    (await t.eval(
      `!document.querySelector(${JSON.stringify(`${row} ${id("finding-edit-text")}`)}).value.startsWith("\\n")`,
    )) === true,
    `${code}: the edit box opens on the statement's words, not a paragraph break`,
  );
  const words = "Title IX: contact the Title IX office at titleix@riverbend.edu.";
  await setField(t, `${row} ${id("finding-edit-text")}`, words);
  await t.click(`${row} ${id("finding-edit-save")}`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(row)})?.innerText.includes("Needs approval again")`,
    `${code}: editing the approved statement resets its approval`,
  );
  t.assert(
    await showsAlone(words),
    `${code}: the edited statement previews as its own paragraph`,
    await t.text(row),
  );
  await t.eval(`document.querySelector('${id("run-check")}').scrollIntoView({ block: "end" })`);
  await shot(t, "review-statement-edited");

  await editFix(t, row, "  ");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(`${row} ${id("finding-approve")}`)})`,
    `${code}: a fix with its text cleared can't be approved`,
  );
  t.assert(
    (await t.text(row)).includes("In progress"),
    `${code}: a fix with blank text reads as in progress`,
    await t.text(row),
  );
  await t.eval(`document.querySelector('${id("run-check")}').scrollIntoView({ block: "end" })`);
  await shot(t, "review-blank-fix-blocked");

  await editFix(t, row, words);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${row} ${id("finding-approve")}`)})`,
    `${code}: refilled text can be approved again`,
  );
};

const openInLms = async (t, code) => {
  const row = await openRow(t, "manual");
  t.assert(row !== null, `${code}: a finding is marked do this by hand`);
  const open = `${row} ${id("finding-open")}`;
  const link = await t.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(open)});
    return el && { tag: el.tagName, href: el.href, target: el.target, rel: el.rel };
  })()`);
  t.assert(
    link?.tag === "A" && /^https:\/\/.+\/courses\/\d+\//.test(link.href),
    `${code}: Open in the LMS is a link to the finding's place in the LMS`,
    JSON.stringify(link),
  );
  t.assert(
    link.target === "_blank" && link.rel.includes("noreferrer"),
    `${code}: Open in the LMS opens a new tab`,
    JSON.stringify(link),
  );
  await t.eval(
    `document.querySelector(${JSON.stringify(open)}).scrollIntoView({ block: "center" })`,
  );
  await shot(t, "review-open-in-lms");
};

const clearManual = async (t, code) => {
  let handled = 0;
  for (let tries = 0; tries < 60; tries++) {
    const row = await openRow(t, "manual");
    if (!row) break;
    await t.click(`${row} ${id("finding-handled")}`);
    await t.waitFor(
      `document.querySelector(${JSON.stringify(row)})?.dataset.status !== "manual"`,
      `${code}: "I handled it" clears a manual finding`,
    );
    handled++;
  }
  return handled;
};

const fixRest = async (t, code) => {
  for (let round = 0; round < 6; round++) {
    await t.waitFor(
      `!document.querySelector('[data-testid="agent-working"]')`,
      `${code}: nothing is running before the next batch`,
    );
    const left = await t.eval(
      `[...document.querySelectorAll('${id("finding-toggle")}')].filter((box) => !box.disabled).length`,
    );
    if (left === 0) break;
    if ((await t.text(id("batch-select-all"))).startsWith("Select all"))
      await t.click(id("batch-select-all"));
    await t.waitFor(
      `document.querySelector('${id("finding-toggle")}:checked')`,
      `${code}: Select all ticks the rows`,
    );
    if (await t.eval(enabled(id("batch-approve")))) await t.click(id("batch-approve"));
    await t.waitFor(enabled(id("batch-send")), `${code}: batch approval turns Send on`);
    await t.click(id("batch-send"));
    await t.waitFor(
      `document.querySelector(${JSON.stringify(id("batch-outcome"))})?.innerText && !document.querySelector(${JSON.stringify(id("batch-outcome"))}).innerText.startsWith("Sending")`,
      `${code}: the batch reports an outcome`,
      60_000,
    );
    await t.waitFor(
      `!document.querySelector('[data-status="checking"]')`,
      `${code}: the rescan settles every sent fix`,
      60_000,
    );
    await t.sleep(400);
  }
};

const publish = async (t, code) => {
  await t.click(id("run-check"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("readiness"))})`,
    `${code}: the publish check runs`,
    WAIT,
  );
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("prepare-publish"))})`,
    `${code}: the check passes with nothing left`,
    WAIT,
  );
  t.assert(!(await isPublished(t, code)), `${code}: still unpublished before the publish step`);
  await t.click(id("prepare-publish"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("publish-card"))})`,
    `${code}: Publish course shows as a change to approve`,
  );
  t.assert(
    !(await t.eval(enabled(id("publish-send")))),
    `${code}: Publish course stays off until Approve`,
  );
  await t.click(id("publish-approve"));
  await t.waitFor(enabled(id("publish-send")), `${code}: approving turns Publish course on`);
  await t.click(id("publish-send"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("published-card"))})`,
    `${code}: the thread says it is published`,
    WAIT,
  );
  t.assert(await isPublished(t, code), `${code}: the fake LMS holds it as published`);
  t.assert((await rail(t, 6)) === "complete", `${code}: the rail ticks Publish check`);
  t.assert(
    (await rail(t, 7)) === "upcoming",
    `${code}: End of term waits for the term to end`,
    await rail(t, 7),
  );
  const card = await t.text(id("published-card"));
  t.assert(
    / sent\b/.test(card) && !card.includes("approval"),
    `${code}: the published card says what was sent`,
    card,
  );
  t.assert(
    !(await t.has(`${id("published-card")} ${id("save-template")}`)),
    `${code}: the published card offers no end-of-term template`,
  );
  // The card shows before the send's sync lands. The sync adds the course row above the other offers, so a click aimed before it lands misses.
  await t.waitFor(
    `![...document.querySelectorAll('${id("setup-offer")}[data-surface="sidebar"]')].some((el) => el.innerText.includes(${JSON.stringify(code)}))`,
    `${code}: once the sync lands, the published course leaves the setup offers`,
    WAIT,
  );
};

const until = async (t, expression, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await t.eval(`Boolean(${expression})`)) return true;
    await t.sleep(40);
  }
  return false;
};

const approveAndSendRightAfterTicking = async (t, code, approved, ticked) => {
  const writes = await writesTo(t);
  const clicks = await t.clickAtOnce([`${ticked} ${id("finding-toggle")}`, id("batch-approve")]);
  t.assert(
    clicks.length === 2 && clicks[1].gapMs < 150,
    `${code}: tick then Approve landed ${clicks[1]?.gapMs ?? "?"}ms apart`,
    JSON.stringify(clicks),
  );
  t.assert(
    clicks[1]?.label === "Approve 1",
    `${code}: the button said Approve 1 when it was clicked`,
    JSON.stringify(clicks),
  );
  t.assert(
    await until(
      t,
      `document.querySelector(${JSON.stringify(ticked)})?.innerText.includes("Ready to send")`,
    ),
    `${code}: Approve right after ticking approves the row just ticked`,
  );
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('${id("finding-row")}')].filter((el) => el.innerText.includes("Ready to send")).length`,
    )) === 2,
    `${code}: nothing else was approved by that click`,
  );
  const sendClicks = await t.clickAtOnce([`${approved} ${id("finding-toggle")}`, id("batch-send")]);
  t.assert(
    sendClicks[1]?.label === "Send 2 approved",
    `${code}: the button said Send 2 approved when it was clicked`,
    JSON.stringify(sendClicks),
  );
  t.assert(
    sendClicks.length === 2 && sendClicks[1].gapMs < 150,
    `${code}: tick then Send landed ${sendClicks[1]?.gapMs ?? "?"}ms apart`,
    JSON.stringify(sendClicks),
  );
  t.assert(
    await until(
      t,
      `(async () => ${writes} + 2 === JSON.parse(await window.__faultLab.stored()).writeLog.length)()`,
      8000,
    ),
    `${code}: Send right after ticking sends both ticked rows and no others`,
    `${writes} then ${await writesTo(t)}`,
  );
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("batch-outcome"))})?.innerText && !document.querySelector(${JSON.stringify(id("batch-outcome"))}).innerText.startsWith("Sending")`,
    `${code}: that send reports an outcome`,
    60_000,
  );
};

const cancelBeforeCopy = async (t) => {
  const code = "ENG 101";
  await t.click("What's due");
  const offer = await offerSelector(t, code, "due");
  await t.click(`${offer} button:not([aria-label])`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("source-card"))})`,
    `${code}: Set up this course opens the source step`,
  );
  await t.click("What's due");
  await t.waitFor(`location.pathname === "/due"`, "What's due opens");
  const banner = await t.text(id("offer-banner"));
  t.assert(banner.includes("4 new courses"), "a started setup still counts on What's due", banner);
  const row = await t.text(offer);
  t.assert(
    row.includes("Choosing a source") &&
      row.includes("Continue setup") &&
      row.includes("Cancel setup"),
    `${code}: its What's due row says how far it got and offers Continue and Cancel`,
    row,
  );
  await t.eval(
    `void document.querySelector(${JSON.stringify(offer)}).scrollIntoView({ block: "center" })`,
  );
  await shot(t, "started-setup-on-due");
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
  ]) {
    await t.viewport(width, height);
    const center = `void document.querySelector(${JSON.stringify(offer)}).scrollIntoView({ block: "center" })`;
    await t.click(`${offer} button:not([aria-label])`);
    await t.waitFor(
      `document.querySelector(${JSON.stringify(id("source-card"))})`,
      `${code}: the setup opens at its source step`,
    );
    const thread = await t.eval("location.pathname");
    await t.click("What's due");
    await t.waitFor(`location.pathname === "/due"`, "What's due opens");
    await t.click("Cancel setup", { within: offer });
    await t.waitFor(
      `document.querySelector(${JSON.stringify(offer)})?.innerText.includes("Set up this course")`,
      `${code}: Cancel setup offers the course again`,
    );
    t.assert(
      !(await t.eval(
        `[...document.querySelectorAll('[data-testid="setup-offer"][data-surface="sidebar"]')].some((el) => el.innerText.includes("Choosing a source"))`,
      )),
      `${code}: the sidebar no longer shows it as started`,
    );
    const toast = await t.text(id("undo-toast"));
    t.assert(
      toast.includes(`Cancelled setup of ${code}`) && toast.includes("Undo"),
      `${code}: a toast offers to undo the cancel`,
      toast,
    );
    await t.eval(center);
    await shot(t, `setup-cancelled-${width}`);
    await t.click("Undo", { within: id("undo-toast") });
    await t.waitFor(
      `document.querySelector(${JSON.stringify(offer)})?.innerText.includes("Continue setup")`,
      `${code}: Undo puts the started setup back on What's due`,
    );
    t.assert(
      (await t.text(offer)).includes("Choosing a source"),
      `${code}: the undone setup is where it was`,
    );
    await t.eval(center);
    await shot(t, `setup-undone-${width}`);
    await t.eval("history.back()");
    await t.waitFor(
      `location.pathname === ${JSON.stringify(thread)} && document.querySelector(${JSON.stringify(id("source-card"))})`,
      `${code}: Back after Undo opens the setup thread at its source step`,
    );
    await shot(t, `back-after-undo-${width}`);
    await t.click("What's due");
    await t.waitFor(`location.pathname === "/due"`, "What's due opens");
    await t.click("Cancel setup", { within: offer });
    await t.waitFor(
      `document.querySelector(${JSON.stringify(offer)})?.innerText.includes("Set up this course")`,
      `${code}: Cancel setup offers the course again`,
    );
    await t.eval("history.back()");
    await t.waitFor(
      `!["/due", ${JSON.stringify(thread)}].includes(location.pathname)`,
      `${code}: Back after a cancel does not land on the cancelled thread`,
    );
    t.assert(
      !(await t.pageText()).includes("doesn't exist"),
      `${code}: Back after a cancel lands on a live screen`,
    );
    await shot(t, `back-after-cancel-${width}`);
    await t.click("What's due");
    await t.waitFor(`location.pathname === "/due"`, "What's due opens");
  }
  await t.viewport(1440, 900);
};

const syncShells = async (t, test, label) => {
  await t.click("Settings");
  await t.click("Sync now", { within: '[data-school="lcc"]' });
  await t.waitFor(
    `(() => { const shells = JSON.parse(localStorage.getItem("lms-app.v1")).state.newCourses.lcc ?? []; return shells.length === 2 && shells.${test}; })()`,
    `Lakeshore: ${label}`,
    WAIT,
  );
};

// Many schools hide term dates from teachers, so Canvas reports them as null. Setup still offers every course and asks for the dates.
const hiddenTermDates = async (t) => {
  const code = "ENG 101";
  await t.eval("window.__faultLab.hideTermDates(true)");
  await syncShells(
    t,
    "every((shell) => shell.startAt === null)",
    "a sync reads the new courses with no dates",
  );
  await t.click("What's due");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("offer-banner"))})?.innerText.includes("4 new courses")`,
    "with term dates hidden, What's due still offers the 4 new courses",
    WAIT,
  );
  const offer = await offerSelector(t, code, "due");
  await t.click(`${offer} button:not([aria-label])`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id(`source-course-${code}`))})`,
    `${code}: with term dates hidden, the previous course still lists as a source`,
    WAIT,
  );
  await t.click(id(`source-course-${code}`));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("dates-card"))})`,
    `${code}: choosing a source opens Dates`,
  );
  const blank = await t.eval(
    `["old-term-start", "old-term-end", "new-term-start", "new-term-end"].map((name) => document.querySelector('[data-testid="' + name + '"]').value)`,
  );
  t.assert(
    blank.every((value) => value === ""),
    `${code}: dates the school hides start blank for the person to fill`,
    JSON.stringify(blank),
  );
  await fillOldTerm(t, "Fall 2026", "2026-08-24", "2026-12-11");
  await setField(t, id("new-term-start"), "2027-01-19");
  await setField(t, id("new-term-end"), "2027-05-07");
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(id("shift-row"))}).length > 0`,
    `${code}: typed dates are enough for the shift preview`,
  );
  await shot(t, "hidden-term-dates");
  await t.click("What's due");
  await t.waitFor(`location.pathname === "/due"`, "What's due opens");
  await t.click("Cancel setup", { within: offer });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(offer)})?.innerText.includes("Set up this course")`,
    `${code}: Cancel setup offers the course again`,
  );
  await t.eval("window.__faultLab.hideTermDates(false)");
  await syncShells(t, "every((shell) => shell.startAt !== null)", "a sync reads the dates again");
};

const sidebarSetupCount = (t) =>
  t.eval(
    `[...document.querySelectorAll('[data-testid="setup-offers-toggle"]')].reduce((sum, el) => sum + Number(el.innerText.match(/^(\\d+) /)?.[1] ?? 0), 0)`,
  );

const dismissAndUndo = async (t) => {
  const code = "COMM 110";
  const offer = await offerSelector(t, code, "due");
  const before = await sidebarSetupCount(t);
  // At 1280x720 the offers sit below the fold, and its 1180x800 twin can't scroll as far, so that shot keeps the list at the top.
  for (const [width, height, scroll] of [
    [
      1440,
      900,
      `document.querySelector(${JSON.stringify(id("offer-banner"))}).scrollIntoView({ block: "center" })`,
    ],
    [1280, 720, `document.querySelector(${JSON.stringify(id("due-list"))}).scrollTop = 0`],
  ]) {
    await t.viewport(width, height);
    await t.click(`${offer} button[aria-label="Dismiss ${code}"]`);
    await t.waitFor(
      `!document.querySelector(${JSON.stringify(offer)})`,
      `${code}: Dismiss takes it off What's due`,
    );
    t.assert(
      (await t.text(id("offer-banner"))).includes("3 new courses"),
      "What's due counts one course fewer",
    );
    t.assert(
      (await sidebarSetupCount(t)) === before - 1,
      "the sidebar counts one course fewer to set up",
    );
    const toast = await t.text(id("undo-toast"));
    t.assert(
      toast.includes(`Dismissed ${code}`) && toast.includes("Undo"),
      `${code}: a toast offers to undo the dismiss`,
      toast,
    );
    await t.eval(`void (${scroll})`);
    await shot(t, `offer-dismissed-${width}`);
    await t.click("Undo", { within: id("undo-toast") });
    await t.waitFor(
      `document.querySelector(${JSON.stringify(offer)})`,
      `${code}: Undo puts it back on What's due`,
    );
    t.assert(!(await t.has(id("undo-toast"))), "Undo closes the toast");
    t.assert((await sidebarSetupCount(t)) === before, "the sidebar counts it again");
    await t.eval(`void (${scroll})`);
    await shot(t, `offer-undone-${width}`);
  }
  await t.viewport(1440, 900);
};

const previousCourseFlow = async (t) => {
  const code = "ENG 101";
  t.assert((await t.eval(`location.pathname`)) !== "", "the app is running");
  await t.click("What's due");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("offer-banner"))})`,
    "What's due offers the new courses",
  );
  const banner = await t.text(id("offer-banner"));
  t.assert(banner.includes("Set up this course"), 'the offer says "Set up this course"');
  t.assert(
    /new courses? for Spring 2027/.test(banner) && !banner.includes("this term"),
    "the offer names the term the new courses belong to",
  );
  for (const name of ["ENG 101", "COMM 110", "ENG 210", "HUM 150"])
    t.assert(banner.includes(name), `the offer names ${name}`);
  t.assert(banner.includes("14 students"), "the occupied course says what is in it");
  await shot(t, "detect-offers");

  await t.click("Search threads and students", { within: '[data-testid="sidebar"]' });
  await t.waitFor(`document.querySelector('[data-testid="palette"]')`, "the palette opens");
  await t.type("spring setup");
  await t.waitFor(
    `document.querySelector('[data-testid="palette"]').innerText.includes(${JSON.stringify(code)})`,
    `${code}: the palette finds the course to set up`,
  );
  await shot(t, "palette-setup");
  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector('[data-testid="palette"]')`,
    "Escape closes the palette",
  );

  const before = await writesTo(t);
  const offer = await offerSelector(t, code, "due");
  const shellRef = await t.eval(`document.querySelector(${JSON.stringify(offer)}).dataset.course`);
  await t.click(`${offer} button:not([aria-label])`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("source-card"))})`,
    `${code}: Set up this course opens the source step`,
  );
  t.assert(
    (await rail(t, 1)) === "complete" && (await rail(t, 2)) === "current",
    `${code}: the rail shows Detect done and Source current`,
  );
  t.assert(
    (await t.text(id("setup-school"))) === "Lakeshore Community College",
    `${code}: the setup header names the school`,
  );
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id(`source-course-${code}`))})`,
    `${code}: the previous course lists`,
  );
  await shot(t, "source");

  await pickPackage(t, "grades-export.csv");
  await t.waitText("That file isn't a course export.", "a CSV is refused with the reason");
  t.assert(await t.has(id("source-card")), "a refused file stays on the source step");
  await shot(t, "source-csv-refused");

  await t.click(id(`source-course-${code}`));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("dates-card"))})`,
    `${code}: choosing a source opens Dates`,
  );
  t.assert((await rail(t, 3)) === "current", `${code}: the rail shows Dates current`);
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(id("old-term-start"))}).value`)) ===
      "2026-08-24",
    `${code}: the old term fills from the source`,
  );
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(id("new-term-start"))}).value`)) ===
      "2027-01-19",
    `${code}: the new term fills from the course`,
  );
  t.assert(
    (await t.eval(
      `document.querySelector(${JSON.stringify(id("day-old-2"))}).getAttribute("aria-pressed")`,
    )) === "true",
    `${code}: Tuesday is an old meeting day`,
  );
  await t.click(id("day-new-1"));
  await t.click(id("day-new-3"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("day-map"))})?.innerText.includes("Tuesday becomes Monday") && document.querySelector(${JSON.stringify(id("day-map"))}).innerText.includes("Thursday becomes Wednesday")`,
    `${code}: two clicks make Tue/Thu into Mon/Wed, said in words`,
  );
  await addBreak(t);
  await t.waitFor(
    `document.body.innerText.includes("Moved out of Spring break")`,
    `${code}: the shift preview flags an item moved out of the break`,
  );
  t.assert((await count(t, id("shift-row"))) > 0, `${code}: the shift preview lists items`);
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('${id("shift-row")} td:nth-child(2), ${id("shift-row")} td:nth-child(3)')].every((cell) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /.test(cell.innerText))`,
    )) === true,
    `${code}: both due dates in the shift table name their weekday`,
  );
  await assertDatesSpacing(t);
  await shot(t, "dates-pattern-change-and-break");
  await t.reload();
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("dates-card"))})`,
    `${code}: a reload lands back on Dates`,
  );
  t.assert(
    (await t.text(id("day-map"))).includes("Tuesday becomes Monday") &&
      (await count(t, id("break-row"))) === 1,
    `${code}: the meeting days and the break survive a reload`,
  );
  await shot(t, "dates-after-reload");

  await t.click(id("review-copy"));
  await approveCopy(t, code);
  const copyPreview = await t.text(id("copy-card"));
  t.assert(
    copyPreview.includes("Spring 2027") && copyPreview.includes("Spring break"),
    `${code}: the copy preview names the term and the break`,
  );
  await t.eval(
    `void document.querySelector(${JSON.stringify(id("copy-card"))}).scrollIntoView({ block: "start" })`,
  );
  await shot(t, "copy-approve");
  t.assert(
    (await count(t, `${id("copy-card")} ${id("shift-row")}`)) > 0 &&
      copyPreview.includes("Moved out of Spring break"),
    `${code}: the copy preview lists where every due date lands, with the break move`,
  );
  t.assert(
    (await count(t, id("shift-row"))) === (await count(t, `${id("copy-card")} ${id("shift-row")}`)),
    `${code}: the dates table shows once, in the copy preview, while the dates match the review`,
  );
  const reviewedEnd = await t.eval(
    `document.querySelector(${JSON.stringify(id("new-term-end"))}).value`,
  );
  await setField(t, id("new-term-end"), "2027-05-14");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("copy-stale"))})`,
    `${code}: changing the dates after the review marks the copy out of date`,
  );
  t.assert(
    !(await t.has(id("copy-approve"))) && !(await t.has(id("copy-send"))),
    `${code}: an out-of-date copy can't be approved or sent`,
  );
  t.assert(
    (await t.text(id("copy-card"))).includes("Out of date"),
    `${code}: the copy card's status says it is out of date`,
  );
  t.assert(
    await t.eval(enabled(id("review-copy"))),
    `${code}: Review the copy is on for the new dates`,
  );
  t.assert(
    (await count(t, `${id("dates-card")} ${id("shift-row")}`)) > 0,
    `${code}: once the dates change, the dates card shows the new table again`,
  );
  await shot(t, "copy-stale");
  await setField(t, id("new-term-end"), reviewedEnd);
  await t.waitFor(
    enabled(id("copy-send")),
    `${code}: with the reviewed dates back, the approved copy can send`,
  );
  t.assert(!(await t.has(id("copy-stale"))), `${code}: the out-of-date mark clears`);
  await t.click(id("copy-send"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("copy-progress"))})`,
    `${code}: copy progress shows in the thread`,
    WAIT,
  );
  t.assert(
    (await rail(t, 4)) === "current",
    `${code}: the rail shows Scan current during the copy`,
  );
  await t.waitFor(
    `/\\d+%/.test(document.querySelector(${JSON.stringify(id("copy-percent"))})?.innerText ?? "")`,
    `${code}: progress shows a percent`,
  );
  await shot(t, "copy-progress");

  await t.reload();
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("setup-rail"))})`,
    `${code}: a reload mid-copy lands back in the thread`,
  );
  t.assert(
    (await migrationsFor(t, code)) === 1,
    `${code}: one migration exists after a reload mid-copy`,
  );
  await t.waitFor(
    `document.querySelector('[data-testid="chat"]')?.innerText.includes("Scanning") || document.querySelector(${JSON.stringify(id("finding-row"))})`,
    `${code}: the scan starts by itself after the copy`,
    WAIT,
  );
  await waitReview(t, code);
  t.assert(
    (await migrationsFor(t, code)) === 1,
    `${code}: still one migration after the copy finished`,
  );
  await assertReviewSpacing(t);
  await t.eval(
    `void document.querySelector(${JSON.stringify(id("finding-list"))}).scrollIntoView({ block: "start" })`,
  );
  await t.sleep(100);
  await shot(t, "scan-findings");

  const expected = [
    "plain-date",
    "old-term-name",
    "old-course-link",
    "broken-link",
    "missing-file",
    "lti-link",
    "copied-announcement",
    "foreign-contact",
    "missing-statement",
    "unpublished-item",
    "date-in-break",
    "empty-module",
  ];
  for (const type of expected)
    t.assert(
      await t.has(id(`finding-group-${type}`)),
      `${code}: the review lists ${type} findings`,
    );

  const afterCopy = await writesTo(t);
  t.assert(
    afterCopy === before + 1,
    `${code}: the only write so far is the approved copy`,
    `${before} then ${afterCopy}`,
  );

  const row = await openRow(t, "fix");
  t.assert(row !== null, `${code}: a fix row opens`);
  const words = await t.text(row);
  t.assert(
    words.includes("Replaces") || words.includes("Adds"),
    `${code}: the preview says in words what the fix replaces`,
  );
  await shot(t, "review-plain-preview");
  await assertReviewScreenEdge(t);
  await sourceTabHasContent(t, code);

  await t.click(`${row} ${id("finding-approve")}`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(row)})?.innerText.includes("Ready to send")`,
    `${code}: Approve marks one fix ready`,
  );
  await t.click(`${row} ${id("finding-edit")}`);
  await setField(t, `${row} ${id("finding-edit-text")}`, "Monday, February 8 at noon");
  await t.click(`${row} ${id("finding-edit-save")}`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(row)})?.innerText.includes("Needs approval again")`,
    `${code}: editing an approved fix resets its approval`,
  );
  t.assert(
    (await t.text(row)).includes("Monday, February 8 at noon"),
    `${code}: the preview shows the edited text`,
  );
  t.assert((await writesTo(t)) === afterCopy, `${code}: approving and editing wrote nothing`);
  await shot(t, "review-edit-resets-approval");
  await t.click(`${row} ${id("finding-approve")}`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(row)})?.innerText.includes("Ready to send")`,
    `${code}: a fresh Approve is needed and works`,
  );
  await statementEdits(t, code);

  const other = await t.eval(
    `[...document.querySelectorAll('${id("finding-row")}[data-status="fix"]')].map((el) => el.dataset.findingKey).find((key) => !${JSON.stringify(row)}.includes(key))`,
  );
  const dismissed = `${id("finding-row")}[data-finding-key="${other}"]`;
  await t.click(`${dismissed} button[aria-expanded]`);
  await t.click(`${dismissed} ${id("finding-dismiss")}`);
  await setField(t, `${dismissed} ${id("finding-dismiss-reason")}`, "Leaving this one as written");
  await t.click(`${dismissed} ${id("finding-dismiss-confirm")}`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(dismissed)})?.dataset.status === "dismissed"`,
    `${code}: Dismiss marks the finding`,
  );
  await t.click(`${dismissed} ${id("finding-restore")}`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(dismissed)})?.dataset.status === "fix"`,
    `${code}: Restore brings it back`,
  );
  const fresh = await t.eval(
    `[...document.querySelectorAll('${id("finding-row")}[data-status="fix"]')].filter((el) => el.querySelector('${id("finding-toggle")}')).map((el) => el.dataset.findingKey).find((key) => !${JSON.stringify(row)}.includes(key) && key !== ${JSON.stringify(other)})`,
  );
  await approveAndSendRightAfterTicking(
    t,
    code,
    row,
    `${id("finding-row")}[data-finding-key="${fresh}"]`,
  );
  await t.click(`${dismissed} ${id("finding-dismiss")}`);
  await t.click(`${dismissed} ${id("finding-dismiss-confirm")}`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(dismissed)})?.dataset.status === "dismissed"`,
    `${code}: Dismiss again for the publish check`,
  );
  await shot(t, "review-dismissed");

  await t.click(id("run-check"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("readiness"))})`,
    `${code}: the publish check names what is left`,
    WAIT,
  );
  t.assert(
    !(await t.has(id("prepare-publish"))),
    `${code}: Publish is not offered with findings open`,
  );
  await shot(t, "publish-check-not-ready");

  await openInLms(t, code);
  t.assert((await clearManual(t, code)) > 0, `${code}: manual findings get "I handled it"`);
  await t.eval(
    `window.sawStillHere = false; window.stillHereWatch = setInterval(() => { window.sawStillHere ||= Boolean(document.querySelector('${id("finding-row")}[data-status="still-here"]')); }, 25)`,
  );
  await fixRest(t, code);
  t.assert(
    (await t.eval(`(clearInterval(window.stillHereWatch), window.sawStillHere)`)) === false,
    `${code}: a fix sent in a batch never reads as still here while its rescan is pending`,
  );
  t.assert((await writesTo(t)) > afterCopy, `${code}: approved fixes reach the LMS`);
  await shot(t, "review-batch-sent");
  const isoNames = await t.eval(
    `[...document.querySelectorAll('${id("finding-row")} button[aria-expanded]')].map((el) => el.innerText).filter((name) => /\\d{4}-\\d{2}-\\d{2}/.test(name))`,
  );
  await t.eval(
    `void document.querySelector('${id("finding-row")}[data-status="fixed"]')?.scrollIntoView({ block: "center" })`,
  );
  await t.sleep(100);
  await shot(t, "review-fixed-rows");
  t.assert(
    isoNames.length === 0,
    `${code}: no review row names a raw ISO date`,
    isoNames.join(" | "),
  );
  await publish(t, code);
  await shot(t, "publish-approved");
  await t.waitFor(
    `document.querySelector('[data-testid="sidebar-list"]')?.innerText.includes("Composition I, Spring 2027")`,
    `${code}: the published course shows as a course row`,
    WAIT,
  );
  t.assert(
    await t.eval(
      `(() => { const link = document.querySelector('[data-testid="sidebar-list"] a[aria-current]'); return Boolean(link?.innerText.includes(${JSON.stringify(`Set up ${code}`)}) && link.closest("ul").parentElement.innerText.includes("Composition I, Spring 2027")); })()`,
    ),
    `${code}: the setup thread sits inside the course row`,
  );
  t.assert(
    !(await t.has(`[data-testid="setup-offer"][data-course="${shellRef}"]`)),
    `${code}: no offer to set it up remains`,
  );
  await shot(t, "published-course-row");
  await t.click("Composition I, Spring 2027");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("save-template"))})`,
    `${code}: the published course's page offers Save as template`,
  );
  await assertTemplateEdge(t, `${code} course page`);

  await t.click(id("save-template"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("template-card"))})`,
    `${code}: Save as template shows as a change to approve`,
    WAIT,
  );
  t.assert(
    !(await t.eval(enabled(id("template-send")))),
    `${code}: template Send stays off until Approve`,
  );
  await shot(t, "end-of-term-template");
  await t.click(id("template-approve"));
  await t.waitFor(enabled(id("template-send")), `${code}: approving turns template Send on`);
  await t.click(id("template-send"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("template-card"))})?.innerText.includes("Sent")`,
    `${code}: the template flag lands`,
    WAIT,
  );
  await shot(t, "end-of-term-saved");
};

const cartridgeFromConnected = async (t) => {
  const code = "COMM 110";
  await openOffer(t, code);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("source-sample-0"))})`,
    `${code}: sample packages list`,
  );
  t.assert(
    (await t.text(id("source-course-ENG 101"))).includes("Template"),
    `${code}: the course saved as a template lists as a source, tagged`,
  );
  const firstChoice = await t.eval(
    `document.querySelector('${id("source-card")} [data-testid^="source-course-"]').dataset.testid`,
  );
  t.assert(firstChoice === "source-course-COMM 110", `${code}: the previous COMM 110 lists first`);
  const secondChoice = await t.eval(
    `document.querySelectorAll('${id("source-card")} [data-testid^="source-course-"]')[1].dataset.testid`,
  );
  t.assert(
    secondChoice === "source-course-ENG 101",
    `${code}: the template lists next, so the loop starts again`,
  );
  await shot(t, "source-template-listed");

  t.assert(
    !(await t.has(id("cartridge-input"))),
    `${code}: the desktop app picks a package with main's picker, not a file input`,
  );
  await pickPackage(t, null);
  await t.sleep(300);
  t.assert(
    (await t.has(id("source-card"))) && !(await t.has(id("dates-card"))),
    `${code}: cancelling the picker stays on Source`,
  );
  await pickPackage(t, "imscc/damaged-export.imscc");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("dates-card"))})`,
    `${code}: a real .imscc through main's picker opens Dates`,
  );
  const newStart = Date.parse(await value(t, "new-term-start"));
  const newEnd = Date.parse(await value(t, "new-term-end"));
  const sameLength = new Date(Date.parse("2026-01-20") + newEnd - newStart)
    .toISOString()
    .slice(0, 10);
  t.assert(
    (await value(t, "old-term-start")) === "2026-01-20" &&
      (await value(t, "old-term-end")) === sameLength,
    `${code}: the package's start fills the old term, and its missing end runs as long as the new term (${sameLength})`,
  );
  t.assert(
    (await t.text(id("guessed-end"))).includes("doesn't say when the old term ended"),
    `${code}: the form says where the old term's end came from`,
  );
  await shot(t, "dates-package-settings");
  await fillOldTerm(t, "Spring 2026", "2026-01-20", "2026-05-08");
  t.assert(
    !(await t.eval(enabled(id("review-copy")))),
    `${code}: a package with no due dates needs its meeting days first`,
  );
  t.assert(
    (await t.text(id("day-map"))).includes("Each due date moves from an old meeting day"),
    `${code}: the form says why it needs meeting days`,
  );
  await shot(t, "dates-days-why");
  await pickDaysIfBlank(t, "old", [1, 3]);
  await pickDaysIfBlank(t, "new", [1, 3]);
  await t.click(id("review-copy"));
  await approveCopy(t, code);
  await t.click(id("copy-send"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("copy-failed"))})`,
    `${code}: a damaged package shows the failure`,
    WAIT,
  );
  t.assert(
    await t.has(id("copy-change-source")),
    `${code}: a failed copy offers another source beside Copy again`,
  );
  await shot(t, "copy-failed");
  await t.click(id("copy-again"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("copy-card"))})`,
    `${code}: Copy again drafts a new copy`,
    WAIT,
  );
  t.assert(!(await t.eval(enabled(id("copy-send")))), `${code}: Copy again needs a new approval`);
  await t.click("Change source");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("source-card"))})`,
    `${code}: Change source goes back to Source`,
  );
  await pickPackage(t, "imscc/comm110-lakeshore-fall2026-export.imscc");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("dates-card"))})`,
    `${code}: the good package opens Dates`,
  );
  t.assert(
    (await value(t, "old-term-start")) === "2026-08-24" &&
      (await value(t, "old-term-end")) === "2026-12-11",
    `${code}: a package through main's picker fills its own old term`,
  );
  t.assert(
    (await t.eval(
      `["old", "new"].every((side) => [0, 1, 2, 3, 4, 5, 6].map((day) => document.querySelector(\`[data-testid="day-\${side}-\${day}"]\`).getAttribute("aria-pressed") === "true").join() === [false, false, true, false, true, false, false].join())`,
    )) === true,
    `${code}: the package's due dates fill Tue/Thu on both terms, so the teacher only confirms`,
  );
  t.assert(
    !(await t.has(id("package-term-warning"))),
    `${code}: the package's own term raises no warning`,
  );
  await fillOldTerm(t, "Spring 2026", "2026-01-20", "2026-05-08");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("package-term-warning"))})?.innerText.includes("Fall 2026")`,
    `${code}: an old term that doesn't match the package is called out`,
  );
  await shot(t, "dates-package-term-mismatch");
  // A Canvas export carries no term name, so the teacher leaves it blank.
  await fillOldTerm(t, "", "2026-08-24", "2026-12-11");
  await pickDaysIfBlank(t, "old", [2, 4]);
  await pickDaysIfBlank(t, "new", [2, 4]);
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(`${id("dates-card")} ${id("shift-row")}`)}).length > 0`,
    `${code}: the package's due dates preview where they land, as a course source's do`,
  );
  await shot(t, "dates-package-preview");
  await t.click(id("review-copy"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("copy-card"))})`,
    `${code}: the copy card opens`,
    WAIT,
  );
  const was = await t.eval(
    `[...document.querySelectorAll('${id("copy-card")} dt')].find((dt) => dt.innerText === "Was")?.nextElementSibling?.innerText ?? null`,
  );
  t.assert(
    was === "Aug 24, 2026 to Dec 11, 2026",
    `${code}: an old term with no name reads as its dates alone (got ${JSON.stringify(was)})`,
  );
  t.assert(
    await t.has(`${id("copy-card")} ${id("shift-row")}`),
    `${code}: the copy card shows where the package's due dates land`,
  );
  await shot(t, "copy-package-no-term-name");
  await approveCopy(t, code, 1);
  await t.click(id("copy-send"));
  await waitReview(t, code);
  t.assert(
    !(await t.eval(
      `/Old term names|still says \\./.test(document.querySelector(${JSON.stringify(id("review-card"))})?.innerText ?? document.body.innerText)`,
    )),
    `${code}: with no old term name, the scan flags no item for one`,
  );
  await shot(t, "review-package-no-term-name");
  await clearManual(t, code);
  await fixRest(t, code);
  await publish(t, code);
};

const cartridgeFromUnconnected = async (t) => {
  const code = "ENG 210";
  await openOffer(t, code);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("source-sample-1"))})`,
    `${code}: sample packages list`,
  );
  t.assert(
    (await t.text(id("source-sample-1"))).includes("Northgate"),
    `${code}: a sample comes from a school not connected`,
  );
  await t.click(id("source-sample-1"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("dates-card"))})`,
    `${code}: the sample opens Dates`,
  );
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(id("old-term-start"))}).value`)) ===
      "2026-01-20",
    `${code}: the package's hint fills the old term`,
  );
  await addBreak(t);
  await shot(t, "dates-cartridge");
  await t.click(id("review-copy"));
  await approveCopy(t, code);
  await t.click(id("copy-send"));
  await waitReview(t, code);
  t.assert(
    await t.has(id("finding-group-foreign-contact")),
    `${code}: the other school's contact info is flagged`,
  );
  t.assert(
    await t.has(id("finding-group-migration-issue")),
    `${code}: migration issues list as findings`,
  );
  await shot(t, "review-other-school");
  await clearManual(t, code);
  await fixRest(t, code);
  await publish(t, code);
  await shot(t, "published-riverbend");
};

const occupiedCourse = async (t) => {
  const code = "HUM 150";
  await openOffer(t, code);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id(`source-course-${code}`))})`,
    `${code}: the previous course lists`,
  );
  await t.click(id(`source-course-${code}`));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("occupied-warning"))})`,
    `${code}: Dates warns the course has students and content`,
  );
  t.assert(
    (await t.text(id("occupied-warning"))).includes("14 students"),
    `${code}: the warning gives the count`,
  );
  await t.click(id("review-copy"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("copy-card"))})`,
    `${code}: the copy shows as a change to approve`,
    WAIT,
  );
  await t.click(id("copy-approve"));
  await t.waitFor(
    `document.querySelector('[role="dialog"], [role="alertdialog"]')`,
    `${code}: Approve asks for extra confirmation`,
  );
  const dialog = `document.querySelector('[role="dialog"], [role="alertdialog"]')`;
  t.assert(
    (await t.eval(`${dialog}.innerText`)).includes("14 students"),
    `${code}: the dialog names the students`,
  );
  t.assert(
    !(await t.eval(enabled(id("copy-send")))),
    `${code}: Send stays off while the dialog is open`,
  );
  t.assert(
    (await t.eval(
      `[...${dialog}.querySelectorAll("button")].filter((b) => /approve/i.test(b.innerText)).every((b) => b.disabled)`,
    )) === true,
    `${code}: the dialog's Approve is off until the code is typed`,
  );
  await shot(t, "guardrail-confirm");
  await t.click("[data-confirm-code]");
  await t.type("HUM 15");
  t.assert(
    (await t.eval(
      `[...${dialog}.querySelectorAll("button")].filter((b) => /approve/i.test(b.innerText)).every((b) => b.disabled)`,
    )) === true,
    `${code}: a partial code keeps it off`,
  );
  await t.type("0");
  await t.waitFor(
    `[...${dialog}.querySelectorAll("button")].some((b) => /approve/i.test(b.innerText) && !b.disabled)`,
    `${code}: the exact code turns it on`,
  );
  await shot(t, "guardrail-typed");
  await t.click("[data-approve-confirm]");
  await t.waitFor(enabled(id("copy-send")), `${code}: the confirmed copy can send`);
  await t.click(id("copy-send"));
  await waitReview(t, code);
  await clearManual(t, code);
  await fixRest(t, code);
  await publish(t, code);
};

const templateFromCourse = async (t) => {
  await t.click("Composition II");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("save-template"))})`,
    "a current course offers Save as template",
  );
  await t.click(id("save-template"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("template-card"))})`,
    "the course's action opens a change to approve",
    WAIT,
  );
  t.assert(
    !(await t.eval(enabled(id("template-send")))),
    "the course's template Send stays off until Approve",
  );
  await shot(t, "template-from-course");
  await t.click(id("template-approve"));
  await t.waitFor(enabled(id("template-send")), "approving turns the course's template Send on");
  await t.click(id("template-send"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("template-card"))})?.innerText.includes("Sent")`,
    "the course's template flag lands",
    WAIT,
  );
};

const sourceTabHasContent = async (t, code) => {
  await t.key("Meta+d");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("thread-panel"))})`,
    `${code}: the preview opens beside the fix`,
  );
  const tabs = await t.eval(
    `[...document.querySelectorAll('${id("thread-panel")} [role="tab"]')].map((tab) => tab.innerText)`,
  );
  for (const tab of tabs) {
    await t.click(tab, { within: id("thread-panel") });
    await t.sleep(150);
    await shot(t, `panel-tab-${tab.toLowerCase().replace(/\W+/g, "-")}`);
    t.assert(
      !(await t.text(id("thread-panel"))).includes("Nothing to show yet"),
      `${code}: the ${tab} tab beside an open fix has something to show`,
    );
  }
  await t.click('[aria-label="Close preview"]');
};

const writesLogRowsDiffer = async (t) => {
  await t.click("Settings");
  await t.click("Demo", { within: '[data-testid="settings-nav"]' });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("writes-log"))})`,
    "the writes log shows",
  );
  const rows = await t.eval(
    `[...document.querySelectorAll('${id("writes-log")} tr[data-write]')].map((row) => [...row.cells].slice(1).map((cell) => cell.innerText).join(" | "))`,
  );
  const repeats = rows.filter((row, index) => rows.indexOf(row) !== index);
  t.assert(
    rows.length > 10 && repeats.length === 0,
    "each row in the writes log reads differently",
    `${rows.length} rows, repeats: ${[...new Set(repeats)].join(" ; ")}`,
  );
  await t.eval(
    `void document.querySelector(${JSON.stringify(id("writes-log"))}).scrollIntoView({ block: "center" })`,
  );
  await t.sleep(100);
  await shot(t, "writes-log");
};

const afterPublish = async (t) => {
  await t.click("Settings");
  await t.waitFor(`location.pathname === "/settings"`, "Settings opens");
  await t.click("What's due");
  await t.waitFor(`location.pathname === "/due"`, "What's due opens");
  t.assert(
    !(await t.has(id("offer-banner"))),
    "no offers remain once every new course has a thread",
  );
  await t.waitFor(
    `document.querySelector('[data-testid="sidebar"]')?.innerText.includes("ENG 101")`,
    "the sidebar still shows the courses",
  );
  await t.goto("/due");
  await t.waitFor(
    `document.querySelector('[data-due-group="not-yet"] [data-due-row]')`,
    "What's due lists this week's open work",
  );
  await shot(t, "after-publish-due");
  const published = await lms(
    t,
    `lms.term.shells.filter((s) => s.workflow_state === "available").map((s) => {
      const item = lms.term.content[s.school + ":course:" + s.canvasId].items.find((i) => i.type === "assignment" && i.dueAt);
      return { prefix: s.school + ":assignment:" + s.canvasId + ":", ref: s.school + ":assignment:" + s.canvasId + ":" + item.id, day: item.dueAt.slice(0, 10) };
    })`,
  );
  t.assert(published.length > 0, "some next-term courses are published");
  const refsIn = (scope, attr) =>
    t.eval(
      `[...document.querySelectorAll('${scope} [${attr}]')].map((el) => el.getAttribute("${attr}"))`,
    );
  const nextTermIn = (refs) =>
    refs.filter((ref) => published.some(({ prefix }) => ref.startsWith(prefix)));
  const notYet = await refsIn('[data-due-group="not-yet"]', "data-due-row");
  t.assert(
    nextTermIn(notYet).length === 0,
    "What's due keeps a published next-term course's work out of Not yet",
    nextTermIn(notYet).join(", "),
  );
  await t.goto("/calendar");
  await t.waitFor(`document.querySelector("[data-calendar-marker]")`, "Calendar shows this week");
  t.assert(
    nextTermIn(await refsIn("body", "data-calendar-marker")).length === 0,
    "Calendar shows no next-term work this week either",
  );
  const [first] = published;
  await t.goto(`/calendar?day=${first.day}`);
  await t.waitFor(
    `document.querySelector('[data-calendar-marker=${JSON.stringify(first.ref)}]')`,
    `Calendar still shows next-term work on its own date, ${first.day}`,
  );
  await shot(t, "after-publish-calendar-next-term");
};

const offered = (code) =>
  `(JSON.parse(localStorage.getItem("lms-app.v1")).state.newCourses.lcc ?? []).some((shell) => shell.code === ${JSON.stringify(code)})`;
const sidebarOffers = (code) =>
  `[...document.querySelectorAll('[data-testid="setup-offer"][data-surface="sidebar"]')].some((el) => el.innerText.includes(${JSON.stringify(code)}))`;
const unfoldSidebarOffers = (t) =>
  t.eval(
    `document.querySelectorAll('[data-testid="setup-offers-toggle"][aria-expanded="false"]').forEach((row) => row.click())`,
  );

// Nothing here presses Sync now: the network coming back, and then a relaunch, each read what Canvas added meanwhile.
const newCourseWithoutSync = async (t) => {
  await t.click("What's due");
  await t.waitFor(`location.pathname === "/due"`, "What's due opens");
  await t.eval(`window.__faultLab.createShell("lcc", "BIO 105", "Biology")`);
  t.assert(
    !(await t.eval(offered("BIO 105"))),
    "a course Canvas adds while the app is open is not offered yet",
  );
  await shot(t, "auto-sync-before");
  const network = (offline) =>
    t.cdp("Network.emulateNetworkConditions", {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  await t.cdp("Network.enable");
  await network(true);
  await t.waitFor("navigator.onLine === false", "the Mac goes offline");
  await network(false);
  await t.waitFor("navigator.onLine === true", "the Mac comes back online");
  await t.waitFor(
    offered("BIO 105"),
    "coming back online syncs, so the new course is offered without Sync now",
    WAIT,
  );
  await unfoldSidebarOffers(t);
  await t.waitFor(sidebarOffers("BIO 105"), "the sidebar offers BIO 105 to set up", WAIT);
  await shot(t, "auto-sync-online");

  await t.eval(`window.__faultLab.createShell("lcc", "CHEM 110", "Chemistry")`);
  await t.reload();
  await t.waitFor(
    offered("CHEM 110"),
    "a relaunch syncs, so a course added while the app was closed is offered without Sync now",
    WAIT,
  );
  await unfoldSidebarOffers(t);
  await t.waitFor(sidebarOffers("CHEM 110"), "the sidebar offers CHEM 110 to set up", WAIT);
  await shot(t, "auto-sync-launch");
};

export const run = async (t) => {
  await clearOwnShots(t);
  shots = 0;
  await setup(t);
  await hiddenTermDates(t);
  await cancelBeforeCopy(t);
  await dismissAndUndo(t);
  await previousCourseFlow(t);
  await cartridgeFromConnected(t);
  await cartridgeFromUnconnected(t);
  await occupiedCourse(t);
  await templateFromCourse(t);
  await afterPublish(t);
  await writesLogRowsDiffer(t);
  await newCourseWithoutSync(t);
};
