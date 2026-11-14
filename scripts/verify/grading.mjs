import { addAiKey } from "./ai-key.mjs";
import { expandCourse } from "./sidebar.mjs";
import { onboard } from "./onboard.mjs";

const LIST = '[data-testid="queue-list"]';
const QUEUE = '[data-testid="pinned-queue"]';
const PANEL = '[data-testid="thread-panel"]';
const CHAT = '[data-testid="chat"]';
const CARD = "[data-focused]";
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const TOKEN = "verify-reconnect-token-5f3a91c2e7";

const lms = (t, expression) =>
  t.eval(
    `(async () => { const lms = JSON.parse(await window.__faultLab.stored()); return ${expression}; })()`,
  );
const submissionIn = (student, short) =>
  `lms.submissions.find((s) => s.studentName === ${JSON.stringify(student)} && s.assignment === lms.assignments.find((a) => a.shortTitle === ${JSON.stringify(short)})?.ref)`;
const myComments = (t, student, short) =>
  lms(t, `${submissionIn(student, short)}.comments.filter((c) => c.mine).length`);
const gradeInLms = (t, student, short) => lms(t, `${submissionIn(student, short)}.grade`);

const tagOf = (t, subject) =>
  t.eval(
    `Object.values(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).find((c) => c.subject === ${JSON.stringify(subject)})?.state.tag ?? null`,
  );
const lab = (t, call) => t.eval(`void window.__faultLab.${call}`);
const refOf = (student, short) =>
  `(await window.__faultLab.findSubmission(${JSON.stringify(student)}, ${JSON.stringify(short)}))`;

const settled = (t, label) =>
  t.waitFor(`!document.querySelector('[data-testid="agent-working"]')`, label);

const OPEN = '[data-testid="grade-open"]';
const savedChanges = `Object.keys(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).length`;

/** Opening spends nothing: the submission shows with the two choices, no agent runs, and no change is saved (#48). */
const opensUndrafted = async (t, student, label) => {
  await t.waitFor(
    `document.querySelector(${JSON.stringify(OPEN)})?.innerText.includes(${JSON.stringify(student)})`,
    `${label}: opens on the submission with Draft with Claude and Grade it yourself`,
  );
  const before = await t.eval(savedChanges);
  await t.sleep(400);
  t.assert(
    !(await t.has('[data-testid="agent-working"]')) &&
      !(await t.has(CARD)) &&
      (await t.eval(savedChanges)) === before &&
      /Draft with Claude/.test(await t.text(OPEN)) &&
      /Grade it yourself/.test(await t.text(OPEN)),
    `${label}: opening drafts nothing, so it spends no model call (#48)`,
    await t.text(OPEN),
  );
};

const draftWithClaude = (t) => t.click("Draft with Claude", { within: OPEN });

const expandQueue = async (t) => {
  if (!(await t.has(LIST))) await t.click("Expand queue");
  await t.waitFor(`document.querySelector(${JSON.stringify(LIST)})`, "queue list is showing");
};

const openStudent = async (t, student, short) => {
  await expandQueue(t);
  await t.click(`${student}`, { within: LIST });
  const drafted = `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes(${JSON.stringify(`${student}, ${short}`)})`;
  await t.waitFor(
    `${drafted} || document.querySelector(${JSON.stringify(OPEN)})?.innerText.includes(${JSON.stringify(student)})`,
    `${student}: opens`,
  );
  if (!(await t.eval(drafted))) {
    await opensUndrafted(t, student, student);
    await draftWithClaude(t);
  }
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes(${JSON.stringify(`${student}, ${short}`)})`,
    `${student}: draft appears`,
  );
  await settled(t, `${student}: agent finished`);
  t.assert(
    !(await t.has(`${CARD} [data-card-line]`)) && /\b[A-Z]+ \d+\b/.test(await t.text("main")),
    `${student}: the course shows above the card, and the card doesn't repeat it`,
    await t.text("main"),
  );
};

const threadMessages = `JSON.parse(localStorage.getItem("lms-app.v1")).state.threads[decodeURIComponent(location.pathname.split("/threads/")[1])].messages`;

const ask = async (t, request) => {
  const before = await t.eval(`${threadMessages}.length`);
  await t.click("[data-composer]");
  await t.type(request);
  await t.key("Enter");
  await t.waitFor(`${threadMessages}.length > ${before + 1}`, `"${request}" gets an answer`);
  await settled(t, `"${request}": agent finished`);
  await t.eval(`document.activeElement?.blur()`);
  return t.eval(
    `${threadMessages}.slice(${before + 1}).map((m) => ({ text: m.text, edited: m.edited ?? [] }))`,
  );
};
const chips = (replies) => replies.flatMap((reply) => reply.edited);
const chipsOnScreen = (t) =>
  t.eval(`[...document.querySelectorAll('${CHAT} [data-edited] li')].map((li) => li.innerText)`);

/** A correction answers with the words that moved, in this rubric's own names. */
const speechCorrections = async (t) => {
  const visual = await ask(t, "make visual aid 15");
  t.assert(
    chips(visual).some((c) => c.label === "Visual aid" && c.to === "15"),
    '"make visual aid 15" sets Visual aid',
    JSON.stringify(visual),
  );
  const both = await ask(t, "please raise the grade by 3 points and mention the video");
  t.assert(
    chips(both).some((c) => c.label === "Feedback" && c.from === "" && c.to.includes("the video")),
    "a two-part request does both, and the feedback chip shows only the added sentence",
    JSON.stringify(both),
  );
  const warmer = await ask(t, "make it warmer");
  t.assert(
    chips(warmer).some((c) => c.label === "Feedback" && c.from === "" && /^I can see/.test(c.to)),
    '"make it warmer" shows only the new closing, not the whole comment twice',
    JSON.stringify(warmer),
  );
  await t.shot("speech-corrections");
  const help = await ask(t, "what can you do");
  t.assert(
    help.some((m) => m.text.includes('"content and organization should be 32"')) &&
      !help.some((m) => /thesis|analysis/.test(m.text)),
    "the help names this rubric's criteria",
    JSON.stringify(help),
  );
};

const writeBackTab = (t) => t.click("Preview", { within: PANEL });

const approve = async (t, subject) => {
  await t.click("[data-approve]");
  await t.waitFor(
    `document.body.innerText.includes("Undo approval")`,
    `${subject}: approval lands`,
  );
};

const sendAndWaitSent = async (t, subject, timeout) => {
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]') || [...document.querySelectorAll(${JSON.stringify(CARD)})].some((card) => card.innerText.includes(${JSON.stringify(subject)}) && card.innerText.includes("Written to"))`,
    `${subject}: shows as sent`,
    timeout,
  );
  t.assert((await tagOf(t, subject)) === "sent", `${subject}: state is sent`);
};

const openAndApprove = async (t, student, short) => {
  await openStudent(t, student, short);
  await writeBackTab(t);
  await approve(t, `${student}, ${short}`);
};

const clickSend = (t) => t.click("Send to", { within: PANEL });

const inView = (selector, scroller) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const box = document.querySelector(${JSON.stringify(scroller)});
  if (!el || !box) return false;
  const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
})()`;

const notClaimingToSend = async (t, tag) =>
  t.assert(
    !(await t.text(PANEL)).includes("Sending to"),
    `${tag}: the panel doesn't claim to be sending under a recovery banner`,
  );

const assertCrumbsFit = async (t, tag) =>
  t.assert(
    await t.eval(
      `(() => { const nav = document.querySelector('[data-testid="screen-crumbs"]'); return nav.scrollWidth <= nav.clientWidth; })()`,
    ),
    `${tag}: the breadcrumb fits beside the header actions`,
  );

const assertLayout = async (t, width, height, tag) => {
  await t.viewport(width, height);
  await t.sleep(200);
  const sidebar = await t.box('[data-testid="sidebar"]');
  const header = await t.box('[data-testid="screen-header"]');
  const main = await t.box('[data-testid="thread-main"]');
  const queue = await t.box(QUEUE);
  const chat = await t.box(CHAT);
  const composer = await t.box("[data-composer]");
  const sidebarWidth = width < 1280 ? 48 : 288;
  t.assert(
    sidebar?.width === sidebarWidth,
    `${tag}: sidebar is ${sidebarWidth}px`,
    JSON.stringify(sidebar),
  );
  t.assert(
    header?.height === 40 && header.y === 0,
    `${tag}: header is 40px at the top`,
    JSON.stringify(header),
  );
  t.assert(
    Boolean(queue) && queue.y === header.bottom,
    `${tag}: queue sits directly under the header`,
    JSON.stringify(queue),
  );
  if (await t.has('[data-testid="queue-start"]')) {
    t.assert(
      !chat && !composer && Math.abs(queue.bottom - main.bottom) <= 1,
      `${tag}: with nothing open the list is the whole page, with no chat or composer`,
      JSON.stringify({ queue, main }),
    );
  } else {
    t.assert(
      Boolean(chat) && chat.y >= queue.bottom - 1,
      `${tag}: chat starts below the queue`,
      JSON.stringify(chat),
    );
    t.assert(
      composer.bottom <= height && composer.y >= chat.bottom - 1,
      `${tag}: composer is below the chat and on screen`,
      JSON.stringify(composer),
    );
    t.assert(
      height - composer.bottom < 70,
      `${tag}: composer stays at the bottom`,
      String(height - composer.bottom),
    );
  }
  t.assert(
    main.right <= width && sidebar.right <= main.x,
    `${tag}: main doesn't overlap the sidebar or run off screen`,
  );
  const panel = await t.box(PANEL);
  if (panel)
    t.assert(
      panel.right <= width + 0.5 && panel.x >= main.right - 0.5,
      `${tag}: panel sits beside main`,
      JSON.stringify(panel),
    );
};

const setup = async (t) => {
  await t.viewport(1440, 900);
  await t.goto("/welcome");
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await t.reload();
  await t.shot("welcome");
  await onboard(t);
  await t.waitFor(`location.pathname === "/due"`, "/ redirects to What's due with no AI key");
  await addAiKey(t);
  t.assert(
    (await t.eval(`location.pathname`)) === "/threads/t-queue",
    "What's due opens the grading list",
  );
  const rows = await t.eval(`document.querySelectorAll('[data-row]').length`);
  t.assert(rows === 32, "queue shows 32 rows", String(rows));
  await t.shot("queue-expanded");
};

