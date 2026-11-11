import { addAiKey } from "./ai-key.mjs";
import { onboard } from "./onboard.mjs";

// A long student name, clicks right after a selection change, and Save as template's distance from the window edge. Starts from a fresh visit, because it spends drafts the other modules count on.
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const LONG_NAME = "Arjun Venkataraghavan-Subramaniam Krishnamurthy";
const LIST = '[data-testid="queue-list"]';
const QUEUE = '[data-testid="pinned-queue"]';
const PANEL = '[data-testid="thread-panel"]';
const BATCH_HEADER = '[data-testid="batch-header"]';
const WIDTHS = [
  [1440, 900],
  [1180, 800],
];
const SUBJECT = {
  long: `${LONG_NAME}, Memo Revision`,
  cody: "Cody Fenwick, Memo Revision",
  silas: "Silas Wray, Sequence Analysis",
  aaliyah: "Aaliyah Brooks, Essay 2",
  hannah: "Hannah Stroud, Essay 2",
  kenji: "Kenji Arai, Sequence Analysis",
};
const STUDENT = {
  cody: "Cody Fenwick",
  silas: "Silas Wray",
  aaliyah: "Aaliyah Brooks",
  hannah: "Hannah Stroud",
  kenji: "Kenji Arai",
};

export const STANDARD_EDGE = 16;

const tagOf = (t, subject) =>
  t.eval(
    `Object.values(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).find((c) => c.subject === ${JSON.stringify(subject)})?.state.tag ?? null`,
  );
const writes = (t) =>
  t.eval(`JSON.parse(localStorage.getItem("lms-app.fake-canvas.v1")).writeLog.length`);
const noAgent = (t, label) =>
  t.waitFor(`!document.querySelector('[data-testid="agent-working"]')`, label);

const until = async (t, check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await t.sleep(40);
  }
  return false;
};
const tagBecomes = (t, subject, tag, ms) =>
  until(t, async () => (await tagOf(t, subject)) === tag, ms);

// Every line of the name has to be inside its scope and the window, on top where it's painted, and clear of every control in that scope.
const nameProblems = (t, scope) =>
  t.eval(`(() => {
    const name = ${JSON.stringify(LONG_NAME)};
    const host = document.querySelector(${JSON.stringify(scope)});
    if (!host) return ["no " + ${JSON.stringify(scope)}];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node = null;
    while (walker.nextNode()) if (walker.currentNode.nodeValue.includes(name)) { node = walker.currentNode; break; }
    if (!node) return ["the whole name is not in the text"];
    const range = document.createRange();
    const start = node.nodeValue.indexOf(name);
    range.setStart(node, start);
    range.setEnd(node, start + name.length);
    const lines = [...range.getClientRects()].filter((r) => r.width > 0.5);
    const problems = [];
    const box = host.getBoundingClientRect();
    for (const r of lines) {
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) problems.push("a line leaves the scope");
      if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) problems.push("a line leaves the window");
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || !(top === node.parentElement || top.contains(node.parentElement) || node.parentElement.contains(top))) problems.push("a line is under " + (top?.tagName ?? "nothing"));
      for (const control of host.querySelectorAll("button,input,a,[role=tab]")) {
        if (control.contains(node.parentElement)) continue;
        const c = control.getBoundingClientRect();
        if (c.width && Math.min(r.right, c.right) - Math.max(r.left, c.left) > 0.5 && Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 0.5) problems.push("overlaps " + (control.getAttribute("aria-label") || control.innerText || control.tagName));
      }
    }
    for (let el = node.parentElement; el && el !== host.parentElement; el = el.parentElement) {
      const s = getComputedStyle(el);
      if ((s.overflowX !== "visible" || s.overflowY !== "visible") && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) problems.push("cut by " + el.tagName + (s.textOverflow === "ellipsis" ? " with an ellipsis" : ""));
    }
    return problems;
  })()`);

const assertNameReadable = async (t, scope, where) => {
  const problems = await nameProblems(t, scope);
  t.assert(
    problems.length === 0,
    `${where}: the long student name is fully visible with no overlap`,
    problems.join("; "),
  );
};

