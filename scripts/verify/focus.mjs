import { addAiKey } from "./ai-key.mjs";

const QUIET = JSON.stringify({
  rate429: 0,
  rate5xx: 0,
  rateLost: 0,
  latencyMs: [20, 60],
});
const ROWS = "[data-host]";
const DIALOG = '[role="dialog"]';
const PALETTE = '[data-testid="palette"]';
const OFF_SIDEBAR = ':not(body):not([data-testid="sidebar"] *)';
const CARD = (school) => `[data-school="${school}"]`;

const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "body";
  const name = el.getAttribute("aria-label") || el.innerText?.trim() || el.placeholder || el.name || "";
  return el.tagName.toLowerCase() + (name ? " " + JSON.stringify(name.slice(0, 40)) : "");
})()`;

const focusIs = async (t, selector, label) => {
  const ok = await t.eval(`Boolean(document.activeElement?.matches(${JSON.stringify(selector)}))`);
  t.assert(ok, `${label} (focus is on ${await t.eval(FOCUSED)})`);
};

const settle = (t) => t.sleep(300);

const press = async (t, selector) => {
  await t.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await t.key("Enter");
};

const PANEL = '[data-testid="thread-panel"]';
const H1 = "h1";
const CHATS = '[data-testid="sidebar-chats"]';
const SETTLED = '[data-testid="settled-area"]';
const CHAT_LINK = "[data-settle-row] > a";

const setup = async (t) => {
  await t.viewport(1440, 900);
  await t.goto("/welcome");
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await t.reload();
  await t.click("Set up");
  await t.waitFor(`document.querySelector('[data-testid="address-field"]')`, "Set up opens setup");
  await settle(t);
  await focusIs(t, '[data-testid="address-field"]', "Set up focuses the address field");
  await t.shot("focus-after-set-up");

  await t.click('[data-testid="address-field"]');
  await t.type("canvas.focus-check.edu");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector('[data-host="canvas.focus-check.edu"]')`,
    "Enter adds the typed address as a row",
  );
  await settle(t);
  await focusIs(
    t,
    '[data-host="canvas.focus-check.edu"] input[type="password"]',
    "adding an address focuses its token field",
  );
  await t.shot("focus-after-add-address");
  await t.click('[aria-label="Remove canvas.focus-check.edu"]');

  await t.click("Use demo institutions and tokens");
  await t.waitFor(`document.querySelectorAll("${ROWS}").length > 1`, "the demo fill adds rows");
  const hosts = await t.eval(
    `[...document.querySelectorAll("${ROWS}")].map((el) => el.dataset.host)`,
  );
  for (const [i, host] of hosts.entries()) {
    await t.click(`[data-host="${host}"] button[type="submit"]`);
    await t.waitFor(
      `document.querySelector('[data-host="${host}"]')?.dataset.connection === "connected"`,
      `${host} connects`,
      20_000,
    );
    await settle(t);
    const next = hosts[i + 1];
    if (next)
      await focusIs(
        t,
        `[data-host="${next}"] input[type="password"]`,
        `Connect on ${host} moves focus to the next school's token field`,
      );
    else
      await focusIs(
        t,
        'input[name="ai-source"]',
        "Connect on the last school moves focus to the AI choice",
      );
    await t.shot(`focus-after-connect-${i + 1}`);
  }
  await t.click('input[name="ai-source"][value="none"]');
  await t.click("Finish setup");
  await t.waitFor(`location.pathname === "/due"`, "Finish setup lands on What's due");
  await settle(t);
  await focusIs(t, H1, "Finish setup lands focus on What's due's heading");
  await t.shot("focus-after-finish-setup");
};

const disconnect = async (t) => {
  await t.goto("/settings");
  await t.waitFor(`document.querySelector('${CARD("rsu")}')`, "Settings shows the school cards");
  await t.click("Disconnect", { within: CARD("rsu") });
  await t.click("Disconnect", { within: DIALOG });
  await t.waitFor(
    `document.querySelector('${CARD("rsu")}')?.dataset.connection === "disconnected" && !document.querySelector('${DIALOG}')`,
    "Disconnect closes the ask and leaves the school not connected",
  );
  await settle(t);
  await focusIs(
    t,
    `${CARD("rsu")} footer button`,
    "after Disconnect, focus lands in the card's actions",
  );
  t.assert(
    (await t.eval(`document.activeElement.innerText.trim()`)) === "Connect",
    "after Disconnect, the focused action is Connect, not Remove school",
  );
  await t.shot("focus-after-disconnect");

  await press(t, '[data-testid="settings-nav"] a[href="/settings?section=ai"]');
  await t.waitFor(`location.search === "?section=ai"`, "the AI link opens the AI section");
  await t.eval("history.back()");
  await t.waitFor(`location.search === ""`, "Back returns to Connections");
  await settle(t);
  await focusIs(
    t,
    '[data-testid="settings-nav"] a[href="/settings"]',
    "Back between Settings sections moves focus to the section on screen",
  );
  await t.shot("focus-after-settings-back");
};