const pinnedQueue = async (t) => {
  await assertLayout(t, 1440, 900, "1440x900 queue");
  await assertLayout(t, 1180, 800, "1180x800 queue");
  await t.viewport(1440, 900);
  await t.wheel(LIST, 800);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(LIST)}).scrollTop > 0`,
    "queue list scrolls on its own",
  );
  t.assert(
    !(await t.text(QUEUE)).match(
      /(Not started|[Dd]raft, not sent|Ready to send|Needs attention)\s*\d/,
    ),
    "no chip offers a state that narrows nothing while every row has no draft",
    await t.text(QUEUE),
  );
  const crossCourse = await t.text(`${LIST} [data-row]`);
  t.assert(
    /[A-Z]+ \d+ · \S/.test(crossCourse) &&
      /Due [A-Z][a-z]+ \d+/.test(crossCourse) &&
      /\b(LCC|RSU)\b/.test(crossCourse),
    "a row in the grading list keeps what differs: course, assignment, labelled due date, school",
    crossCourse,
  );
  await t.click("RSU", { within: QUEUE });
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('[data-row]')].every((row) => row.innerText.includes("RSU"))`,
    )) === true,
    "school chip keeps only that school",
  );
  await t.click("All", { within: QUEUE });
  t.assert(
    await t.has('[data-testid="queue-start"]'),
    "with nothing open the list offers Start grading",
  );
  await t.click("All", { within: QUEUE });

  await openStudent(t, "Maya Ortiz", "Essay 2");
  t.assert(
    !(await t.has('[data-testid="queue-start"]')),
    "Start grading goes once a submission is open",
  );
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(QUEUE)}).dataset.open`)) === "false",
    "opening a submission collapses the queue",
  );
  const strip = (await t.text(QUEUE)).replace(/\s+/g, " ");
  t.assert(
    strip.includes("Maya Ortiz") && strip.indexOf("Maya Ortiz") < strip.indexOf("8 of 32 · 0 sent"),
    "collapsed queue names the current student first, then the place in the queue and what's sent",
    strip,
  );
  t.assert(
    /[\d,]+ words/.test(await t.text(PANEL)) &&
      (await t.text("[data-excerpt-note]")) === "Excerpts",
    "a submission pane holding less than its word count says Excerpts",
    await t.text(PANEL),
  );
  await t.shot("draft-open");
  const STATUS = `[...document.querySelectorAll('${CARD} [id^="card-head-"] [data-slot="badge"]')].at(-1)?.innerText`;
  const cardStatus = () => t.eval(STATUS);
  t.assert(
    (await cardStatus()) === "AI draft. Not sent",
    "an AI draft you haven't touched says so",
    await cardStatus(),
  );
  await t.shot("ai-draft-untouched");
  await t.click(`${CARD} [data-edit-field]`);
  await t.eval(`document.activeElement.setSelectionRange(1e6, 1e6)`);
  await t.type(" Well done.");
  await t.eval(`document.activeElement?.blur()`);
  await t.waitFor(
    `${STATUS} === "AI draft, edited by you. Not sent"`,
    "once you edit the comment, the card says the AI draft has your edits",
  );
  await t.shot("ai-draft-edited-by-you");
  await assertLayout(t, 1180, 800, "1180x800 draft");
  await t.shot("draft-1180-typical-name");
  await t.viewport(1440, 900);

  await expandQueue(t);
  const MORE = '[data-testid="queue-more"]';
  const hiddenBelow = `(() => { const list = document.querySelector(${JSON.stringify(LIST)}).getBoundingClientRect(); return [...document.querySelectorAll("[data-row]")].filter((row) => row.getBoundingClientRect().bottom > list.bottom + 1).length; })()`;
  // The list refits its height a frame after the card resizes, so a count read before it settles is off by the rows the refit adds or takes away.
  const { below, cue } = await t.steady(
    `({ below: ${hiddenBelow}, cue: document.querySelector(${JSON.stringify(MORE)})?.innerText })`,
  );
  t.assert(
    below > 0 && cue === `${below} more below`,
    "a list that cuts rows off counts the ones below it",
    cue,
  );
  await t.click(MORE);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(MORE)})?.innerText === "${below - 1} more below"`,
    "the cue brings the next row into view and counts down",
  );
  await t.eval(`document.querySelector(${JSON.stringify(LIST)}).scrollTop = 1e6`);
  await t.waitFor(
    `/^\\d+ more above$/.test(document.querySelector(${JSON.stringify(MORE)})?.innerText ?? "")`,
    "scrolled to the end, the cue points back up",
  );
  await t.click("AI draft, edited by you, not sent", { within: QUEUE });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(MORE)})`,
    "the cue goes once every row shows",
  );
  const filtered = await t.eval(
    `[...document.querySelectorAll('[data-row]')].map((row) => row.innerText)`,
  );
  t.assert(
    filtered.length === 1 &&
      filtered[0].includes("Maya Ortiz") &&
      filtered[0].includes("AI draft, edited by you. Not sent"),
    "the AI draft chip keeps only the drafted row, in the words the row uses",
    JSON.stringify(filtered),
  );
  await writeBackTab(t);
  await t.click("[data-approve]");
  await t.waitFor(
    `document.querySelectorAll('[data-row]').length === 32`,
    "approving the filter's last row brings the whole list back",
  );
  t.assert(
    (await t.text(`${QUEUE} button[aria-pressed="true"]`)).startsWith("All"),
    "the All chip is the one pressed once a filter runs out",
  );
  t.assert(
    (await t.text(QUEUE)).includes("Ready to send"),
    "the chip and the row both say Ready to send",
  );
  await t.click("Undo approval");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(QUEUE)}).innerText.includes("Needs approval again") && !document.body.innerText.includes("Undo approval")`,
    "undoing the approval puts the row back",
  );
  t.assert(
    (await t.eval(`document.querySelectorAll('[data-row]').length`)) === 32,
    "a filter that ran out does not narrow the list again when a row returns to it",
  );
  await t.click("Submission", { within: PANEL });
  await t.click("Collapse queue");

  const before = await t.box(QUEUE);
  await t.wheel(CHAT, 5000);
  await t.waitFor(`document.querySelector(${JSON.stringify(CHAT)}).scrollTop > 0`, "chat scrolls");
  await t.waitFor(
    `(() => { const c = document.querySelector(${JSON.stringify(CHAT)}); return c.scrollHeight - c.scrollTop - c.clientHeight < 2; })()`,
    "chat reaches the bottom",
  );
  const after = await t.box(QUEUE);
  t.assert(
    after.y === before.y && after.height === before.height,
    "queue did not move while the chat scrolled",
  );
  t.assert(
    (await t.eval(
      `(() => { const r = document.querySelector(${JSON.stringify(QUEUE)}).getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return document.querySelector(${JSON.stringify(QUEUE)}).contains(top); })()`,
    )) === true,
    "queue is still on top and visible with the chat at its bottom",
  );
  t.assert(
    (await t.eval(`getComputedStyle(document.documentElement).overscrollBehaviorY`)) === "none",
    "scrolling past the end of the chat can't bounce the app",
  );
  await t.shot("chat-scrolled-queue-pinned");

  await t.click("Expand queue");
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(QUEUE)}).dataset.open`)) === "true",
    "the queue expands again on demand",
  );
  await t.click("Collapse queue");
  await t.reload();
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})`,
    "reload returns to the same draft",
  );
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(QUEUE)}).dataset.open`)) === "false",
    "collapsed queue is remembered across reload",
  );
  t.assert(await t.has(PANEL), "panel state is remembered across reload");
};

const rationale = async (t) => {
  const criteria = `[...document.querySelectorAll('${CARD} [data-criterion]')]`;
  t.assert((await t.eval(`${criteria}.length`)) === 4, "each of the four criteria has a row");
  t.assert(
    (await t.eval(`document.querySelectorAll('${PANEL} mark.passage').length`)) >= 4,
    "the document has highlighted passages",
  );

  const pairs = await t.eval(
    `${criteria}.map((row) => ({ row: row.querySelector("[data-row-number]")?.innerText, passage: [...document.querySelectorAll('${PANEL} mark.passage[data-number]')].find((mark) => mark.dataset.criterion.split(" ").includes(row.dataset.criterion))?.dataset.number }))`,
  );
  t.assert(
    pairs.every((pair) => pair.row && pair.passage?.split(" ").includes(pair.row)),
    "each score and its passage carry the same number",
    JSON.stringify(pairs),
  );
  const hues = await t.eval(
    `${criteria}.map((row) => ({ row: getComputedStyle(row.querySelector("[data-row-number]")).backgroundColor, passage: getComputedStyle([...document.querySelectorAll('${PANEL} mark.passage')].find((mark) => mark.dataset.criterion.split(" ")[0] === row.dataset.criterion)).getPropertyValue("--crit") }))`,
  );
  t.assert(
    new Set(hues.map((hue) => hue.row)).size === 4,
    "each criterion's number has its own hue",
    JSON.stringify(hues),
  );
  t.assert(
    (await t.eval(
      `${criteria}.every((row) => { const probe = document.createElement("span"); probe.style.color = getComputedStyle([...document.querySelectorAll('${PANEL} mark.passage')].find((mark) => mark.dataset.criterion.split(" ")[0] === row.dataset.criterion)).getPropertyValue("--crit"); document.body.append(probe); const same = getComputedStyle(probe).color === getComputedStyle(row.querySelector("[data-row-number]")).backgroundColor; probe.remove(); return same; })`,
    )) === true,
    "and its passages share that hue",
    JSON.stringify(hues),
  );
  t.assert(await t.has(`${PANEL} [data-numbers-label]`), "the pane says what the numbers mean");

  await t.viewport(1180, 420);
  await t.sleep(150);
  const reasonsMoved = await t.eval(
    `({ card: [...document.querySelectorAll('${CARD} [data-row-reason]')].filter((reason) => reason.offsetParent).length, pane: [...document.querySelectorAll('${PANEL} [data-reason-key] button')].filter((reason) => reason.offsetParent).length })`,
  );
  t.assert(
    reasonsMoved.card === 0 && reasonsMoved.pane === 4,
    "with no room beside the comment, all four reasons move beside the passages",
    JSON.stringify(reasonsMoved),
  );
  const scroller = '[data-testid="source-scroll"]';
  await t.eval(`document.querySelector('${scroller}').scrollTop = 0`);
  await t.click(`${PANEL} [data-reason-key] button:last-of-type`);
  await t.waitFor(
    `document.querySelector('${PANEL} mark[data-emphasized="true"]')`,
    "clicking a rationale emphasizes its passage",
  );
  await t.waitFor(
    `document.querySelector('${scroller}').scrollTop > 0`,
    "the panel scrolled to reach the passage",
  );
  await t.waitFor(
    inView(`${PANEL} mark[data-emphasized="true"]`, scroller),
    "the emphasized passage is in view",
  );
  await t.shot("rationale-scrolled-small-window");

  await t.media({ "prefers-reduced-motion": "reduce" });
  await t.eval(`document.querySelector('${scroller}').scrollTop = 0`);
  await t.click(`${PANEL} [data-reason-key] button:first-of-type`);
  await t.click(`${PANEL} [data-reason-key] button:last-of-type`);
  await t.sleep(40);
  const jumped = await t.eval(`document.querySelector('${scroller}').scrollTop`);
  await t.sleep(160);
  t.assert(
    jumped > 0 && jumped === (await t.eval(`document.querySelector('${scroller}').scrollTop`)),
    "with reduced motion on, a rationale jumps to its passage instead of gliding",
    String(jumped),
  );
  await t.media({});
  await t.viewport(1440, 1300);
  await t.sleep(150);
  const reasonsBack = await t.eval(
    `({ card: [...document.querySelectorAll('${CARD} [data-row-reason]')].filter((reason) => reason.offsetParent).length, pane: Boolean(document.querySelector('${PANEL} [data-reason-key]').offsetParent) })`,
  );
  t.assert(
    reasonsBack.card === 4 && !reasonsBack.pane,
    "with room again, the reasons go back on the card",
    JSON.stringify(reasonsBack),
  );

  await t.click(`[aria-label^="Jump to passage for Thesis"]`);
  const wanted = await t.eval(`${criteria}[0].dataset.criterion`);
  await t.waitFor(
    `document.querySelector('${PANEL} mark[data-emphasized="true"]')?.dataset.criterion.includes(${JSON.stringify(wanted)})`,
    "the jump control picks that criterion's passage",
  );
  await t.shot("rationale-emphasized");
  await t.viewport(1440, 900);
  await t.sleep(150);

  await t.hover(`${CARD} [data-criterion]:nth-child(2)`);
  await t.waitFor(
    `document.querySelector('${PANEL} mark[data-hovered="true"]')`,
    "hovering a rubric row pairs with its passage",
  );
  const third = await t.eval(`${criteria}[2].dataset.criterion`);
  await t.click(`${PANEL} mark.passage[data-criterion="${third}"]`);
  await t.waitFor(
    `${criteria}[2].dataset.selected === "true"`,
    "clicking a highlight selects its criterion",
  );
};

const motion = async (t) => {
  const started = () => t.eval("JSON.stringify(window.__started)").then(JSON.parse);
  await t.eval(
    `void (window.__started = [], document.addEventListener("animationstart", (event) => window.__started.push(event.animationName), true))`,
  );
  const reopen = async () => {
    await t.click('[aria-label="Close preview"]', { within: PANEL });
    await t.waitFor(`!document.querySelector('${PANEL}')`, "the panel closes");
    await t.eval("void (window.__started = [])");
    await t.click('[aria-label="Open panel"]');
    await t.waitFor(`document.querySelector('${PANEL}')`, "the panel opens");
    await t.sleep(300);
  };
  await reopen();
  t.assert((await started()).includes("panel-open"), "opening the panel animates its width");
  const mainWidth = (await t.box('[data-testid="thread-main"]')).width;
  t.assert(mainWidth >= 440, "the middle pane stays at least 440 wide", String(mainWidth));
  const schoolNamesFit = `[...document.querySelectorAll('[data-testid="school-row"] .truncate')].every((el) => el.scrollWidth <= el.clientWidth)`;
  t.assert(await t.has('[data-testid="school-row"] .truncate'), "the school rows are on screen");
  t.assert(await t.eval(schoolNamesFit), "school names fit their sidebar row");

  await t.eval("void (window.__started = [])");
  await t.viewport(1300, 900);
  await t.sleep(250);
  t.assert(
    !(await started()).includes("panel-open"),
    "resizing the window doesn't animate the panel",
  );
  await t.viewport(1180, 420);
  await t.sleep(200);

  const tabs = '[data-testid="thread-panel"] [role="tablist"]';
  const barBefore = await t.box(tabs);
  await t.eval(`void (document.querySelector('[data-testid="source-scroll"]').scrollTop = 90)`);
  await t.sleep(100);
  const readAt = await t.eval(`document.querySelector('[data-testid="source-scroll"]').scrollTop`);
  t.assert(readAt > 0, "the submission scrolls at this height", String(readAt));
  await t.click("Preview", { within: tabs });
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "the Preview tab opens",
  );
  t.assert((await t.box(tabs)).y === barBefore.y, "the tab bar stays put when the tab changes");
  await t.click('[role="tab"]', { within: tabs });
  await t.waitFor(
    `document.querySelector('[data-testid="source-scroll"]')`,
    "the submission tab opens",
  );
  await t.sleep(250);
  const backAt = await t.eval(`document.querySelector('[data-testid="source-scroll"]').scrollTop`);
  t.assert(
    Math.abs(backAt - readAt) <= 1,
    "coming back to the submission keeps your place",
    `${readAt} then ${backAt}`,
  );

  await t.viewport(1440, 900);
  await t.sleep(200);
  await t.media({ "prefers-reduced-motion": "reduce" });
  await reopen();
  await t.click("Preview", { within: tabs });
  await t.sleep(250);
  const reduced = (await started()).filter((name) =>
    ["panel-open", "panel-slide", "fade-in"].includes(name),
  );
  t.assert(
    reduced.length === 0,
    "reduced motion turns off the panel and fade animations",
    reduced.join(),
  );
  await t.viewport(880, 800);
  await t.sleep(200);
  await reopen();
  t.assert(
    (await started()).filter((name) => name === "panel-slide" || name === "panel-open").length ===
      0,
    "reduced motion also turns off the overlay slide",
  );
  await t.media({});
  await reopen();
  t.assert(
    (await started()).includes("panel-slide"),
    "at this width the panel slides in as an overlay",
  );
  await t.viewport(1440, 900);
  await t.sleep(250);
  await t.click('[role="tab"]', { within: tabs });
  await t.sleep(250);
};

const correction = async (t) => {
  await t.click("[data-composer]");
  await t.type("thesis should be 20");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector('${CARD} [data-criterion] [data-score]')?.innerText.startsWith("20")`,
    "composer correction moves the stepper",
  );
  await t.waitFor(
    `document.querySelector('${CARD} [data-testid="draft-grade"]')?.innerText.startsWith("82")`,
    "the total follows the rubric",
  );
  await t.waitFor(
    `[...document.querySelectorAll('[data-edited]')].some((el) => el.innerText.includes("22") && el.innerText.includes("20"))`,
    "the reply says which field changed",
  );
  await t.waitFor(
    `(() => { const c = document.querySelector(${JSON.stringify(CHAT)}); return c.scrollHeight - c.scrollTop - c.clientHeight < 2; })()`,
    "sending a message follows the chat to the bottom",
  );
  t.assert(
    (await t.eval(`document.querySelector('${CARD} [data-criterion]').dataset.flash`)) === "true",
    "the corrected row highlights briefly",
  );
  const reasons = await t.eval(
    `[...document.querySelectorAll('${CARD} [data-criterion]')].map((row) => Boolean(row.querySelector("[data-rationale]")))`,
  );
  t.assert(
    JSON.stringify(reasons) === "[false,true,true,true]",
    "the corrected score's old reason goes, and the other criteria keep theirs (#47)",
    JSON.stringify(reasons),
  );
  await t.shot("composer-correction");

  await t.click("[data-composer]");
  await t.type("approve this");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector("[data-declined]")`,
    '"approve this" gets a plain note in the thread',
  );
  t.assert(
    (await t.text("[data-declined]")).includes("Approve on the draft"),
    "the note names the button on screen",
    await t.text("[data-declined]"),
  );
  t.assert(!(await t.has("[data-refusal]")), "an ordinary no doesn't read as an error");
  t.assert(
    (await tagOf(t, "Maya Ortiz, Essay 2")) === "draft",
    "the refusal left the change a draft",
  );
  await settled(t, "agent finished refusing");
  await t.shot("agent-refusal");

  const half = "thesis should";
  const userMessages = `${threadMessages}.filter((m) => m.type === "user").length`;
  const sentBefore = await t.eval(userMessages);
  await t.click("[data-composer]");
  await t.type(half);
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "the chord opens the review from a half-typed correction",
  );
  await t.sleep(150);
  t.assert(
    (await t.eval(userMessages)) === sentBefore,
    "the chord doesn't send the half-typed correction to the agent",
  );
  t.assert(
    (await t.eval(`document.querySelector("[data-composer]").value`)) === half,
    "the half-typed correction stays in the box",
  );
  await t.click("Submission", { within: PANEL });
  await t.click("[data-composer]");
  for (const _ of half) await t.key("Backspace");
  await t.eval(`document.activeElement?.blur()`);
};

const approval = async (t) => {
  const subject = "Maya Ortiz, Essay 2";
  const previewControls = () =>
    t.eval(
      `[...document.querySelectorAll("button, a, [role=tab]")].filter((el) => el.checkVisibility() && /\\bpreview\\b/i.test(el.innerText)).map((el) => el.innerText.trim()).join()`,
    );
  t.assert(
    (await previewControls()) === "Preview",
    "with the panel open on a draft, its tab is the one Preview control",
    await previewControls(),
  );
  await t.key("Meta+d");
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "⌘D on a draft opens the preview",
  );
  await t.key("Meta+d");
  await t.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, "⌘D closes it");
  t.assert(
    (await previewControls()) === "Preview",
    "with the panel closed, the card's own Preview is the one Preview control",
    await previewControls(),
  );
  t.assert(
    (await t.eval(`document.querySelector('[aria-label="Open panel"]').title`)).includes("⌘D"),
    "the panel button says ⌘D opens the preview",
  );
  t.assert(
    (await t.text('[data-testid="card-actions"]')).includes("Approve") &&
      !(await t.text('[data-testid="card-actions"]')).includes("Review"),
    "the card's next step is Approve, with no review step before it",
    await t.text('[data-testid="card-actions"]'),
  );
  const drafted = await t.eval(
    `({ grade: document.querySelector('${CARD} [data-testid="draft-grade"] b').innerText, rubric: document.querySelectorAll('${CARD} [data-criterion]').length, feedback: document.querySelector('${CARD} [aria-label="Feedback comment"]').value })`,
  );
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.matches('${CARD} [data-approve]')`,
    "the chord stops on the card's Approve",
  );
  t.assert((await tagOf(t, subject)) === "draft", "the chord on a draft approves nothing");
  await t.click("Preview", { within: '[data-testid="card-actions"]' });
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "the card's Preview opens what will be sent",
  );
  t.assert(
    (await t.text('[data-testid="preview-heading"]')).startsWith("What will be sent to "),
    "the preview says what it is showing",
  );
  const previewed = await t.eval(`(() => {
    const text = (selector) => document.querySelector(selector)?.innerText ?? "";
    const drafted = ${JSON.stringify(drafted)};
    return {
      grade: text('${PANEL} [data-field="grade"]').includes(drafted.grade),
      rubric: document.querySelectorAll('${PANEL} [data-field="rubric"] li').length === drafted.rubric,
      feedback: text('${PANEL} [data-field="comment"]').includes(drafted.feedback),
      approve: Boolean(document.querySelector('${PANEL} [data-approve]')),
      noSend: ![...document.querySelectorAll('${PANEL} button')].some((button) => button.innerText.startsWith("Send to")),
    };
  })()`);
  t.assert(previewed.grade, "the preview shows the same grade as the draft");
  t.assert(previewed.rubric, "the preview lists every rubric score");
  t.assert(previewed.feedback, "the preview shows the whole feedback text");
  t.assert(
    await t.eval(
      `(() => { const card = document.querySelector('${CARD}[data-previewing]'); return Boolean(card) && !card.querySelector("[data-criterion], textarea") && card.querySelector("[data-card-edit]")?.innerText.trim() === "Edit"; })()`,
    ),
    "with the preview open, the grade card is one row with Edit, so the scores show once",
  );
  t.assert(
    previewed.approve && previewed.noSend,
    "Approve is the next step, and Send appears only once it is pressed",
  );
  await t.shot("send-preview");
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-approve")`,
    "the chord moves focus to Approve",
  );
  t.assert((await tagOf(t, subject)) === "draft", "moving focus approves nothing");
  await t.key("Meta+Enter");
  await t.sleep(150);
  t.assert(
    (await tagOf(t, subject)) === "draft",
    "the chord on the focused button still does not approve",
  );

  await t.eval(`document.querySelector("[data-approve]").click()`);
  await t.sleep(150);
  t.assert((await tagOf(t, subject)) === "draft", "a scripted button.click() does not approve");
  await t.eval(
    `document.querySelector("[data-approve]").dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
  );
  await t.sleep(150);
  t.assert((await tagOf(t, subject)) === "draft", "a synthetic click event does not approve");

  await approve(t, subject);
  t.assert((await tagOf(t, subject)) === "approved", "a real click approves");
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-send")`,
    "approving puts the keyboard on Send, the next and last step",
  );
  t.assert(
    (await t.eval(`document.querySelector('[data-testid="flow"] [aria-current]').innerText`)) ===
      "Approved",
    "the flow shows Approved",
  );
  const readySignal = await t.eval(
    `(() => { const badge = document.querySelector('[data-testid="sidebar"] a[title*="ready to send"] [data-slot="badge"]'); const probe = document.body.appendChild(Object.assign(document.createElement("span"), { className: "text-success-foreground" })); const ready = getComputedStyle(probe).color; probe.remove(); return { dot: badge && getComputedStyle(badge.querySelector("[data-status-dot]")).color, number: badge && getComputedStyle(badge).color, ready }; })()`,
  );
  t.assert(
    readySignal.dot === readySignal.ready,
    "a course holding approved work shows it in its dot, in the Ready to send colour",
    JSON.stringify(readySignal),
  );
  t.assert(
    readySignal.number !== readySignal.ready,
    "the course's total stays neutral, because it counts more than the approved work",
    JSON.stringify(readySignal),
  );
  await t.shot("approved");

  await t.click("[data-card-edit]", { within: CARD });
  await t.waitFor(
    `!document.querySelector('${PANEL}') && document.activeElement?.matches('${CARD} [data-edit-field]')`,
    "Edit closes the preview and puts the cursor in the card's comment",
  );
  await t.click('[aria-label="Raise Thesis and claim"]');
  await t.waitFor(
    `document.querySelector('${CARD} [data-approval-reset]')?.innerText.includes("You edited")`,
    "editing resets approval and the card names you",
  );
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector('${CARD} [data-approval-reset]')?.innerText.includes("You edited") && document.activeElement?.matches('${CARD} [data-approve]')`,
    "the chord stops on Approve again, and the card still names you",
  );
  t.assert(
    !(await t.eval(
      `[...document.querySelectorAll('${CHAT} [data-notice]')].some((el) => /approv/i.test(el.innerText))`,
    )),
    "the chat doesn't say it a second time",
  );
  t.assert((await tagOf(t, subject)) === "draft", "the edit returned it to draft");
  await t.shot("approval-reset-by-you");

  await t.click("[data-approve]");
  await t.waitFor(`document.body.innerText.includes("Undo approval")`, "approved again");
  await t.click("[data-composer]");
  await t.type("thesis should be 19");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector('${CARD} [data-approval-reset]')?.innerText.includes("The agent edited")`,
    "an agent edit resets approval and names the agent",
  );
  t.assert(
    !(await t.eval(
      `[...document.querySelectorAll('${CHAT} [data-notice]')].some((el) => /approv/i.test(el.innerText))`,
    )),
    "the chat doesn't say it a second time",
  );
  await settled(t, "agent finished its edit");

  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-approve")`,
    "the chord walks back to Approve",
  );
  await t.key("Enter");
  await t.waitFor(
    `document.body.innerText.includes("Undo approval")`,
    "Enter on the focused button is a real click and approves",
  );
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-send") && document.activeElement.innerText.startsWith("Send to")`,
    "after Approve, Send is the default",
  );
  await t.shot("approved-send-default");
  await t.key("Enter");
  await sendAndWaitSent(t, subject);
  t.assert(
    !(await t.has('[role="dialog"]')),
    "Return on Send sends, with no confirmation after it",
  );
  t.assert(
    (await gradeInLms(t, "Maya Ortiz", "Essay 2")) === 81,
    "the LMS holds the approved grade",
    String(await gradeInLms(t, "Maya Ortiz", "Essay 2")),
  );
  t.assert((await myComments(t, "Maya Ortiz", "Essay 2")) === 1, "the comment posted once");
  t.assert(
    (await t.eval(`document.querySelector('${CARD} [data-testid="receipt"]') !== null`)) === true,
    "the chat shows a receipt",
  );
  t.assert(
    /of 32\s+·\s+1 sent\b|\b1 of 32 sent\b/.test(await t.text(QUEUE)),
    "queue progress moved",
    await t.text(QUEUE),
  );
  await t.click("View what was sent", { within: CARD });
  await t.waitFor(`document.querySelector('${PANEL} [data-field]')`, "View what was sent opens it");
  t.assert(
    (await t.has(`${PANEL} [data-field]`)) && !(await t.has(`${PANEL} [data-field-chip]`)),
    "every field landed, so no section repeats it",
  );
  await t.shot("sent");
  await t.click("Activity", { within: PANEL });
  await t.waitFor(`document.querySelector('[data-testid="activity"]').open`, "activity list opens");
  await t.shot("sent-activity");
  await t.click("Activity", { within: PANEL });
};

