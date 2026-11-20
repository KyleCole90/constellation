import { onboard } from "./onboard.mjs";

export const run = async (t) => {
  await t.viewport(1440, 900);
  await t.goto("/welcome");
  await t.click("Set up");
  await t.waitFor(
    `document.querySelector('[data-testid="ai-choices"]')`,
    "setup shows the AI choice",
  );
  t.assert(
    !(await t.has('input[name="ai-source"][value="claude-code"]')) &&
      !(await t.pageText()).includes("Claude Code"),
    "the web demo's setup never offers Claude Code",
  );
  await t.goto("/welcome");
  await onboard(t);
  await t.waitFor(`location.pathname === "/due"`, "onboarding lands on What's due");
  await t.goto("/settings");
  await t.waitText(
    "Each school's token stays in this browser's vault",
    "in the demo, Settings says tokens stay in this browser's vault",
  );
  await t.goto("/settings?section=ai");
  await t.waitFor(
    `document.querySelector('[data-testid="ai-card"]')`,
    "Settings opens on its AI section",
  );
  t.assert(
    !(await t.pageText()).includes("Claude Code"),
    "the web demo's Settings › AI never offers Claude Code",
  );
};