const assertControlsReachable = async (t, scope, where) => {
  const blocked = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter((el) => { const r = el.getBoundingClientRect(); if (!r.width || el.disabled) return false; const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(top === el || el.contains(top)); }).map((el) => el.getAttribute("aria-label") || el.innerText)`,
  );
  t.assert(
    blocked.length === 0,
    `${where}: every control is clickable, none clipped`,
    blocked.join(", "),
  );
};

const atWidth = async (t, [width, height]) => {
  await t.viewport(width, height);
  await t.sleep(150);
};

export const assertTemplateEdge = async (t, where) => {
  const { width, height } = t.size;
  for (const size of WIDTHS) {
    await atWidth(t, size);
    const inset = await t.eval(
      `(() => { const el = document.querySelector('[data-testid="save-template"]'); if (!el) return null; const r = el.getBoundingClientRect(); return Math.min(r.left, innerWidth - r.right); })()`,
    );
    t.assert(
      inset !== null && inset >= STANDARD_EDGE,
      `${where} at ${size[0]}: Save as template sits ${inset}px from the window edge, at least ${STANDARD_EDGE}`,
    );
  }
  await atWidth(t, [width, height]);
};

const longName = async (t) => {
  await t.goto("/welcome");
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await t.reload();
  await onboard(t);
  await t.waitFor(`location.pathname === "/due"`, "demo tokens land on What's due");
  await addAiKey(t);

  for (const size of WIDTHS) {
    await atWidth(t, size);
    await assertNameReadable(t, `${LIST} [data-row]:first-child`, `queue row at ${size[0]}`);
  }
  await t.click(LONG_NAME, { within: LIST });
  await t.waitFor(
    `document.querySelector("[data-focused]")?.innerText.includes(${JSON.stringify(SUBJECT.long)})`,
    "long name: the draft appears",
  );
  await noAgent(t, "long name: the agent finished");

  for (const size of WIDTHS) {
    await atWidth(t, size);
    t.assert(
      (await t.eval(`document.querySelector(${JSON.stringify(QUEUE)}).dataset.open`)) === "false",
      `queue header at ${size[0]}: opening a submission collapses the queue`,
    );
    await assertNameReadable(t, QUEUE, `queue header at ${size[0]}, source open`);
    await assertControlsReachable(t, QUEUE, `queue header at ${size[0]}, source open`);
    await assertNameReadable(t, "[data-focused]", `draft card at ${size[0]}`);
    await assertNameReadable(t, PANEL, `panel header at ${size[0]}`);
  }
  await atWidth(t, [1180, 800]);
  const main = await t.box('[data-testid="thread-main"]');
  t.assert(
    main.width >= 440,
    "queue header at 1180: the middle pane keeps its 440 minimum",
    String(main.width),
  );
  await t.shot("draft-1180", 4);

  await t.click("Close panel");
  await t.sleep(150);
  await assertNameReadable(t, QUEUE, "queue header at 1180, panel closed");
  await atWidth(t, [1440, 900]);
};

const pickRows = async (t, keys) => {
  for (const key of keys) await t.click(`[aria-label="Select ${STUDENT[key]}"]`);
};

const expandQueue = async (t) => {
  if (!(await t.has(LIST))) await t.click("Expand queue");
  await t.waitFor(`document.querySelector(${JSON.stringify(LIST)})`, "the queue list is showing");
};

const selectionClicks = async (t) => {
  await expandQueue(t);
  await pickRows(t, ["cody", "silas", "aaliyah", "hannah", "kenji"]);
  await t.click("Draft 5");
  await t.waitFor(`document.body.innerText.includes("Review 5")`, "five rows are drafted", 20_000);
  await noAgent(t, "drafting is done");
  await t.click("Review 5");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 5`,
    "the five drafts are stacked",
  );
  const identical = await t.eval(
    `[...document.querySelectorAll('[data-testid="identical-drafts"] p')].map((note) => note.innerText)`,
  );
  t.assert(
    identical.join() === "Aaliyah Brooks and Hannah Stroud have identical drafts",
    "before Approve 5, the batch names the two drafts that differ only by the student's name",
    JSON.stringify(identical),
  );
  await t.shot("batch-identical-drafts", null);
  await t.eval("history.back()");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(BATCH_HEADER)}) && document.querySelector(${JSON.stringify(LIST)}) && document.querySelector("[data-focused]")?.innerText.includes(${JSON.stringify(SUBJECT.long)}) && document.body.innerText.includes("5 selected")`,
    "Back from the batch returns to the list and the open draft it was opened over, still ticked",
  );
  await t.shot("batch-back", null);
  await t.eval("history.forward()");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 5`,
    "Forward reopens the batch",
  );
  await t.click("Open Hannah", { within: '[data-testid="identical-drafts"]' });
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')?.innerText.includes(${JSON.stringify(SUBJECT.hannah)})`,
    "Open Hannah opens her draft",
  );
  await t.eval("history.back()");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 5 && document.querySelector('[data-testid="identical-drafts"]')`,
    "Back from a draft opened in the batch returns to the batch",
  );
  await t.click("Open Hannah", { within: '[data-testid="identical-drafts"]' });
  await t.click("[data-card-edit]");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(PANEL)}) && document.activeElement?.closest("[data-focused]")?.innerText.includes(${JSON.stringify(SUBJECT.hannah)})`,
    "Edit closes the preview and puts the cursor in Hannah's draft",
  );
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(QUEUE)}).dataset.open`)) === "false" &&
      (await t.text(QUEUE)).includes(STUDENT.hannah),
    "with a draft open from the batch, the list folds to a header naming Hannah",
    await t.text(QUEUE),
  );
  await t.shot("batch-open-edit", null);
  await t.eval("history.back()");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 5 && document.querySelector('[data-testid="identical-drafts"]')`,
    "Back after Edit returns to the batch",
  );
  await t.click("Open Hannah", { within: '[data-testid="identical-drafts"]' });
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')?.innerText.includes(${JSON.stringify(SUBJECT.hannah)})`,
    "Open Hannah on the identical-drafts warning opens Hannah's draft",
  );
  await t.shot("identical-open-hannah", null);
  await t.click("Back to batch");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 5 && document.querySelector('[data-testid="identical-drafts"]')`,
    "Back to batch returns to the five drafts and the warning",
  );
  await atWidth(t, [1280, 720]);
  const offers = await t.eval(
    `[...document.querySelectorAll('[data-testid="identical-drafts"] button')].map((b) => { const r = b.getBoundingClientRect(); return b.innerText + (r.width > 0 && r.right <= innerWidth && r.bottom <= innerHeight ? "" : " (off screen)"); })`,
  );
  t.assert(
    offers.join() === "Open Aaliyah,Open Hannah",
    "at 1280x720 the warning offers to open each identical draft, on screen",
    JSON.stringify(offers),
  );
  await t.shot("batch-identical-drafts-1280", null);
  await t.click("Open Hannah", { within: '[data-testid="identical-drafts"]' });
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')?.innerText.includes(${JSON.stringify(SUBJECT.hannah)})`,
    "at 1280x720 Open Hannah opens her draft",
  );
  await t.eval("history.back()");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 5`,
    "at 1280x720 Back from her draft returns to the batch",
  );
  await atWidth(t, [1440, 900]);
  await t.click('[aria-label="Close batch"]');

  await singleItemClicks(t);
  await expandQueue(t);
  await t.click(`[aria-label="Select ${STUDENT.cody}"]`);
  await t.click(`[aria-label="Select ${LONG_NAME}"]`);
  await t.click(`[aria-label="Select ${STUDENT.aaliyah}"]`);
  await t.click(`[aria-label="Select ${STUDENT.hannah}"]`);
  await t.click(`[aria-label="Select ${STUDENT.kenji}"]`);
  await t.click("Review 2");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 2`,
    "the batch holds two changes",
  );
  await t.sleep(200);
  await assertNameReadable(t, `[data-batch-item]:first-child`, "batch item header at 1440");
  const approve = `${BATCH_HEADER} [data-approve]`;
  const send = `${BATCH_HEADER} button:not([data-approve]):not([aria-label])`;

  await t.eval(
    `void (window.__labels = [], new MutationObserver(() => window.__labels.push(document.querySelector(${JSON.stringify(approve)})?.innerText ?? "gone")).observe(document.querySelector(${JSON.stringify(BATCH_HEADER)}), { subtree: true, characterData: true, childList: true }))`,
  );
  const ticked = await t.clickAtOnce([`[aria-label="Select ${STUDENT.aaliyah}"]`, approve]);
  t.assert(
    ticked.length === 2 && ticked.every((click) => click.trusted) && ticked[1].gapMs < 150,
    `tick then Approve landed ${ticked[1]?.gapMs}ms apart as trusted clicks, inside the old 150ms window`,
    JSON.stringify(ticked),
  );
  t.assert(
    ticked[1]?.label === "Approve 3",
    "the button said Approve 3 at the moment of the click",
    JSON.stringify(ticked),
  );
  t.assert(
    await tagBecomes(t, SUBJECT.aaliyah, "approved"),
    "Approve right after ticking approves the newly selected item",
  );
  t.assert(
    (await tagOf(t, SUBJECT.long)) === "approved" && (await tagOf(t, SUBJECT.silas)) === "approved",
    "and the rest of the batch the button counted",
  );
  t.assert((await tagOf(t, SUBJECT.cody)) === "draft", "and no unselected item");
  const labels = await t.eval(`window.__labels`);
  t.assert(
    labels.join() === "Approve 3,gone",
    "the count moves once to 3 and the button goes, with no number flickering between",
    labels.join(),
  );
  await t.shot("approve-right-after-select", null);

  await t.click(`[aria-label="Select ${STUDENT.hannah}"]`);
  await t.click(`[aria-label="Select ${STUDENT.kenji}"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(approve)})?.innerText === "Approve 2"`,
    "two more selected, two to approve",
  );
  await t.sleep(200);
  const removed = await t.clickAtOnce([`[aria-label="Remove ${SUBJECT.kenji}"]`, approve]);
  t.assert(
    removed.length === 2 && removed[1].gapMs < 150,
    `remove then Approve landed ${removed[1]?.gapMs}ms apart`,
    JSON.stringify(removed),
  );
  t.assert(
    removed[1]?.label === "Approve 1",
    "the button said Approve 1 at the moment of the click",
    JSON.stringify(removed),
  );
  t.assert(
    await tagBecomes(t, SUBJECT.hannah, "approved"),
    "Approve right after removing still approves what's left",
  );
  t.assert((await tagOf(t, SUBJECT.kenji)) === "draft", "and never the item just removed");

  await t.sleep(200);
  const before = await writes(t);
  const sent = await t.clickAtOnce([`[aria-label="Remove ${SUBJECT.hannah}"]`, send]);
  t.assert(
    sent.length === 2 && sent[1].gapMs < 150,
    `remove then Send landed ${sent[1]?.gapMs}ms apart`,
    JSON.stringify(sent),
  );
  t.assert(
    sent[1]?.label === "Send 3",
    "the button said Send 3 at the moment of the click",
    JSON.stringify(sent),
  );
  t.assert(
    await tagBecomes(t, SUBJECT.aaliyah, "sent", 15_000),
    "Send right after removing acts on what's left",
  );
  t.assert(
    (await tagBecomes(t, SUBJECT.long, "sent", 15_000)) &&
      (await tagBecomes(t, SUBJECT.silas, "sent", 15_000)),
    "all three the button counted went",
  );
  t.assert((await tagOf(t, SUBJECT.hannah)) === "approved", "the item just removed did not send");
  const landed = await writes(t);
  t.assert(landed - before >= 3, "the fake LMS took the writes", `${before} then ${landed}`);
  await t.shot("send-right-after-select", null);
  await t.click('[aria-label="Close batch"]');
};