const reconnect = async (t) => {
  await openAndApprove(t, "Darnell Pruitt", "Annotated Bibliography");
  await openAndApprove(t, "Hannah Stroud", "Essay 2");
  await lab(t, `expireToken("lcc")`);
  await clickSend(t);
  await t.waitFor(
    `document.querySelector('[data-banner="reconnect"]')`,
    "an expired token shows the reconnect banner",
  );
  const words = await t.text('[data-banner="reconnect"]');
  t.assert(
    words.includes("Lakeshore Community College token expired. Nothing was lost."),
    "the banner says nothing was lost",
  );
  t.assert(/\d fields? not written/.test(words), "the banner counts the unwritten fields", words);
  t.assert(
    (await t.has(`${PANEL} [data-field]`)) && !(await t.has(`${PANEL} [data-field-chip]`)),
    "the banner's count is the one place that says nothing was written",
  );
  await t.shot("banner-reconnect");

  await expandQueue(t);
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('[data-row]')].find((row) => row.innerText.includes("Darnell Pruitt")).innerText.includes("Waiting on reconnect")`,
    )) === true,
    "another change for that school shows waiting on reconnect",
  );
  t.assert(
    !(await t.has('[data-testid="sidebar"] [title="Waiting on reconnect"]')),
    "one school dot stands for every thread waiting on that school",
  );
  t.assert(await t.has('[data-testid="school-reconnect"]'), "the sidebar shows the expired token");
  await t.click("Collapse queue");
  await t.click("Settings", { within: '[data-testid="sidebar"]' });
  await t.waitFor(
    `document.querySelector('[data-school="lcc"]')?.dataset.connection === "expired"`,
    "Settings shows the expired token",
  );
  await t.shot("settings-expired");
  await t.openGradingList();

  await t.click("Reconnect", { within: PANEL });
  await t.waitFor(
    `document.querySelector('[role="dialog"] input[type="password"]')`,
    "reconnect opens the token dialog",
  );
  await t.shot("token-dialog");
  await t.click('[role="dialog"] input[type="password"]');
  await t.type(TOKEN);
  await t.click("Connect", { within: '[role="dialog"]' });
  await t.waitFor(
    `!document.querySelector('[role="dialog"]')`,
    "the dialog closes after connecting",
  );
  await t.waitFor(
    `document.querySelector('[data-banner="reconnect"]')?.innerText.includes("Reconnected")`,
    "the banner offers a retry",
  );
  t.assert(
    !(await t.pageText()).includes("connection expired"),
    "reconnecting clears the expired notice",
  );
  const leaks = await t.eval(
    `[document.body.innerText, document.documentElement.outerHTML, JSON.stringify(localStorage), JSON.stringify(sessionStorage), ...[...document.querySelectorAll("input")].map((i) => i.value)].filter((text) => text.includes(${JSON.stringify(TOKEN)})).length`,
  );
  t.assert(leaks === 0, "the token appears nowhere after entry");
  await t.click("Retry", { within: PANEL });
  await sendAndWaitSent(t, "Hannah Stroud, Essay 2");
  t.assert(
    (await myComments(t, "Hannah Stroud", "Essay 2")) === 1,
    "reconnect and retry posted once",
  );

  await openStudent(t, "Darnell Pruitt", "Annotated Bibliography");
  await writeBackTab(t);
  t.assert(
    !(await t.has('[data-banner="reconnect"]')),
    "the waiting change is free again after reconnecting",
  );
  await clickSend(t);
  await sendAndWaitSent(t, "Darnell Pruitt, Annotated Bibliography");
};

const conflict = async (t) => {
  const subject = "Aaliyah Brooks, Essay 2";
  await openStudent(t, "Aaliyah Brooks", "Essay 2");
  t.assert((await t.text(CARD)).includes("Late penalty, 2d at"), "the late penalty line shows");
  await writeBackTab(t);
  await approve(t, subject);
  await t.eval(
    `(async () => void window.__faultLab.changeGradeOutOfBand(${refOf("Aaliyah Brooks", "Essay 2")}, 65, "Jordan Pike (TA)"))()`,
  );
  await clickSend(t);
  await t.waitFor(
    `document.querySelector('[data-banner="conflict"]')`,
    "a changed grade shows the conflict banner",
  );
  const conflictText = await t.text('[data-conflict="grade"]');
  t.assert(
    ["Draft saw", "LMS holds now", "You propose", "65"].every((word) =>
      conflictText.includes(word),
    ),
    "the conflict has three columns per field",
    conflictText,
  );
  await t.waitFor(
    `document.querySelector("[data-who]")?.innerText.includes("Jordan Pike (TA)")`,
    "it names who changed the grade",
  );
  t.assert(
    !(await t.eval(
      `[...document.querySelectorAll('[data-conflict] button')].some((b) => b.innerText === "It's already there")`,
    )),
    "only a possible own write offers that choice",
  );
  await t.shot("banner-conflict");
  t.assert(
    (await gradeInLms(t, "Aaliyah Brooks", "Essay 2")) === 65,
    "nothing overwrote the other person's grade",
  );
  const conflicts = await t.eval(`document.querySelectorAll('[data-conflict]').length`);
  for (let i = 0; i < conflicts; i++) await t.click("Keep mine", { within: PANEL, nth: i });
  await t.click("Resolve and return to draft");
  await t.waitFor(
    `document.querySelector('${PANEL} [data-approval-reset]')?.innerText.includes("fresh approval")`,
    "resolving returns to draft and says it needs a fresh approval",
  );
  t.assert(
    !(await t.eval(
      `[...document.querySelectorAll('${CHAT} [data-notice]')].some((el) => /approv/i.test(el.innerText))`,
    )),
    "the chat doesn't say it a second time",
  );
  t.assert((await tagOf(t, subject)) === "draft", "the conflict resolved to a draft");
  await t.shot("conflict-resolved");
  await approve(t, subject);
  await clickSend(t);
  await sendAndWaitSent(t, subject);
};

const partial = async (t) => {
  const subject = "Kenji Arai, Sequence Analysis";
  await openAndApprove(t, "Kenji Arai", "Sequence Analysis");
  await lab(t, `failNextWrite("comment", { kind: "unavailable", status: 500 })`);
  await clickSend(t);
  await t.waitFor(
    `document.querySelector('[data-banner="partial"]')`,
    "a failed comment shows the partial banner",
  );
  const words = await t.text('[data-banner="partial"]');
  t.assert(
    words.includes("Grade is in the gradebook.") && words.includes("The feedback did not post."),
    "the banner says what landed in words",
    words,
  );
  const retry = await t.eval(
    `[...document.querySelectorAll('[data-banner="partial"] button')].map((b) => b.innerText).find((label) => label.startsWith("Retry remaining"))`,
  );
  t.assert(
    retry.includes("Feedback") && !retry.includes("Grade"),
    "the retry button names only what's left",
    retry,
  );
  t.assert(
    (await t.eval(
      `document.querySelector('${PANEL} [data-field="grade"] [data-field-chip]').innerText`,
    )) === "Landed",
    "the grade chip says Landed",
  );
  t.assert(
    (await t.eval(
      `document.querySelector('${PANEL} [data-field="comment"] [data-field-chip]').innerText`,
    )) === "Failed",
    "the comment chip says Failed",
  );
  await notClaimingToSend(t, "partial");
  await t.shot("banner-partial");
  await t.click("Retry remaining");
  await sendAndWaitSent(t, subject);
  t.assert(
    (await myComments(t, "Kenji Arai", "Sequence Analysis")) === 1,
    "the retry posted the comment once",
  );
};

const rejected = async (t) => {
  const subject = "Peter Vogel, Sequence Analysis";
  await openAndApprove(t, "Peter Vogel", "Sequence Analysis");
  await lab(
    t,
    `failNextWrite("grade", { kind: "rejected", reason: "The gradebook is locked for this assignment." })`,
  );
  await clickSend(t);
  await t.waitFor(
    `document.querySelector('[data-banner="rejected"]')`,
    "a refused write shows the rejected banner",
  );
  t.assert(
    (await t.text('[data-banner="rejected"]')).includes(
      "The gradebook is locked for this assignment.",
    ),
    "the banner gives the LMS's reason in words",
  );
  await notClaimingToSend(t, "rejected");
  await t.shot("banner-rejected");
  await t.click("Edit", { within: '[data-banner="rejected"]' });
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-edit-field") && !document.querySelector(${JSON.stringify(PANEL)})`,
    "the banner's Edit closes the preview and puts focus on the comment",
  );
  await t.click("[data-card-primary]", { within: CARD });
  await t.click("Retry", { within: '[data-banner="rejected"]' });
  await sendAndWaitSent(t, subject);
};

