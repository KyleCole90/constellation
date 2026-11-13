import { addAiKey, removeAiKey } from "./ai-key.mjs";
import { onboard } from "./onboard.mjs";

const QUEUE = '[data-testid="pinned-queue"]';
const LIST = '[data-testid="queue-list"]';
const CHAT = '[data-testid="chat"]';
const CARD = "[data-focused]";
const START = '[data-testid="queue-start"]';
const NEXT_ARROW = '[aria-label="Next in queue"]';
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });

const openTitles = `[...document.querySelectorAll('[data-row]')].filter((row) => !row.querySelector("input").disabled).map((row) => row.querySelector("button span[title]").innerText)`;
const gradeByChord = async (t, what) => {
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    `${what}: the chord reviews`,
  );
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-approve")`,
    `${what}: the chord stops at Approve`,
  );
  await t.key("Enter");
  await t.waitFor(`document.body.innerText.includes("Undo approval")`, `${what}: Enter approves`);
  await t.key("Meta+Enter");
  await t.waitFor(
    `[...document.querySelectorAll('button')].some((b) => b.innerText.startsWith("Next:"))`,
    `${what}: the receipt offers Next`,
  );
};
const settled = (t, label) =>
  t.waitFor(`!document.querySelector('[data-testid="agent-working"]')`, label);

const BATCH = 5;
const LIST_STATE = `(() => { const box = document.querySelector(${JSON.stringify(QUEUE)}).getBoundingClientRect(); return { height: box.height, card: Boolean(document.querySelector(${JSON.stringify(CARD)})), scrollTop: document.querySelector('[data-testid="queue-list"]').scrollTop }; })()`;

const batchDraft = async (t, queue) => {
  for (let i = 0; i < BATCH; i++)
    await t.click('[data-row] input[type="checkbox"]:not(:checked):not(:disabled)');
  await t.click(`Draft ${BATCH}`);
  const seen = [];
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    seen.push(await t.eval(LIST_STATE));
    const done = await t.eval(
      `[...document.querySelectorAll("button")].some((b) => b.innerText === "Review ${BATCH}")`,
    );
    if (done) break;
  }
  const shortest = Math.min(...seen.map((state) => state.height));
  t.assert(
    seen.length > 3 && shortest >= queue.height - 1,
    "the list keeps its whole page while a batch drafts",
    `${queue.height}px before, ${shortest}px at the shortest over ${seen.length} samples`,
  );
  t.assert(
    seen.every((state) => !state.card && state.scrollTop === 0),
    "no draft card opens and the list stays at the top while a batch drafts",
    JSON.stringify(seen.filter((state) => state.card || state.scrollTop !== 0).slice(0, 3)),
  );
  await t.click(`Review ${BATCH}`);
  await t.waitFor(
    `document.querySelector('[data-testid="batch-header"]')`,
    "Review opens the batch",
  );
  await t.shot("grading-list-batch-review");
  await t.eval("history.back()");
  await t.waitFor(
    `!document.querySelector('[data-testid="batch-header"]') && document.querySelector(${JSON.stringify(START)}) && document.body.innerText.includes("${BATCH} selected")`,
    "Back from the batch returns to the grading list, still ticked",
  );
  await t.eval("history.forward()");
  await t.waitFor(
    `document.querySelector('[data-testid="batch-header"]')`,
    "Forward reopens the batch",
  );
  t.assert(
    await t.eval(
      `(() => { const edge = document.querySelector(${JSON.stringify(QUEUE)}).getBoundingClientRect().right; return [...document.querySelectorAll(${JSON.stringify(`${QUEUE} button`)})].every((b) => b.scrollWidth <= b.clientWidth + 1 && b.getBoundingClientRect().right <= edge + 1); })()`,
    ),
    "every list header button fits beside the batch panel",
  );
  await t.click("Close batch");
  await t.click("Clear", { within: QUEUE });
};

