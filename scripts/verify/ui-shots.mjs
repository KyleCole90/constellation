// The design review set: every surface at 1440x900 and 1180x800, from the same seed every run.
// `VERIFY_SHOTS=out/ui-shots node scripts/verify.mjs --only=ui-shots`
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { addAiKey } from "./ai-key.mjs";

const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const SIDEBAR = '[data-testid="sidebar"]';
const NORTH_STAR = "/threads/t-north-star";
const id = (name) => `[data-testid="${name}"]`;
const WIDTHS = [
  [1440, 900],
  [1180, 800],
];

const idle = (t) =>
  t.waitFor(
    `!document.querySelector('[data-testid="agent-working"]') && !document.getAnimations().some((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity)`,
    "nothing is still moving",
    30_000,
  );

// `pose` sets the hover or focus a shot shows. It runs again at each width, because a resize moves what the pointer is over. The default parks the pointer in the corner, so a click from the step before doesn't leave a hover in the shot.
const blur = async (t) => {
  await t.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  await t.eval(`document.activeElement?.blur?.()`);
};

const snap = async (t, name, pose = blur) => {
  for (const [width, height] of WIDTHS) {
    await t.viewport(width, height);
    await t.sleep(400);
    await idle(t);
    await pose(t);
    await t.sleep(200);
    const { data } = await t.cdp("Page.captureScreenshot", { format: "png" });
    await writeFile(join(t.shots, `${name}-${width}.png`), Buffer.from(data, "base64"));
  }
  await t.viewport(1440, 900);
  console.log(`shot  ${name}`);
};

const settled = (t, what) =>
  t.waitFor(`!document.querySelector('[data-testid="agent-working"]')`, what, 30_000);

export const run = async (t) => {
  for (const file of await readdir(t.shots))
    if (file.endsWith(".png")) await rm(join(t.shots, file));
  await t.viewport(1440, 900);
  await t.goto("/welcome");
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await t.reload();
  await t.waitText("Set up");
  await snap(t, "01-welcome");

  await t.click("Set up");
  await t.waitFor(`document.querySelector('input[name="ai-source"]')`, "setup page");
  await snap(t, "02-setup-finish-disabled");

  await t.click("Use demo institutions and tokens");
  await t.waitFor(`document.querySelectorAll("[data-host]").length > 0`, "demo rows");
  const hosts = await t.eval(
    `[...document.querySelectorAll("[data-host]")].map((el) => el.dataset.host)`,
  );
  for (const host of hosts) {
    await t.click(`[data-host="${host}"] button[type="submit"]`);
    await t.waitFor(
      `document.querySelector('[data-host="${host}"]')?.dataset.connection === "connected"`,
      `${host} connects`,
      20_000,
    );
  }
  await t.click(`input[name="ai-source"][value="none"]`);
  await t.click("Finish setup");
  await t.waitFor(`location.pathname === "/due"`, "lands on What's due");
  await snap(t, "03-whats-due");

  await addAiKey(t);
  await t.waitFor(`document.querySelector(${JSON.stringify(id("queue-list"))})`, "grading list");
  await snap(t, "04-grading-list");
  // A Tab press first, so the focus that follows shows the keyboard ring.
  await snap(t, "15-keyboard-focus", async () => {
    await t.key("Tab");
    await t.eval(`document.querySelector('${id("queue-list")} li:nth-child(2) button')?.focus()`);
  });

  await t.click("Maya Ortiz", { within: id("queue-list") });
  await t.waitFor(
    `document.querySelector("[data-focused]")?.innerText.includes("Maya Ortiz, Essay 2")`,
    "Maya's draft",
  );
  await settled(t, "draft finished");
  await snap(t, "05-grading-draft");

  await t.click(`${SIDEBAR} a[href="${NORTH_STAR}"]`);
  await t.waitFor(`document.querySelector(${JSON.stringify(id("next-up"))})`, "Next up");
  await snap(t, "06-north-star-home");

  await t.click("[data-composer]");
  await t.type("Reply to Imani Okafor");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("handoff-group"))})`,
    "handoff card",
    20_000,
  );
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(id("handoff-group"))}).innerText.includes("Working")`,
    "handoff settled",
    20_000,
  );
  await settled(t, "chat settled");
  await snap(t, "07-north-star-chat-draft");

  await t.click("Messages", { within: SIDEBAR });
  await t.waitFor(`document.querySelector(${JSON.stringify(id("conversation-list"))})`, "inbox");
  await snap(t, "16-inbox-hover", async () => {
    await blur(t);
    await t.hover(`[data-conversation]`, { nth: 1 });
  });
  await t.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  const target = await t.eval(
    `document.querySelector('[data-conversation][data-unread="true"]').dataset.conversation`,
  );
  await t.click(`[data-conversation="${target}"] button`);
  await t.waitFor(`document.querySelector("[data-focused]")`, "reply drafted", 15_000);
  await settled(t, "reply settled");
  await t.click("Preview", { within: id("card-actions") });
  await t.waitFor(
    `document.querySelector('${id("thread-panel")} [data-field="message"]')`,
    "preview open",
  );
  await snap(t, "08-messages-preview");

  await t.click("Calendar", { within: SIDEBAR });
  await t.waitFor(`document.querySelector(${JSON.stringify(id("calendar-grid"))})`, "calendar");
  await snap(t, "09-calendar");

  await t.click("ENG 101", { within: SIDEBAR });
  await t.click("Gradebook", { within: id("course-tabs") });
  await t.waitFor(`document.querySelector(${JSON.stringify(id("gradebook-scroll"))})`, "gradebook");
  await snap(t, "10-gradebook");

  await t.click("Settings", { within: SIDEBAR });
  await t.waitFor(`document.querySelector('[data-school="lcc"]')`, "connections");
  await snap(t, "11-settings-connections");
  await t.click("Demo", { within: id("settings-nav") });
  await t.waitFor(`document.querySelector('[role="switch"][aria-label="Demo script"]')`, "demo");
  await snap(t, "12-settings-demo");

  await t.click("What's due", { within: SIDEBAR });
  await t.waitFor(`document.querySelector(${JSON.stringify(id("offer-banner"))})`, "offers");
  const course = await t.eval(
    `[...document.querySelectorAll('[data-testid="setup-offer"][data-surface="due"]')].find((el) => el.innerText.includes("ENG 101")).dataset.course`,
  );
  await t.click(
    `[data-testid="setup-offer"][data-surface="due"][data-course="${course}"] button:not([aria-label])`,
  );
  await t.click(id("source-course-ENG 101"));
  await t.waitFor(`document.querySelector(${JSON.stringify(id("dates-card"))})`, "dates step");
  await t.click(id("day-new-1"));
  await t.click(id("day-new-3"));
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("day-map"))})?.innerText.includes("Thursday becomes Wednesday")`,
    "day map",
  );
  await snap(t, "13-term-dates");

  await t.click("Settings", { within: SIDEBAR });
  await t.click("Connections", { within: id("settings-nav") });
  await t.click("Disconnect", { within: '[data-school="lcc"]' });
  await t.click("Disconnect", { within: '[role="dialog"]' });
  await t.waitFor(
    `document.querySelector('[data-school="lcc"]')?.dataset.connection === "disconnected"`,
    "Lakeshore disconnected",
  );
  await t.click(`${SIDEBAR} a[href="${NORTH_STAR}"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(id("next-up"))})?.innerText.includes("is disconnected")`,
    "Next up names the disconnected school",
  );
  await snap(t, "14-error-disconnected");
};