const palette = async (t) => {
  await t.click('[title^="Search threads"]');
  await t.waitFor(`document.querySelector('${PALETTE}')`, "the Search button opens the palette");
  await t.key("Escape");
  await t.waitFor(`!document.querySelector('${PALETTE}')`, "Escape closes the palette");
  await settle(t);
  await focusIs(t, '[title^="Search threads"]', "closing the palette returns focus to Search");
  await t.shot("focus-after-palette-escape");

  await t.click('[title^="Search threads"]');
  await t.waitFor(`document.querySelector('${PALETTE}')`, "the palette opens again");
  await t.type("sync");
  await t.key("Enter");
  await t.waitFor(
    `!document.querySelector('${PALETTE}')`,
    "Enter on Sync runs it and closes the palette",
  );
  await settle(t);
  await focusIs(
    t,
    '[title^="Search threads"]',
    "a palette result that stays on this screen returns focus to Search",
  );
  await t.shot("focus-after-palette-enter");

  await t.click('[title^="Search threads"]');
  await t.waitFor(`document.querySelector('${PALETTE}')`, "the palette opens for a screen");
  await t.type("calendar");
  await t.key("Enter");
  await t.waitFor(`location.pathname === "/calendar"`, "Enter on Calendar opens the calendar");
  await settle(t);
  await focusIs(t, H1, "a palette result that opens a screen lands focus on its heading");
  await t.shot("focus-after-palette-screen");
};

const discard = async (t) => {
  await addAiKey(t);
  await t.waitFor(`location.pathname === "/threads/t-queue"`, "the AI key opens the grading list");
  if (!(await t.has('[data-testid="queue-list"]'))) await t.click("Expand queue");
  const row = await t.eval(
    `[...document.querySelectorAll('[data-testid="queue-list"] [data-row]')].find((row) => row.innerText.includes("Not started"))?.dataset.row`,
  );
  // With no panel animation to re-place the chat, a card that settles after the agent finishes must not move Discard out from under the press.
  await t.media({ "prefers-reduced-motion": "reduce" });
  await t.click(`[data-row="${row}"] button`);
  await t.waitFor(`document.querySelector("[data-focused]")`, "a draft opens", 15_000);
  await t.waitFor(`!document.querySelector('[data-testid="agent-working"]')`, "the agent finished");
  await t.click("[data-edit-field]");
  await t.type(" Mine.");
  await t.click("Discard", { within: '[data-testid="card-actions"]' });
  await t.waitFor(
    `!document.querySelector("[data-focused]") && !document.querySelector('${DIALOG}')`,
    "Discard removes the draft, with reduced motion on",
  );
  await t.media({});
  await settle(t);
  await focusIs(t, OFF_SIDEBAR, "after Discard, focus stays in the thread");
  await focusIs(t, '[data-testid="queue-start"]', "after Discard, focus lands on Start grading");
  await t.shot("focus-after-discard");
};

