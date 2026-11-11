const SIDEBAR = '[data-testid="sidebar"]';
const NAV = '[data-testid="settings-nav"]';
const ROW = '[data-testid="ai-source-row"]';
const DIALOG = '[role="dialog"]';

export const addAiKey = async (t) => {
  await t.click("Settings", { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(NAV)})`,
    "Settings opens to add an AI key",
  );
  await t.click("AI", { within: NAV });
  await t.click("Use a key", { within: ROW });
  await t.click(`${DIALOG} input[type="password"]`);
  await t.type("verify-ai-key");
  await t.click("Save key", { within: DIALOG });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ROW)})?.innerText.includes("Anthropic key")`,
    "the AI key is saved",
  );
  await t.openGradingList();
};

export const removeAiKey = async (t) => {
  await t.click("Settings", { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(NAV)})`,
    "Settings opens to remove the AI key",
  );
  await t.click("AI", { within: NAV });
  await t.click("Remove key", { within: ROW });
  await t.click("Remove key", { within: DIALOG });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ROW)})?.innerText.includes("Off")`,
    "the AI key is removed",
  );
};