const exhausted = async (t) => {
  const subject = "Silas Wray, Sequence Analysis";
  await openAndApprove(t, "Silas Wray", "Sequence Analysis");
  for (let i = 0; i < 4; i++)
    await lab(t, `failNextWrite("grade", { kind: "unavailable", status: 503 })`);
  await clickSend(t);
  await t.waitFor(
    `[...document.querySelectorAll('${PANEL} [data-field-chip]')].some((chip) => chip.innerText === "Retrying" || chip.innerText === "Writing")`,
    "the field chip shows the send working",
  );
  await t.waitFor(
    `document.querySelector('[data-banner="failed"]')`,
    "running out of retries shows the failed banner",
    25_000,
  );
  t.assert(
    (await t.text('[data-banner="failed"]')).includes("ran out of tries"),
    "the banner says the retries ran out",
  );
  await notClaimingToSend(t, "retries exhausted");
  await t.shot("banner-retries-exhausted");
  await t.click("Retry", { within: '[data-banner="failed"]' });
  await sendAndWaitSent(t, subject);
};

const inDoubt = async (t) => {
  const subject = "Elena Vasquez, Annotated Bibliography";
  await openAndApprove(t, "Elena Vasquez", "Annotated Bibliography");
  await lab(t, `loseNextResponse(false)`);
  await clickSend(t);
  await t.waitFor(
    `document.querySelector('[data-banner="in-doubt"]')`,
    "an unanswered write shows the in-doubt banner",
    20_000,
  );
  const words = await t.text('[data-banner="in-doubt"]');
  t.assert(
    words.includes("could not confirm") && words.includes("could post twice"),
    "the banner says it could not confirm and warns about resuming",
    words,
  );
  t.assert(
    (await myComments(t, "Elena Vasquez", "Annotated Bibliography")) === 0,
    "nothing was written",
  );
  await t.click("Check again");
  await t.waitFor(
    `document.querySelector('[data-checked]')?.innerText.includes("Still can't confirm")`,
    "Check again reports it still can't confirm",
  );
  t.assert(
    (await myComments(t, "Elena Vasquez", "Annotated Bibliography")) === 0,
    "Check again wrote nothing",
  );
  await notClaimingToSend(t, "in doubt");
  await t.shot("banner-in-doubt");
  await t.click("Resume, could post twice");
  await sendAndWaitSent(t, subject);
  t.assert(
    (await myComments(t, "Elena Vasquez", "Annotated Bibliography")) === 1,
    "Resume posted once",
  );

  const late = "Ian McCreedy, Annotated Bibliography";
  await openAndApprove(t, "Ian McCreedy", "Annotated Bibliography");
  const before = await myComments(t, "Ian McCreedy", "Annotated Bibliography");
  await lab(t, `lateLanding(4000)`);
  await clickSend(t);
  await t.waitFor(
    `document.querySelector('[data-banner="in-doubt"]')`,
    "a late landing rests in doubt first",
    20_000,
  );
  await t.waitFor(
    `(async () => { const lms = JSON.parse(await window.__faultLab.stored()); return ${submissionIn("Ian McCreedy", "Annotated Bibliography")}.comments.filter((c) => c.mine).length === ${before + 1}; })()`,
    "the late write lands by itself",
    10_000,
  );
  await t.click("Check again");
  await sendAndWaitSent(t, late);
  t.assert(
    (await myComments(t, "Ian McCreedy", "Annotated Bibliography")) === before + 1,
    "Check again confirmed it without writing again",
  );
};