const named = (scope, text) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.trim().startsWith(${JSON.stringify(text)}))`;
const pressNamed = async (t, scope, text) => {
  await t.eval(`${named(scope, text)}.focus()`);
  await t.key("Enter");
};
const focusedText = (t) => t.eval(`document.activeElement.innerText?.trim() ?? ""`);

const APPROVE = `${PANEL} [data-approve]`;
const openPreview = async (t) => {
  await t.waitFor(`document.querySelector("[data-approve]")`, "the draft is ready", 20_000);
  await t.click("Preview", { within: '[role="tablist"]' });
  await t.waitFor(`document.querySelector('${APPROVE}')`, "Preview opens with Approve");
};

const approval = async (t) => {
  await press(t, '[data-testid="queue-start"]');
  await t.waitFor(`document.querySelector('${PANEL}')`, "Start grading opens a row");
  await settle(t);
  await focusIs(
    t,
    `:is(${PANEL}, [data-typed-score])`,
    "Start grading lands focus on the row it opened, not the queue's arrows",
  );
  await t.shot("focus-after-start-grading");

  await openPreview(t);
  await press(t, APPROVE);
  await t.waitFor(`Boolean(${named(PANEL, "Undo approval")})`, "Approve approves");
  await settle(t);
  t.assert(
    (await focusedText(t)).startsWith("Send to"),
    `after Approve, focus lands on Send, the second and last step (focus is on ${await t.eval(FOCUSED)})`,
  );
  await t.shot("focus-after-approve");

  await pressNamed(t, PANEL, "Undo approval");
  await t.waitFor(`document.querySelector('${APPROVE}')`, "Undo approval brings Approve back");
  await settle(t);
  await focusIs(t, APPROVE, "after Undo approval, focus lands on Approve, not Discard");
  await t.shot("focus-after-undo-approval");

  await press(t, APPROVE);
  await t.waitFor(`Boolean(${named(PANEL, "Send to")})`, "Approve offers Send");
  await pressNamed(t, PANEL, "Send to");
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]')`,
    "Send writes the grade",
    20_000,
  );
  await settle(t);
  await focusIs(t, PANEL, "after Send, focus stays on the preview, not the body");
  await t.shot("focus-after-send");

  await pressNamed(t, PANEL, "Next:");
  await openPreview(t);
  await press(t, APPROVE);
  await t.waitFor(`Boolean(${named(PANEL, "Undo approval")})`, "the next draft is approved");
  await pressNamed(t, PANEL, "Undo approval");
  await t.waitFor(`document.querySelector('${APPROVE}')`, "its approval is undone");
  await settle(t);
  await t.key("Enter");
  await settle(t);
  t.assert(
    (await t.has("[data-focused]")) &&
      (await t.eval(`Boolean(${named(PANEL, "Undo approval")})`)) &&
      (await focusedText(t)).startsWith("Send to"),
    "Enter after Undo approval approves again, sends nothing, and waits on Send",
  );
  await t.shot("focus-undo-enter-enter");
};

const review = async (t) => {
  if (!(await t.has('[data-testid="queue-list"]'))) await t.click("Expand queue");
  const boxes = await t.eval(
    `[...document.querySelectorAll('[data-testid="queue-list"] [data-row] input[type="checkbox"]:not(:disabled)')].map((box) => box.closest("[data-row]")).filter((row) => !/Ready to send|Approved|Sent/.test(row.innerText)).slice(0, 2).map((row) => row.dataset.row)`,
  );
  for (const row of boxes) await t.click(`[data-row="${row}"] input[type="checkbox"]`);
  const button = (label) =>
    `[...document.querySelectorAll('[data-testid="pinned-queue"] button')].find((b) => b.innerText.startsWith(${JSON.stringify(label)}))`;
  await t.eval(`${button("Draft")}.click()`);
  await t.waitFor(`Boolean(${button("Review")})`, "the selected rows are drafted", 30_000);
  await t.eval(`${button("Review")}.focus()`);
  await t.key("Enter");
  await t.waitFor(`document.querySelector('${PANEL}')`, "Review opens the batch");
  await settle(t);
  await focusIs(t, PANEL, "after Review, focus lands on the batch, not Clear");
  await t.shot("focus-after-review");

  await press(t, APPROVE);
  await t.waitFor(`Boolean(${named(PANEL, "Send")})`, "Approve approves the batch");
  await settle(t);
  await focusIs(t, PANEL, "after the batch's Approve, focus stays on the batch, not Send");
  await t.shot("focus-after-batch-approve");
};

const cancelSetup = async (t) => {
  await t.goto("/due");
  const offer = '[data-testid="setup-offer"][data-surface="due"]';
  await t.waitFor(`document.querySelector('${offer}')`, "What's due offers a course to set up");
  const course = await t.eval(`document.querySelector('${offer}').dataset.course`);
  const row = `${offer}[data-course="${course}"]`;
  await t.click("Set up this course", { within: row });
  await t.waitFor(
    `location.pathname.startsWith("/threads/")`,
    "Set up this course opens its thread",
  );
  await t.goto("/due");
  await t.waitFor(
    `document.querySelector('${row}')?.innerText.includes("Cancel setup")`,
    "the offer can cancel its setup",
  );
  await t.eval(
    `[...document.querySelectorAll('${row} button')].find((b) => b.innerText === "Cancel setup").focus()`,
  );
  await t.key("Enter");
  await t.waitFor(
    `!document.querySelector('${row}').innerText.includes("Cancel setup")`,
    "Cancel setup cancels it",
  );
  await settle(t);
  t.assert(
    (await t.eval(
      `document.activeElement.closest('${row}') && document.activeElement.innerText.trim()`,
    )) === "Set up this course",
    `after Cancel setup, focus lands on Set up this course, not Dismiss (focus is on ${await t.eval(FOCUSED)})`,
  );
  await t.shot("focus-after-cancel-setup");
};