// Walking to the next row and approving at once acts on that row, and never on the one just left.
const singleItemClicks = async (t) => {
  await t.click(STUDENT.cody, { within: LIST });
  await t.waitFor(
    `document.querySelector("[data-focused]")?.innerText.includes(${JSON.stringify(SUBJECT.cody)})`,
    "Cody's draft is open",
  );
  await noAgent(t, "reopening is quiet");
  await t.click("Preview", { within: PANEL });
  await t.waitFor(
    `document.querySelector('${PANEL} [data-approve]')`,
    "the preview offers Approve",
  );
  await t.sleep(200);
  const clicks = await t.clickAtOnce([
    '[aria-label="Next in queue"]',
    `${PANEL} [role=tab]:nth-of-type(2)`,
    `${PANEL} [data-approve]`,
  ]);
  t.assert(
    clicks.length === 3 && clicks[2].label === "Approve" && clicks[2].gapMs < 150,
    `Next, Preview, Approve landed within ${clicks[2]?.gapMs}ms as one burst`,
    JSON.stringify(clicks),
  );
  t.assert(
    await tagBecomes(t, SUBJECT.silas, "approved"),
    "Approve right after moving on approves the item now on screen",
  );
  t.assert((await tagOf(t, SUBJECT.cody)) === "draft", "and not the item just left");
  await t.click("Undo approval");
  t.assert(await tagBecomes(t, SUBJECT.silas, "draft"), "Undo approval puts it back");
};

const templateEdge = async (t) => {
  await t.goto("/threads/t-queue");
  await t.click("Composition II");
  await t.waitFor(
    `document.querySelector('[data-testid="save-template"]')`,
    "the course overview offers Save as template",
  );
  await assertTemplateEdge(t, "course overview");
};

export const run = async (t) => {
  await longName(t);
  await selectionClicks(t);
  await templateEdge(t);
};
