// A real account's first run: the fakes with no demo, so no seeded thread stands in for a built-in one (#114).
// The teacher types a school's address and a token, the way a real Canvas teacher does, with AI on and with No AI.
import { KEY } from "./storage.mjs";

const HOST = "lakeshore.instructure.com";
const ROW = `[data-host="${HOST}"]`;
const DIALOG = '[role="dialog"]';
const SIDEBAR = '[data-testid="sidebar"]';
const BUILT_IN = ["t-north-star", "t-queue", "t-inbox"];

const firstRun = async (t, ai) => {
  await t.goto("/welcome");
  // The first load saved the demo's threads, so the switch starts from empty storage.
  await t.eval(`sessionStorage.setItem("verify.demo", "off"); localStorage.clear()`);
  await t.reload();
  await t.click("Set up");
  t.assert(
    !(await t.eval(`document.body.innerText.includes("Try it with demo schools")`)),
    `${ai}: Setup offers no demo schools`,
  );
  await t.click('[data-testid="address-field"]');
  await t.type(HOST);
  await t.key("Enter");
  await t.click(`${ROW} input[type="password"]`);
  await t.type("first-run-token-0123456789");
  await t.click(`${ROW} button[type="submit"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ROW)})?.dataset.connection === "connected"`,
    `${ai}: the typed school connects`,
    20_000,
  );
  await t.click(`input[name="ai-source"][value="${ai}"]`);
  if (ai === "key") {
    await t.click("Use a demo key", { within: '[data-ai-source="key"]' });
    await t.waitFor(
      `document.querySelector('[data-ai-source="key"]')?.innerText.includes("Key saved")`,
      `${ai}: the AI key is saved`,
    );
  }
  await t.click("Finish setup");
};

const opensBuiltIns = async (t, ai) => {
  const home = ai === "key" ? "/threads/t-north-star" : "/due";
  await t.waitFor(
    `location.pathname === ${JSON.stringify(home)} && !!document.querySelector(${JSON.stringify(SIDEBAR)})`,
    `${ai}: Finish lands on ${home}, inside the app`,
  );
  const saved = await t.eval(`Object.keys(JSON.parse(localStorage.getItem(${KEY})).state.threads)`);
  t.assert(
    BUILT_IN.every((id) => saved.includes(id)),
    `${ai}: the saved workspace holds North Star, the grading list and Messages`,
    JSON.stringify(saved),
  );
  if (ai === "key")
    t.assert(
      await t.eval(
        `document.querySelector(${JSON.stringify(SIDEBAR)})?.innerText.includes("North Star")`,
      ),
      `${ai}: the sidebar links North Star`,
    );

  // Every step navigates inside the app: a page load reboots it, and boot drops the fake schools a real account never has.
  await t.click("Messages", { within: SIDEBAR });
  await t.waitFor(
    `location.pathname === "/inbox" && !!document.querySelector('[data-testid="inbox-list"]')`,
    `${ai}: Messages opens`,
  );
  await t.click("What's due", { within: SIDEBAR });
  await t.click("Grading list");
  await t.waitFor(
    `location.pathname === "/threads/t-queue"`,
    `${ai}: What's due opens the grading list`,
  );
  await t.key("Meta+k");
  await t.waitFor(`document.querySelector('${DIALOG} input')`, `${ai}: search opens`);
  await t.type("Maya");
  await t.click("to grade", { within: DIALOG });
  await t.waitFor(
    `/^\\/threads\\//.test(location.pathname) && !document.querySelector(${JSON.stringify(DIALOG)})`,
    `${ai}: a student from search opens their work`,
  );
  await t.shot(`first-run-${ai}`);
};

export const run = async (t) => {
  await t.viewport(1440, 900);
  for (const ai of ["key", "none"]) {
    if (ai !== "key") await t.fresh();
    await firstRun(t, ai);
    await opensBuiltIns(t, ai);
  }
};