const chats = async (t) => {
  for (const ask of ["What's due this week?", "Find Harper"]) {
    await t.click('[data-testid="sidebar"] a[href="/threads/t-north-star"]');
    await t.waitFor(`document.querySelector("[data-composer]")`, "North Star takes an ask");
    await t.click("[data-composer]");
    await t.type(ask);
    await t.key("Enter");
    await t.waitFor(
      `document.querySelector('[data-testid="chat"]')`,
      `asking "${ask}" opens a chat`,
    );
    await t.waitFor(
      `!document.querySelector('[data-testid="agent-working"]')`,
      `"${ask}" is answered`,
      20_000,
    );
  }
  const rows = () => t.eval(`document.querySelectorAll('${CHATS} li').length`);
  const before = await rows();
  await press(t, `${CHATS} li button[aria-label="Settle thread"]`);
  await t.waitFor(
    `document.querySelectorAll('${CHATS} li').length === ${before - 1}`,
    "Settle settles the chat",
  );
  await settle(t);
  await focusIs(
    t,
    `${CHATS} ${CHAT_LINK}`,
    "after Settle, focus lands on the next chat, not its Settle",
  );
  await t.key("Enter");
  await settle(t);
  t.assert(
    (await rows()) === before - 1,
    "Enter twice after Settle opens the next chat and settles nothing more",
  );
  await t.shot("focus-settle-enter-enter");

  await t.click("Settled", { within: SETTLED });
  await t.waitFor(`document.querySelector('${SETTLED} li')`, "the Settled area opens");
  const left = await rows();
  await press(t, `${SETTLED} li button[aria-label="Resume thread"]`);
  await t.waitFor(
    `document.querySelectorAll('${CHATS} li').length === ${left + 1}`,
    "Resume brings the chat back",
  );
  await settle(t);
  await focusIs(t, CHAT_LINK, "after Resume, focus lands on a chat, not Settings");
  await t.shot("focus-after-resume");
};

const resetDemo = async (t) => {
  await t.click('[data-testid="sidebar"] a[href="/threads/t-north-star"]');
  await t.waitFor(`document.querySelector("[data-composer]")`, "North Star opens");
  await t.key("Meta+k");
  await t.waitFor(`document.querySelector('${PALETTE} input')`, "the palette opens on North Star");
  await t.type("Reset demo");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector('${DIALOG}')?.innerText.includes("Reset demo data?")`,
    "the palette's Reset asks first",
  );
  await t.shot("focus-palette-reset-on-north-star");
  let frozen;
  const froze = new Promise((_, reject) => {
    frozen = setTimeout(
      () => reject(new Error("the page froze after Reset demo data with North Star open")),
      15_000,
    );
  });
  await Promise.race([
    (async () => {
      await t.click("Reset demo data", { within: DIALOG });
      await t.waitFor(
        `location.pathname === "/welcome" && !document.querySelector('${DIALOG}')`,
        "Reset from the palette with North Star open lands on /welcome",
      );
    })(),
    froze,
  ]).finally(() => clearTimeout(frozen));
  await settle(t);
  await focusIs(t, H1, "after Reset demo data, focus lands on the welcome heading");
  await t.shot("focus-after-reset-demo");
  await t.key("Tab");
  await t.waitFor(
    `document.activeElement?.innerText?.trim() === "Set up"`,
    "after the reset, Tab moves from the heading to Set up",
  );
  await t.eval("history.back()");
  await settle(t);
  t.assert(
    (await t.eval("location.pathname")) === "/welcome",
    "Back after the reset stays on /welcome",
  );
};

export const run = async (t) => {
  await setup(t);
  await disconnect(t);
  await palette(t);
  await discard(t);
  await approval(t);
  await review(t);
  await cancelSetup(t);
  await chats(t);
  await resetDemo(t);
};