export const run = async (t) => {
  await t.viewport(1440, 900);
  await t.goto("/welcome");
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await t.reload();
  await onboard(t);
  await t.waitFor(`location.pathname === "/due"`, "demo tokens land on What's due");
  await addAiKey(t);
  await t.waitFor(
    `location.pathname === "/threads/t-queue" && document.querySelector(${JSON.stringify(START)})`,
    "the grading list offers Start grading",
  );

  const queue = await t.box(QUEUE);
  const main = await t.box('[data-testid="thread-main"]');
  t.assert(
    !(await t.has(CHAT)) &&
      !(await t.has("[data-composer]")) &&
      Math.abs(queue.bottom - main.bottom) <= 1,
    "with nothing open the list is the whole page, with no chat or composer",
    JSON.stringify({ queue, main }),
  );

  const everyone = await t.eval(openTitles);
  await batchDraft(t, queue);
  t.assert(
    (await t.eval(
      `document.querySelector(${JSON.stringify(QUEUE)}).querySelectorAll('button[aria-pressed]').length`,
    )) <= 8,
    "assignments sit in one picker, so the chips stay one short row",
  );
  await t.click('[aria-label="Assignment"]');
  await t.click("HUM 150 Sequence Analysis", { within: '[data-testid="picker-popup"]' });
  const run = await t.eval(openTitles);
  t.assert(
    run.length >= 2 &&
      (await t.eval(
        `[...document.querySelectorAll('[data-row]')].every((row) => row.innerText.includes("HUM 150 · Sequence Analysis"))`,
      )),
    "an assignment chip keeps only that assignment",
    JSON.stringify(run),
  );
  const unfilteredNext = everyone[everyone.indexOf(run[0]) + 1];
  t.assert(
    unfilteredNext !== run[1],
    "the whole list would go somewhere else after the first one, so the check below means something",
    `${unfilteredNext} vs ${run[1]}`,
  );
  await t.shot("grading-list-filtered");

  await t.click(START);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes(${JSON.stringify(run[0])})`,
    "Start grading opens the first submission in the filter",
  );
  await settled(t, "first submission drafted");
  t.assert(!(await t.has(START)), "Start grading goes once a submission is open");

  await gradeByChord(t, "filtered");
  const offered = await t.eval(
    `[...document.querySelectorAll('button')].find((b) => b.innerText.startsWith("Next:")).innerText`,
  );
  t.assert(
    offered.split("\n")[0] === `Next: ${run[1]}`,
    "Next stays inside the assignment the teacher filtered to",
    `${offered}; filtered ${JSON.stringify(run)}`,
  );
  await t.shot("grading-list-next-in-filter");

  await startOnTicked(t);
  await missingWork(t);
  await lateWaiveAndOverride(t);
  await missingExcused(t);
  await removeAiKey(t);
  await missingZeroAiOff(t);
};

const tick = (t, title) =>
  t.eval(
    `[...document.querySelectorAll('[data-row]')].find((row) => row.querySelector("button span[title]")?.innerText === ${JSON.stringify(title)}).querySelector('input[type="checkbox"]').click()`,
  );

/** Start grading and Next walk the rows the teacher ticked, in list order, skipping the rest. */
const AWAY = "/threads/t-h150-seq";

const startOnTicked = async (t) => {
  await t.goto(AWAY);
  await t.click("Show 1 more", { within: '[data-testid="sidebar"]' });
  await t.click("Grade Film Response 3", { within: '[data-testid="sidebar"]' });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(START)})`,
    "ticked: the list offers Start grading",
  );
  const titles = await t.eval(openTitles);
  t.assert(titles.length >= 4, "ticked: the list has rows to skip", JSON.stringify(titles));
  await tick(t, titles[3]);
  await tick(t, titles[1]);
  await t.waitFor(`document.body.innerText.includes("2 selected")`, "ticked: two rows are ticked");
  await t.shot("grading-list-ticked", null);
  await t.click(START);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})`,
    "ticked: Start grading opens a card",
  );
  const opened = await t.text(CARD);
  await t.shot("grading-list-ticked-start", null);
  t.assert(
    opened.includes(titles[1]),
    "ticked: Start grading opens the first ticked row",
    `opened ${opened.split("\n")[0]}; ticked ${titles[1]}, ${titles[3]}`,
  );
  const place = () => t.text('[data-testid="queue-progress"]');
  const cardShows = (title, label) =>
    t.waitFor(
      `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes(${JSON.stringify(title)})`,
      label,
    );
  t.assert(
    (await place()) === "1 of 2",
    "ticked: the header counts the ticked rows",
    await place(),
  );
  await t.click(NEXT_ARROW);
  await cardShows(titles[3], "ticked: the header arrow goes to the other ticked row");
  t.assert((await place()) === "2 of 2", "ticked: the header places the second", await place());
  t.assert(
    await t.eval(`document.querySelector(${JSON.stringify(NEXT_ARROW)}).disabled`),
    "ticked: the header arrow stops at the last ticked row",
  );
  await t.eval("history.back()");
  await cardShows(titles[1], "ticked: Back after the arrow returns to the row before");
  await t.eval("history.forward()");
  await cardShows(titles[3], "ticked: Forward returns to the row the arrow opened");
  t.assert((await place()) === "2 of 2", "ticked: coming back keeps the ticked run", await place());
  await t.click('[aria-label="Previous in queue"]');
  await cardShows(titles[1], "ticked: the header's Previous walks back to the first ticked row");
  t.assert((await place()) === "1 of 2", "ticked: Previous restores the place", await place());
  await settled(t, "ticked: first ticked row drafted");
  await gradeByChord(t, "ticked");
  const offered = await t.eval(
    `[...document.querySelectorAll('button')].find((b) => b.innerText.startsWith("Next:"))?.innerText ?? ""`,
  );
  await t.shot("grading-list-ticked-next", null);
  t.assert(
    offered.split("\n")[0] === `Next: ${titles[3]}`,
    "ticked: Next skips to the other ticked row",
    `${offered}; ticked ${titles[1]}, ${titles[3]}`,
  );
  t.assert(
    (await place()) === "1 of 2",
    "ticked: a sent row keeps its place in the count",
    await place(),
  );
  await t.click(NEXT_ARROW);
  await cardShows(titles[3], "ticked: after a send the header arrow agrees with Next");
};

const FIONA = "[data-row]:last-of-type";

/** The teacher can write to a missing student without grading, and the message still waits for Approve. */
const messageMissing = async (t) => {
  await t.click('[aria-label="Message Fiona Kerr"]', { within: QUEUE });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${CARD} textarea`)})?.value.startsWith("Hi Fiona")`,
    "Message drafts a note to her",
  );
  await settled(t, "her message drafted");
  const card = await t.text(CARD);
  t.assert(
    card.includes("Subject: Sequence Analysis") &&
      !(await t.has(`${CARD} [data-typed-score]`)) &&
      !(await t.has(`${CARD} [data-criterion]`)),
    "the card is a message about the assignment, with no score to fill",
    card,
  );
  await t.shot("grading-list-missing-message-draft", null);
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-approve")`,
    "the chord stops at Approve",
  );
  await t.key("Enter");
  await t.waitFor(
    `document.body.innerText.includes("Undo approval")`,
    "Enter approves her message",
  );
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes("Written to riverbend.instructure.com")`,
    "her message is sent through the usual path",
  );
  await t.shot("grading-list-missing-message-sent", null);
  await t.click('[aria-label="Expand queue"]');
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${QUEUE} ${FIONA}`)})?.innerText.includes("Missing")`,
    "a message leaves her ungraded, still Missing",
  );
};

/** A student with nothing turned in is a row the teacher can settle with a zero, through the usual approval. */
const missingWork = async (t) => {
  await t.goto("/threads/t-h150-seq");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${QUEUE} ${FIONA}`)})?.innerText.includes("Fiona Kerr")`,
    "Fiona Kerr, who turned nothing in, is the last row of her assignment's list",
  );
  t.assert(
    (await t.text(`${QUEUE} ${FIONA}`)).includes("Missing") &&
      !(await t.eval(`document.body.innerText.includes("hasn't turned anything in.")`)),
    "her row is marked Missing, and no sentence stands in for it",
  );
  const order = await t.eval(queueTitles);
  await t.click("Missing", { within: QUEUE });
  t.assert(
    JSON.stringify(await t.eval(openTitles)) === JSON.stringify(["Fiona Kerr"]),
    "the Missing chip keeps only her",
    JSON.stringify(await t.eval(openTitles)),
  );
  await t.shot("grading-list-missing-row", null);

  await messageMissing(t);

  await t.click("Fiona Kerr", { within: QUEUE });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${CARD} textarea`)})?.value.includes("recorded a zero")`,
    "opening her drafts a zero that says why",
  );
  await settled(t, "her zero drafted");
  t.assert(
    !(await t.eval(
      `document.querySelector(${JSON.stringify(`${CARD} textarea`)}).value.includes("thank you for submitting")`,
    )),
    "the draft does not thank her for work she never turned in",
  );
  await t.shot("grading-list-missing-zero-draft", null);
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "the chord reviews her zero",
  );
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-approve")`,
    "the chord stops at Approve",
  );
  await t.key("Enter");
  await t.waitFor(`document.body.innerText.includes("Undo approval")`, "Enter approves her zero");
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes("Written to riverbend.instructure.com")`,
    "her zero is sent through the usual path",
  );
  await t.shot("grading-list-missing-zero-sent", null);
  await keepsPlaceAfterSend(t, order);
};

const queueTitles = `[...document.querySelectorAll(${JSON.stringify(`${QUEUE} [data-row]`)})].map((row) => row.querySelector("button span[title]").innerText)`;
const fionaRow = `[...document.querySelectorAll(${JSON.stringify(`${QUEUE} [data-row]`)})].find((row) => row.querySelector("button span[title]")?.innerText === "Fiona Kerr")`;

/** Her zero posting turns her Missing into graded in the LMS, but she keeps her place, so Next stays off on the last row (#204). */
const keepsPlaceAfterSend = async (t, order) => {
  if (!(await t.has(LIST))) await t.click("Expand queue");
  await t.waitFor(
    `${fionaRow} && !${fionaRow}.innerText.includes("Missing")`,
    "the posted zero syncs back and her row is no longer Missing",
    10_000,
  );
  const after = await t.eval(queueTitles);
  t.assert(
    JSON.stringify(after) === JSON.stringify(order),
    "every row keeps its place after her zero posts",
    `${JSON.stringify(order)} before, ${JSON.stringify(after)} after`,
  );
  await t.shot("grading-list-missing-zero-synced", null);
  await t.click("Collapse queue");
  t.assert(
    await t.eval(`document.querySelector('[aria-label="Next in queue"]').disabled`),
    "Next stays off on her, the last row",
  );
  t.assert(
    !(await t.eval(`document.querySelector('[aria-label="Previous in queue"]').disabled`)),
    "Previous still goes back up the list",
  );
  await t.shot("grading-list-missing-zero-synced-strip", null);
};

const LAST = `${QUEUE} [data-row]:last-of-type`;
const FORM = `[data-change]${CARD}`;
const RECEIPT = `${FORM} [data-testid="receipt"]`;

const openLastMissing = async (t, thread, what) => {
  await t.goto(`/threads/${thread}`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(LAST)})?.innerText.includes("Missing")`,
    `${what}: the list ends with a missing student`,
  );
  const name = (await t.text(`${LAST} button span[title]`)).trim();
  await t.click(`${LAST} button`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(FORM)})?.innerText.includes(${JSON.stringify(name)})`,
    `${what}: opening ${name} shows a form`,
  );
  return name;
};

/** The submission panel can cover the card, so the first ⌘↵ may only open the preview. */
const chordSends = async (t, what) => {
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(RECEIPT)}) || document.querySelector('[data-testid="writeback-scroll"]')`,
    `${what}: ⌘↵ reviews or sends`,
  );
  if (!(await t.has(RECEIPT))) await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(RECEIPT)})`,
    `${what}: one ⌘↵ approves and sends it`,
    20_000,
  );
};

const SETTLED = `Promise.allSettled(document.getAnimations().filter((a) => a.effect.getTiming().iterations !== Infinity).map((a) => a.finished)).then(() => null)`;
const FOOTER_ROW = `(() => { const bar = document.querySelector(${JSON.stringify(`${FORM} [data-testid="card-actions"]`)}); const first = bar.querySelector("button").getBoundingClientRect(); const approve = bar.querySelector("[data-approve]").getBoundingClientRect(); return { panel: Boolean(document.querySelector("[data-panel-scroll]")), sameRow: Math.abs(first.top + first.height / 2 - approve.top - approve.height / 2) < 1, approveRight: approve.right, barRight: bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight) }; })()`;

/** With the submission panel open the footer may wrap, but the primary pair stays together on the right. */
const footerKeepsPairRight = async (t) => {
  for (const [width, height] of [
    [1180, 800],
    [1440, 900],
  ]) {
    await t.viewport(width, height);
    await t.eval(SETTLED);
    const footer = await t.eval(FOOTER_ROW);
    t.assert(
      footer.panel && footer.sameRow && footer.approveRight >= footer.barRight - 1,
      `AI off at ${width}: with the submission panel open the actions share one row, Approve and send at the right edge`,
      JSON.stringify(footer),
    );
  }
};

/** With AI off nothing drafts the zero, so one Zero click fills every criterion. A zero stops at the preview; a commented 1 sends on one ⌘↵. */
const missingZeroAiOff = async (t) => {
  await openLastMissing(t, "t-e101-essay2", "AI off");
  t.assert(await t.has(`${FORM} [data-criterion]`), "AI off: Essay 2 is graded on a rubric");
  await t.click("Zero", { within: FORM });
  const scores = `[...document.querySelectorAll(${JSON.stringify(`${FORM} [data-criterion] [data-typed-score]`)})].map((input) => input.value)`;
  await t.waitFor(
    `${scores}.length > 0 && ${scores}.every((value) => value === "0")`,
    "AI off: Zero sets every criterion to 0",
  );
  t.assert(
    (await t.text(`${FORM} [data-testid="draft-grade"]`)).includes("0"),
    "AI off: the total reads 0",
  );
  const offersChord = `Boolean(document.querySelector(${JSON.stringify(`${FORM} [data-testid="card-actions"] [data-approve]`)})?.innerText.startsWith("Approve and send"))`;
  await settled(t, "AI off zero");
  await t.shot("grading-list-missing-zero-card", null);
  t.assert(!(await t.eval(offersChord)), "AI off: a zero offers no Approve and send on the card");
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "AI off: ⌘↵ on a zero opens the preview",
  );
  await t.sleep(300);
  t.assert(
    !(await t.has(RECEIPT)) && !(await t.pageText()).includes("Undo approval"),
    "AI off: ⌘↵ on a zero sends nothing",
  );
  await t.shot("grading-list-missing-zero-stops", null);
  await t.click(`[data-testid="thread-panel"] [role="tab"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(FORM)}) && document.querySelector("[data-panel-scroll]") && document.querySelector(${JSON.stringify(`${FORM} textarea`)})`,
    "AI off: the submission tab opens the form back up",
  );
  await t.eval(`document.querySelector(${JSON.stringify(`${FORM} textarea`)}).focus()`);
  await t.type("Nothing came in, so this is a zero for now.");
  await t.key("Tab");
  await settled(t, "AI off commented zero");
  t.assert(
    !(await t.eval(offersChord)),
    "AI off: a commented zero still offers no Approve and send",
  );
  await t.eval(
    `(() => { const input = document.querySelector(${JSON.stringify(`${FORM} [data-criterion] [data-typed-score]`)}); input.focus(); input.select(); })()`,
  );
  await t.type("1");
  await t.key("Enter");
  await t.waitFor(offersChord, "AI off: a commented 1 offers Approve and send again");
  await footerKeepsPairRight(t);
  await t.shot("grading-list-missing-one-ai-off", null);
  await chordSends(t, "AI off");
};

/** A documented absence is excused instead of zeroed, drops the agent's zero note, and goes through the same approval. */
const missingExcused = async (t) => {
  await openLastMissing(t, "t-e101-rr6", "excuse");
  const comment = `document.querySelector(${JSON.stringify(`${FORM} textarea`)})?.value`;
  await t.waitFor(
    `${comment}?.includes("recorded a zero")`,
    "excuse: the agent drafts a zero note",
  );
  await settled(t, "excuse: the zero drafted");
  await t.click("Excuse", { within: FORM });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${FORM} [data-testid="draft-grade"]`)})?.innerText.includes("Excused")`,
    "Excuse makes the grade read Excused",
  );
  t.assert(
    !(await t.eval(`${comment}?.includes("recorded a zero")`)),
    "Excuse drops the agent's note that a zero was recorded",
    await t.eval(comment),
  );
  await t.shot("grading-list-missing-excused-draft", null);
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "excuse: ⌘↵ reviews",
  );
  t.assert(
    !(await t.text('[data-testid="writeback-scroll"]')).includes("recorded a zero"),
    "excuse: the preview sends no zero note",
  );
  await t.shot("grading-list-missing-excused-preview", null);
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-approve")`,
    "excuse: ⌘↵ stops at Approve",
  );
  await t.key("Enter");
  await t.waitFor(`document.body.innerText.includes("Undo approval")`, "excuse: Enter approves");
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(RECEIPT)})`,
    "excuse: ⌘↵ sends it",
    20_000,
  );
  await t.shot("grading-list-missing-excused-sent", null);
};

const TOTAL = `${FORM} [data-testid="draft-grade"]`;
const totalNumber = async (t) => Number((await t.text(TOTAL)).match(/[\d.]+/)?.[0]);

/** An extension waives the late penalty, and the teacher's own total overrides the scores. Both wait for Approve. */
const lateWaiveAndOverride = async (t) => {
  await t.goto("/threads/t-e102-bib");
  const late = `[...document.querySelectorAll(${JSON.stringify(`${QUEUE} [data-row]`)})].find((row) => /late/i.test(row.innerText))`;
  await t.waitFor(late, "the bibliography lists a late submission");
  const name = await t.eval(`${late}.querySelector("button span[title]").innerText.trim()`);
  await t.eval(`${late}.querySelector("button").click()`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(FORM)})?.innerText.includes("Late penalty")`,
    "the late draft shows its penalty",
  );
  await settled(t, "the late draft");
  await t.shot("grading-list-late-draft", null);
  const penalised = await totalNumber(t);
  await t.click("Waive late penalty", { within: FORM });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(FORM)})?.innerText.includes("waived")`,
    "Waive marks the penalty waived",
  );
  const waived = await totalNumber(t);
  t.assert(waived > penalised, "the waived total drops the penalty", `${penalised} -> ${waived}`);
  await t.shot("grading-list-late-waived", null);
  await t.click("Override total", { within: FORM });
  const input = `${FORM} [aria-label="Type total"]`;
  await t.waitFor(
    `document.querySelector(${JSON.stringify(input)})`,
    "Override offers a total to type",
  );
  await t.eval(`document.querySelector(${JSON.stringify(input)}).select()`);
  await t.type("45");
  await t.key("Tab");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(input)})?.value === "45" && document.querySelector(${JSON.stringify(FORM)}).innerText.includes("Your total")`,
    "the typed total stands in for the scores",
  );
  await t.shot("grading-list-late-override", null);
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')?.innerText.includes("Your total")`,
    "the preview shows the override and why",
  );
  await t.shot("grading-list-late-override-preview", null);
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-approve")`,
    "the chord stops at Approve",
  );
  await t.key("Enter");
  await t.waitFor(
    `document.body.innerText.includes("Undo approval")`,
    "Enter approves the override",
  );
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.body.innerText.includes("Written to")`,
    "the override is sent through the usual path",
    20_000,
  );
  const lms = await t.eval(
    `(async () => JSON.parse(await window.__faultLab.stored()).submissions.find((s) => s.studentName === ${JSON.stringify(name)} && s.ref.includes("310588"))?.grade ?? null)()`,
  );
  t.assert(lms === 45, `the LMS holds the teacher's total for ${name}`, String(lms));
  await t.shot("grading-list-late-override-sent", null);
};