const lostResponse = async (t) => {
  const subject = "Marcus Yoon, Annotated Bibliography";
  await openAndApprove(t, "Marcus Yoon", "Annotated Bibliography");
  await lab(t, `loseNextResponse(true)`);
  await clickSend(t);
  await sendAndWaitSent(t, subject, 20_000);
  t.assert(
    (await myComments(t, "Marcus Yoon", "Annotated Bibliography")) === 1,
    "a lost response did not post the comment twice",
  );
};

const interrupted = async (t) => {
  const subject = "Theo Ramirez, Proposal Draft";
  await openAndApprove(t, "Theo Ramirez", "Proposal Draft");
  await lab(t, `setNoise({ latencyMs: [1500, 1500] })`);
  await lab(t, `holdWrites(true)`);
  await clickSend(t);
  await t.waitFor(
    `[...document.querySelectorAll('${PANEL} [data-field-chip]')].some((chip) => chip.innerText === "Writing")`,
    "the send reaches Writing before the reload",
  );
  await t.shot("sending");
  await t.reload();
  await t.waitFor(
    `document.querySelector('[data-banner="interrupted"]')`,
    "reload mid-send shows the interrupted banner",
  );
  t.assert(await t.has('[data-testid="writeback-scroll"]'), "reload kept the preview panel open");
  t.assert(
    (await t.text('[data-banner="interrupted"]')).includes("Resume checks"),
    "the banner explains Resume",
  );
  await t.shot("banner-interrupted");
  await t.click("Resume", { within: '[data-banner="interrupted"]' });
  await sendAndWaitSent(t, subject);
  t.assert(
    (await myComments(t, "Theo Ramirez", "Proposal Draft")) === 1,
    "Resume converges with one comment",
  );

  const partly = "Stella Kovacs, Proposal Draft";
  await openAndApprove(t, "Stella Kovacs", "Proposal Draft");
  await lab(t, `failNextWrite("comment", { kind: "unavailable", status: 500 })`);
  await clickSend(t);
  await t.waitFor(
    `document.querySelector('[data-banner="partial"]')`,
    "the partly sent change is held",
  );
  await lab(t, `setNoise({ latencyMs: [1500, 1500] })`);
  await lab(t, `holdWrites(true)`);
  await t.click("Retry remaining");
  await t.waitFor(
    `[...document.querySelectorAll('${PANEL} [data-field-chip]')].some((chip) => chip.innerText === "Writing")`,
    "the retry is writing before the reload",
  );
  await t.reload();
  await t.waitFor(
    `document.querySelector('[data-banner="interrupted"]')`,
    "reload during a retry shows the interrupted banner",
  );
  t.assert(
    (await t.text('[data-banner="interrupted"]')).includes("Grade is in the gradebook."),
    "the interrupted banner shows what landed",
  );
  await t.click("Resume", { within: '[data-banner="interrupted"]' });
  await sendAndWaitSent(t, partly);
  t.assert(
    (await myComments(t, "Stella Kovacs", "Proposal Draft")) === 1,
    "the comment posted once after resuming",
  );
};

