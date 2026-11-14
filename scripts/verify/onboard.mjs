// The one way a script reaches a connected app: welcome, Set up, fill the demo schools and tokens, Connect each row, choose AI, Finish.
// `onboard` drives the CDP harness in scripts/verify.mjs, and `onboardPage` drives a Playwright page. Both take the same options.
// ai: "none" lands on What's due, "key" saves a demo key and lands on North Star. hosts: connect only these, by address.

const ROWS = "[data-host]";
const row = (host) => `[data-host="${host}"]`;
const RADIO = (ai) => `input[name="ai-source"][value="${ai}"]`;
const KEY_ROW = '[data-ai-source="key"]';

export const onboard = async (t, { ai = "none", hosts = null } = {}) => {
  await t.click("Set up");
  await t.click("Try it with demo schools");
  await t.waitFor(
    `document.querySelectorAll(${JSON.stringify(ROWS)}).length > 0`,
    "the demo fill adds a row per demo school",
  );
  const all = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(ROWS)})].map((el) => el.dataset.host)`,
  );
  for (const host of hosts ?? all) {
    await t.click(`${row(host)} button[type="submit"]`);
    await t.waitFor(
      `document.querySelector(${JSON.stringify(row(host))})?.dataset.connection === "connected"`,
      `${host} connects with its demo token`,
      20_000,
    );
  }
  await t.click(RADIO(ai));
  if (ai === "key") {
    await t.click("Use a demo key", { within: KEY_ROW });
    await t.waitFor(
      `document.querySelector(${JSON.stringify(KEY_ROW)})?.innerText.includes("Key saved")`,
      "the demo AI key is saved",
    );
  }
  await t.click("Finish setup");
};

export const onboardPage = async (
  page,
  { ai = "none", hosts = null, click = (locator) => locator.click() } = {},
) => {
  await click(page.getByRole("button", { name: "Set up", exact: true }));
  await click(page.getByRole("button", { name: "Try it with demo schools" }));
  await page.waitForFunction((rows) => document.querySelectorAll(rows).length > 0, ROWS);
  const all = await page.locator(ROWS).evaluateAll((els) => els.map((el) => el.dataset.host));
  for (const host of hosts ?? all) {
    await click(page.locator(`${row(host)} button[type="submit"]`));
    await page.locator(`${row(host)}[data-connection="connected"]`).waitFor({ timeout: 20_000 });
  }
  await click(page.locator(RADIO(ai)));
  if (ai === "key") {
    await click(page.locator(KEY_ROW).getByRole("button", { name: "Use a demo key" }));
    await page.locator(KEY_ROW).getByText("Key saved").waitFor();
  }
  await click(page.getByRole("button", { name: "Finish setup" }));
};