const resubmission = async (t) => {
  await openStudent(t, "Luis Cardenas", "Essay 2");
  t.assert(
    await t.has('[data-testid="prior-attempt"]'),
    "a resubmission shows the previous attempt",
  );
  t.assert((await t.text(CARD)).includes("Previous grade"), "the draft shows the previous grade");
  await writeBackTab(t);
  t.assert(
    (await t.text(`${PANEL} [data-field="grade"]`)).includes("now in the LMS."),
    "the preview says in words which grade this replaces",
  );
  await t.shot("resubmission-preview");
};

const BATCH = [
  ["Emil Novak", "Speech 3 Outline"],
  ["Wren Calloway", "Speech 3 Outline"],
  ["Imani Okafor", "Reading Response 6"],
  ["Priya Raman", "Essay 2"],
  ["Mateo Quiroga", "Close Reading 2"],
  ["Zora Tillman", "Close Reading 2"],
];

const batch = async (t) => {
  await expandQueue(t);
  for (const [student] of BATCH) await t.click(`[aria-label="Select ${student}"]`);
  await t.waitFor(
    `document.body.innerText.includes("Draft 6")`,
    "selecting undrafted rows offers Draft 6",
  );
  await t.shot("batch-selected");
  await t.eval(`void (window.__reviewWhileDrafting = [], window.__draftWatch = setInterval(() => {
    const drafting = [...document.querySelectorAll('[data-row]')].filter((row) => row.innerText.includes("Drafting")).length;
    const review = [...document.querySelectorAll('button')].find((b) => /^Review \\d+$/.test(b.innerText));
    if (drafting && review) window.__reviewWhileDrafting.push(review.innerText + " with " + drafting + " drafting");
  }, 20))`);
  await t.click("Draft 6");
  await t.waitFor(
    `[...document.querySelectorAll('[data-row]')].some((row) => row.innerText.includes("Drafting"))`,
    "drafting shows per row",
  );
  await t.shot("batch-drafting");
  await t.waitFor(
    `document.body.innerText.includes("Review 6")`,
    "drafted rows offer Review 6",
    20_000,
  );
  await t.eval(`clearInterval(window.__draftWatch)`);
  const early = await t.eval(`window.__reviewWhileDrafting`);
  t.assert(
    early.length === 0,
    "Review is not offered while a ticked row is still drafting",
    early[0],
  );
  await t.click("Review 6");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 6`,
    "every selected change is stacked in the panel",
  );
  const whole = await t.eval(
    `[...document.querySelectorAll('[data-batch-item]')].every((item) => item.querySelector('[data-field="grade"]') && item.querySelector('[data-field="comment"]'))`,
  );
  t.assert(whole === true, "each change shows its grade and feedback");
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('[data-batch-item]')].every((item) => item.innerText.includes("/"))`,
    )) === true,
    "each change shows a score out of its total",
  );
  await t.eval(
    `void (window.__approveButton = document.querySelector('[data-testid="batch-header"] [data-approve]'))`,
  );
  const approveWidth = (await t.box('[data-testid="batch-header"] [data-approve]')).width;
  await t.click('[aria-label="Remove Zora Tillman, Close Reading 2"]');
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 5`,
    "a change can be removed from the batch",
  );
  await t.waitFor(
    `window.__approveButton.isConnected && window.__approveButton.innerText === "Approve 5"`,
    "the count changes in place, on the same button",
  );
  t.assert(
    (await t.box('[data-testid="batch-header"] [data-approve]')).width === approveWidth,
    "the Approve button keeps its width as the count changes",
  );
  const header = await t.box('[data-testid="batch-header"]');
  await t.wheel('[data-testid="batch-scroll"]', 3000);
  await t.sleep(150);
  t.assert(
    (await t.box('[data-testid="batch-header"]')).y === header.y,
    "the batch header stays put while the previews scroll",
  );
  await t.shot("batch-review");
  const panel = await t.box(PANEL);
  const main = await t.box('[data-testid="thread-main"]');
  t.assert(panel.width > main.width, "batch mode is wide", `${panel.width} vs ${main.width}`);
  t.assert(main.width >= 440, "batch mode leaves the chat a usable column", String(main.width));
  await assertCrumbsFit(t, "batch at 1440");
  await t.viewport(1180, 800);
  await t.sleep(200);
  t.assert(
    (await t.box('[data-testid="thread-main"]')).width >= 440,
    "batch mode at 1180 leaves the chat a usable column",
  );
  await assertCrumbsFit(t, "batch at 1180");
  await t.shot("batch-review-1180");
  await t.viewport(1440, 900);
  await t.sleep(200);

  await t.click("Approve 5");
  await t.waitFor(
    `[...document.querySelectorAll('[data-testid="batch-header"] button')].some((b) => b.innerText === "Send 5" && !b.disabled)`,
    "approving enables Send 5",
  );
  await t.shot("batch-approved");

  await lab(t, `throttleNext(3000, "write")`);
  await lab(t, `failNextWrite("comment", { kind: "unavailable", status: 500 })`);
  await lab(t, `expireToken("rsu")`);
  await t.click("Send 5");
  await t.waitFor(
    `document.querySelector('[data-testid="lane-message"]')?.innerText.includes("asked us to slow down, resuming in")`,
    "a paused school shows the lane message",
  );
  await t.waitFor(
    `document.querySelector('[data-progress-item]')`,
    "progress rows show while sending",
  );
  await t.shot("batch-sending-paused");
  await t.waitFor(
    `document.querySelector('[data-testid="batch-outcome"]')?.innerText === "3 sent, 1 needs attention, 1 waiting on reconnect"`,
    "the outcome summary counts each result",
    30_000,
  );
  await t.shot("batch-outcome");

  await t.click("Mateo Quiroga, Close Reading 2", { within: '[data-testid="batch-header"]' });
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "an outcome row links to its change",
  );
  await t.click("Reconnect", { within: PANEL });
  await t.click('[role="dialog"] input[type="password"]');
  await t.type(`${TOKEN}-rsu`);
  await t.click("Connect", { within: '[role="dialog"]' });
  await t.waitFor(`!document.querySelector('[role="dialog"]')`, "reconnected the other school");
  await t.click("Back to batch");
  await t.waitFor(
    `[...document.querySelectorAll('[data-testid="batch-header"] button')].some((b) => b.innerText === "Retry failed" && !b.disabled)`,
    "Retry failed is available",
  );
  await t.eval(`void (window.__stuckSending = 0, window.__sendWatch = setInterval(() => {
    const items = [...document.querySelectorAll('[data-progress-item]')];
    const header = document.querySelector('[data-testid="batch-header"] [data-action-bar]')?.innerText ?? "";
    if (items.length && items.every((item) => item.innerText.includes("Sent")) && header.startsWith("Sending")) window.__stuckSending++;
  }, 20))`);
  await t.click("Retry failed");
  await t.waitFor(
    `[...document.querySelectorAll('[data-progress-item]')].every((item) => item.innerText.includes("Sent"))`,
    "every progress row shows Sent",
    30_000,
  );
  await t.shot("batch-rows-sent");
  await t.waitFor(
    `document.querySelector('[data-testid="batch-outcome"]')?.innerText === "5 sent"`,
    "Retry failed converges",
    30_000,
  );
  await t.eval(`clearInterval(window.__sendWatch)`);
  const stuck = await t.eval(`window.__stuckSending`);
  t.assert(
    stuck === 0,
    "the header leaves Sending once every row shows Sent",
    `${stuck * 20}ms stuck`,
  );
  for (const [student, short] of BATCH.slice(0, 5))
    t.assert((await myComments(t, student, short)) === 1, `${student}: comment posted once`);
  t.assert(
    !(await t.text('[data-testid="batch-header"]')).includes("Retry failed"),
    "Retry failed goes away once nothing failed",
  );
  await t.shot("batch-all-sent");
  await t.click('[aria-label="Close batch"]');
};

const replies = async (t) => {
  await t.goto("/threads/t-e101-mail");
  await t.waitFor(
    `document.querySelectorAll('[data-row]').length >= 2`,
    "the messages thread has a pinned list of conversations",
  );
  const titles = await t.eval(
    `[...document.querySelectorAll('[data-row] input')].slice(0, 2).map((box) => box.getAttribute("aria-label"))`,
  );
  for (const label of titles) await t.click(`[aria-label="${label}"]`);
  await t.click("Draft 2");
  await t.waitFor(`document.body.innerText.includes("Review 2")`, "two replies drafted", 20_000);
  await t.click("Review 2");
  await t.waitFor(
    `document.querySelectorAll('[data-batch-item]').length === 2`,
    "replies use the same batch mode",
  );
  await t.shot("batch-replies");
  await t.click("Approve 2");
  await t.waitFor(
    `[...document.querySelectorAll('[data-testid="batch-header"] button')].some((b) => b.innerText === "Send 2" && !b.disabled)`,
    "replies approved together",
  );
  await t.click("Send 2");
  await t.waitFor(
    `document.querySelector('[data-testid="batch-outcome"]')?.innerText === "2 sent"`,
    "both replies sent",
    20_000,
  );
  await t.click('[aria-label="Close batch"]');
};

const keyboardAndClear = async (t) => {
  await expandCourse(t, "COMM 110");
  await t.click("Grade Speech 2", { within: '[data-testid="sidebar"]' });
  await t.waitFor(
    `location.pathname === "/threads/t-c110-speech2"`,
    "the sidebar opens the course thread",
  );
  await t.waitFor(
    `document.querySelectorAll('[data-row]').length === 3`,
    "the course thread lists its three submissions",
  );
  await t.key("j");
  await t.waitFor(
    `document.querySelector('[data-row][data-cursor="true"]')`,
    "J moves the queue cursor",
  );
  await t.key("j");
  await t.key("k");
  t.assert(
    (await t.eval(`document.querySelector('[data-row]').dataset.cursor`)) === "true",
    "K moves it back",
  );
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(OPEN)})`,
    "Enter opens the row under the cursor",
  );
  await t.key("Meta+Enter");
  await t.sleep(300);
  t.assert(
    (await t.has(OPEN)) && !(await t.has('[data-testid="agent-working"]')),
    "⌘↵ on a submission with nothing drafted neither skips it nor drafts it (#48)",
  );
  await draftWithClaude(t);
  await t.waitFor(`document.querySelector(${JSON.stringify(CARD)})`, "Draft with Claude drafts it");
  await settled(t, "first speech drafted");
  t.assert(
    !(await t.has(`${PANEL} .lucide-play`)) &&
      /Attempt \d+ · \d+:\d\d recording/.test(await t.text(PANEL)),
    "a media submission shows its length, with no play control it can't honor",
    await t.text(PANEL),
  );
  t.assert(
    (await t.text(PANEL)).includes("Auto transcript"),
    "a media submission shows its transcript",
  );
  t.assert(
    (await t.eval(`document.querySelectorAll('${PANEL} mark.passage').length`)) > 0,
    "the transcript carries highlights too",
  );
  await t.shot("video-submission");
  await speechCorrections(t);

  for (let done = 1; done <= 3; done++) {
    await t.key("Meta+Enter");
    await t.waitFor(
      `document.querySelector('[data-testid="writeback-scroll"]')`,
      `speech ${done}: chord reviews`,
    );
    await t.key("Meta+Enter");
    await t.waitFor(
      `document.activeElement?.hasAttribute("data-approve")`,
      `speech ${done}: chord stops at Approve`,
    );
    await t.key("Enter");
    await t.waitFor(
      `document.body.innerText.includes("Undo approval")`,
      `speech ${done}: Enter on the button approves`,
    );
    await t.key("Meta+Enter");
    await t.waitFor(
      `document.querySelector('[data-testid="sent-banner"]')`,
      `speech ${done}: chord sends`,
    );
    if (done < 3) {
      await t.waitFor(
        `[...document.querySelectorAll('${CARD} button')].some((b) => /^(Draft next|Next):/.test(b.innerText))`,
        `speech ${done}: receipt offers Next`,
      );
      await t.key("Meta+Enter");
      await t.waitFor(
        `!document.querySelector('[data-testid="sent-banner"]') && document.querySelector(${JSON.stringify(CARD)})`,
        `speech ${done}: chord moves to the next one`,
      );
      await settled(t, `speech ${done + 1} drafted`);
    }
  }
  await t.waitFor(
    `document.querySelector(${JSON.stringify(QUEUE)}).innerText.includes("The queue is clear.")`,
    "the queue reports clear when all are done",
  );
  t.assert((await t.text(QUEUE)).includes("3 of 3 sent"), "progress reads 3 of 3");
  const onward = `${CARD} [data-card-primary]`;
  t.assert(
    /^Next in (?!COMM 110)[A-Z]+ \d+: \S/.test(await t.text(onward)),
    "a clear queue's receipt offers the next course's work",
    await t.text(onward),
  );
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
  ]) {
    await t.viewport(width, height);
    t.assert(
      await t.eval(
        `(() => { const label = document.querySelector(${JSON.stringify(`${onward} [title]`)}); return label.scrollWidth <= label.clientWidth; })()`,
      ),
      `at ${width}, the clear queue's way on shows its whole label`,
    );
  }
  await t.viewport(1440, 900);
  await t.shot("queue-clear");
  await t.click("Expand queue");
  await t.shot("queue-clear-expanded");
  await t.click("Collapse queue");
  await t.key("Meta+Enter");
  await t.waitFor(
    `location.pathname !== "/threads/t-c110-speech2"`,
    "⌘↵ on a clear queue moves on to that work",
  );
  await t.shot("queue-clear-moved-on");
  await t.eval(`history.back()`);
  await t.waitFor(
    `location.pathname === "/threads/t-c110-speech2" && document.querySelector(${JSON.stringify(onward)})`,
    "Back returns to the clear queue and its way on",
  );
  await t.click('[aria-label="Close preview"]', { within: PANEL });

  await t.key("Meta+k");
  await t.waitFor(`document.querySelector('[data-testid="palette"]')`, "⌘K opens the palette");
  await t.shot("palette");
  await t.key("Escape");
  await t.waitFor(`!document.querySelector('[data-testid="palette"]')`, "Esc closes the palette");
  await t.key("Meta+b");
  await t.waitFor(`!document.querySelector('[data-testid="sidebar"]')`, "⌘B hides the sidebar");
  await t.key("Meta+b");
  await t.waitFor(`document.querySelector('[data-testid="sidebar"]')`, "⌘B shows it again");
  await t.key("/");
  t.assert(
    (await t.eval(`document.activeElement?.hasAttribute("data-composer")`)) === true,
    "/ focuses the composer",
  );
  await t.key("Escape");
  await t.eval(`document.activeElement?.blur()`);
  await t.key("Meta+d");
  await t.waitFor(
    `document.querySelector('[data-testid="writeback-scroll"]')`,
    "⌘D opens the preview panel",
  );
  await t.key("Escape");
  await t.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, "Esc closes the panel");
  await t.hold("Meta");
  await t.waitFor(
    `[...document.querySelectorAll(".jump-number")].some((el) => getComputedStyle(el).display !== "none")`,
    "holding ⌘ shows the jump numbers",
  );
  await t.release("Meta");
  await t.key("Meta+1");
  await t.waitFor(`location.pathname === "/threads/t-north-star"`, "⌘1 jumps to North Star");
  await t.key("Meta+Shift+]");
  await t.waitFor(`location.pathname !== "/threads/t-north-star"`, "⌘⇧] moves to the next thread");
  await t.key("Meta+Shift+[");
  await t.waitFor(`location.pathname === "/threads/t-north-star"`, "⌘⇧[ moves back");
  const threadRows = () =>
    t.eval(
      `[...document.querySelectorAll('[data-testid="sidebar"] a[href^="/threads/"]')].map((a) => a.getAttribute("href"))`,
    );
  const shown = await threadRows();
  t.assert(
    shown.includes("/threads/t-c110-speech2") && !shown.includes("/threads/t-e101-ann"),
    "the sidebar lists an expanded course's threads and not a collapsed one's",
    shown.join(", "),
  );
  await t.key("Meta+2");
  await t.waitFor(
    `location.pathname === ${JSON.stringify(shown[1])}`,
    "⌘2 opens the second thread on screen",
  );
  await t.key("Meta+1");
  await t.waitFor(`location.pathname === "/threads/t-north-star"`, "⌘1 goes back to North Star");
  await expandCourse(t, "ENG 101");
  await t.click("Week 10: Essay 3 starts Monday", { within: '[data-testid="sidebar"]' });
  await t.click("Draft the announcement");
  await t.waitFor(
    `document.querySelector('[aria-label="Announcement"]')?.closest(${JSON.stringify(CARD)})`,
    "an announcement thread drafts on request",
  );
  await settled(t, "announcement drafted");
  await t.shot("announcement-draft");
  await ask(t, "make it about the midterm review on Friday");
  const labels = (await chipsOnScreen(t)).map((chip) => chip.split(":")[0]);
  t.assert(
    labels.includes("Title") && labels.includes("Announcement"),
    "a retarget names the title and the body apart, so they don't run together",
    labels.join(" | "),
  );
  await t.shot("announcement-retarget");
};

/** Issue #36: a draft that fails leaves the submission open, so "Draft this one", Draft with Claude and a hand grade all work. */
const failedDraft = async (t) => {
  await t.goto("/threads/t-queue");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(QUEUE)})`,
    "failed draft: the list loads",
  );
  await expandQueue(t);
  const row = await t.eval(
    `[...document.querySelectorAll('${LIST} [data-row]')].find((row) => row.innerText.includes("Not started"))?.dataset.row`,
  );
  const student = await t.eval(
    `document.querySelector('[data-row="${row}"] button span[title]').title`,
  );
  await t.eval(`window.__setAgentDown(true)`);
  await t.click(`[data-row="${row}"] button`);
  await opensUndrafted(t, student, "failed draft");
  await draftWithClaude(t);
  await t.waitFor(
    `document.querySelector('[data-testid="agent-working"]') || document.querySelector(${JSON.stringify(OPEN)})`,
    "failed draft: the draft starts",
  );
  await t.waitFor(
    `!document.querySelector('[data-testid="agent-working"]') && document.querySelector(${JSON.stringify(OPEN)})`,
    "failed draft: the submission stays open with Draft with Claude and Grade it yourself",
    15_000,
  );
  t.assert(!(await t.has(CARD)), "failed draft: no card claims a draft");
  t.assert(
    !(await t.eval(`document.querySelector("[data-composer]").placeholder`)).includes("Open a"),
    "failed draft: the composer doesn't ask for a submission that is already open",
    await t.eval(`document.querySelector("[data-composer]").placeholder`),
  );
  await t.shot("failed-draft");
  await t.eval(`window.__setAgentDown(false)`);
  const replies = await ask(t, "Draft this one");
  t.assert(
    !replies.some((reply) => reply.text?.includes("Nothing is open")),
    '"Draft this one" knows which submission is open',
    JSON.stringify(replies),
  );
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes(${JSON.stringify(student)})`,
    '"Draft this one" drafts the student on screen',
  );
  await t.shot("failed-draft-drafted");
  await t.click("Discard", { within: '[data-testid="card-actions"]' });
  await t.waitFor(`!document.querySelector(${JSON.stringify(CARD)})`, "failed draft: discarded");
  await t.goto(`/threads/t-queue`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(QUEUE)})`,
    "failed draft: the list loads",
  );
  await expandQueue(t);
  await t.click(`[data-row="${row}"] button`);
  await opensUndrafted(t, student, "failed draft: reopened after a discard");
  await draftWithClaude(t);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes(${JSON.stringify(student)})`,
    "Draft with Claude drafts the same student",
  );
  await settled(t, "Draft with Claude: agent finished");
  await t.click("Discard", { within: '[data-testid="card-actions"]' });
  await t.waitFor(`!document.querySelector(${JSON.stringify(CARD)})`, "the redraft is discarded");
  await t.goto(`/threads/t-queue`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(QUEUE)})`,
    "failed draft: the list loads",
  );
  await expandQueue(t);
  await t.eval(`window.__setAgentDown(true)`);
  await t.click(`[data-row="${row}"] button`);
  await opensUndrafted(t, student, "failed draft: reopened again");
  await t.click("Grade it yourself", { within: OPEN });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})?.innerText.includes(${JSON.stringify(student)}) && document.querySelector("[data-typed-score], [data-edit-field]")`,
    "Grade it yourself opens a blank form for the same student, with Claude still down",
  );
  await t.shot("failed-draft-by-hand");
  t.assert(
    !(await t.has("[data-composer-examples]")),
    "the hand form offers no corrections of Claude's words (#48)",
  );
  const primary = await t.eval(
    `(() => { const button = document.querySelector('${CARD} [data-card-primary]'); return { text: button?.innerText.trim(), disabled: button?.disabled, note: document.querySelector('${CARD} [data-card-missing]')?.innerText }; })()`,
  );
  t.assert(
    primary.text === "Approve" &&
      primary.disabled &&
      /^Fill in .+ to approve\.$/.test(primary.note),
    "the empty hand form's button is Approve, held until the blanks it names are filled (#48)",
    JSON.stringify(primary),
  );
  await handApproveThenSend(t, student);
  await t.eval(`window.__setAgentDown(false)`);
};

/** A hand grade takes the same two steps as an AI draft: Approve stops at Approved. Not sent, and only Send writes to the LMS (#51). */
const handApproveThenSend = async (t, student) => {
  const scores = await t.eval(`document.querySelectorAll('${CARD} [data-typed-score]').length`);
  for (let index = 0; index < scores; index++) {
    await t.eval(
      `(() => { const input = document.querySelectorAll('${CARD} [data-typed-score]')[${index}]; input.focus(); input.select(); })()`,
    );
    await t.type("1");
    await t.key("Tab");
  }
  await t.eval(`document.querySelector(${JSON.stringify(`${CARD} textarea`)}).focus()`);
  await t.type("Graded by hand.");
  await t.key("Tab");
  await t.waitFor(
    `(() => { const b = document.querySelector('${CARD} [data-approve]'); return b && !b.disabled; })()`,
    "hand form: Approve is ready once the blanks are filled",
  );
  const label = (await t.text(`${CARD} [data-approve]`)).trim();
  t.assert(
    label === "Approve",
    "hand form: the button says Approve, not Approve and send (#51)",
    label,
  );
  const writes = await lms(
    t,
    `lms.submissions.flatMap((s) => s.comments).filter((c) => c.mine).length`,
  );
  await t.click(`${CARD} [data-approve]`);
  await t.waitFor(
    `document.body.innerText.includes("Undo approval") && document.querySelector("[data-send]")`,
    "hand form: Approve stops at Approved. Not sent, with Undo approval and Send (#51)",
  );
  await t.sleep(500);
  const tag = await t.eval(
    `Object.values(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).find((c) => c.subject.startsWith(${JSON.stringify(student)}) && c.state.tag !== "discarded")?.state.tag ?? null`,
  );
  t.assert(
    tag === "approved" &&
      (await lms(t, `lms.submissions.flatMap((s) => s.comments).filter((c) => c.mine).length`)) ===
        writes,
    "hand form: nothing reaches the LMS on Approve (#51)",
    String(tag),
  );
  await t.shot("hand-approved-not-sent");
  await t.click("[data-send]");
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]') || document.querySelector('[data-testid="receipt"]')`,
    "hand form: Send writes the hand grade",
    20_000,
  );
};

const discard = async (t) => {
  await t.goto("/threads/t-queue");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(QUEUE)})`,
    "discard: the grading list loads",
  );
  await expandQueue(t);
  const row = await t.eval(
    `[...document.querySelectorAll('${LIST} [data-row]')].find((row) => row.innerText.includes("Not started"))?.dataset.row`,
  );
  const student = await t.eval(
    `document.querySelector('[data-row="${row}"] button span[title]').title`,
  );
  await t.click(`[data-row="${row}"] button`);
  await opensUndrafted(t, student, "discard");
  await draftWithClaude(t);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(CARD)})`,
    "discard: a draft opens",
    15_000,
  );
  await settled(t, "discard: agent finished");
  await t.click("[data-edit-field]");
  await t.type(" Kept in my own words.");
  await t.eval(`document.activeElement?.blur()`);
  await t.shot("discard-edited");
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('[data-testid="card-actions"] button')].find((b) => b.innerText === "Discard")?.title`,
    )) === "It stays undrafted until you ask for a new draft.",
    "Discard says the grade stays undrafted until the teacher asks again",
  );
  await t.click("Discard", { within: '[data-testid="card-actions"]' });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(CARD)}) && document.querySelector('[data-testid="undo-toast"]')`,
    "Discard asks nothing and offers Undo",
  );
  await t.shot("discard-undo-offered");
  await t.click("Undo", { within: '[data-testid="undo-toast"]' });
  await t.waitFor(
    `(document.querySelector("[data-edit-field]")?.value ?? "").includes("Kept in my own words.")`,
    "Undo brings the grade back with your edit",
  );
  await t.waitFor(`location.search.startsWith("?row=")`, "Undo puts the row back in the URL");
  // Undo slides the preview back in and the comment rewraps after it, with a pause between that a two-sample check reads as still.
  const discardAt = `JSON.stringify([...document.querySelectorAll('[data-testid="card-actions"] button')].find((b) => b.innerText === "Discard")?.getBoundingClientRect())`;
  for (let before = null, tries = 0; tries < 20; tries++) {
    const now = await t.eval(discardAt);
    if (now === before) break;
    before = now;
    await t.sleep(250);
  }
  await t.click("Discard", { within: '[data-testid="card-actions"]' });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(CARD)}) && document.querySelector(${JSON.stringify(LIST)})`,
    "a discarded grade hands the thread back to the list, with no student header over an empty pane",
  );
  t.assert(
    (await t.eval("location.search")) === "?view=list",
    "after the discard the URL names the list",
    await t.eval("location.search"),
  );
  t.assert(
    !(await t.text(QUEUE)).match(/\b\d+ of \d+(?!\d| sent)/),
    "the list no longer claims a place in it",
    await t.text(QUEUE),
  );
  await t.shot("discard-done");
  await t.click(`[data-row="${row}"] button`);
  await opensUndrafted(t, student, "discard: reopened");
  await t.shot("discard-reopened-undrafted");
};

const replyCard = (t) =>
  t.waitFor(`document.querySelector(${JSON.stringify(CARD)})`, "a reply draft opens", 15_000);

const replyDiscard = async (t) => {
  await t.goto("/threads/t-e101-mail");
  await t.waitFor(`document.querySelector("[data-row]")`, "reply discard: the replies list loads");
  const row = await t.eval(
    `[...document.querySelectorAll("[data-row]")].find((row) => !row.innerText.includes("Sent"))?.dataset.row`,
  );
  await t.click(`[data-row="${row}"] button`);
  await replyCard(t);
  await settled(t, "reply discard: agent finished");
  await ask(t, "make it warmer");
  await ask(t, "Make it shorter");
  const shaped = await t.eval(`document.querySelector("[data-edit-field]").value`);
  const entries = await t.eval("history.length");
  await t.click("Discard", { within: '[data-testid="card-actions"]' });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(CARD)}) && document.querySelector('${CHAT} [data-testid="history"]')`,
    "after Discard on a reply, the student's message stays in view",
  );
  t.assert(
    !(await t.has('[role="dialog"]')) &&
      (await t.text('[data-testid="undo-toast"]')).startsWith("Discarded"),
    "Discard on a reply shaped by your corrections asks nothing and offers Undo",
  );
  t.assert(
    await t.eval(
      `[...document.querySelectorAll(${JSON.stringify(`${CHAT} button`)})].some((b) => b.innerText === "Draft a reply")`,
    ),
    "a discarded reply offers Draft a reply",
  );
  t.assert(
    (await t.eval("history.length")) === entries &&
      (await t.eval("location.pathname")) === "/threads/t-e101-mail",
    "Discard stays on the thread and adds no history entry, so Back leaves it as before",
  );
  await t.shot("reply-discarded");
  await t.click("Undo", { within: '[data-testid="undo-toast"]' });
  await replyCard(t);
  t.assert(
    (await t.eval(`document.querySelector("[data-edit-field]").value`)) === shaped,
    "Undo brings the reply back with the corrections you asked for",
  );
  await t.shot("reply-discard-undone");
  await t.click("Discard", { within: '[data-testid="card-actions"]' });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(CARD)})`,
    "the reply is discarded again",
  );
  const said = await ask(t, "Draft a reply");
  t.assert(
    !said.some((m) => m.text?.startsWith("Open a submission")),
    "asking the composer to draft drafts the open conversation",
    said,
  );
  await replyCard(t);
  await t.shot("reply-drafted-from-composer");
  await t.click("Discard", { within: '[data-testid="card-actions"]' });
  await t.click("Draft a reply", { within: CHAT });
  await replyCard(t);
  await settled(t, "reply discard: drafted again from the button");
  await t.shot("reply-drafted-from-button");
};

export const run = async (t) => {
  await setup(t);
  await pinnedQueue(t);
  await rationale(t);
  await motion(t);
  await correction(t);
  await approval(t);
  await resubmission(t);
  await reconnect(t);
  await conflict(t);
  await partial(t);
  await rejected(t);
  await exhausted(t);
  await inDoubt(t);
  await lostResponse(t);
  await interrupted(t);
  await batch(t);
  await replies(t);
  await keyboardAndClear(t);
  await discard(t);
  await replyDiscard(t);
  await failedDraft(t);
};
