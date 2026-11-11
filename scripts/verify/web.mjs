// `npm run verify:web`: the demo build loads, and onboarding finishes.
import { onboard } from "./onboard.mjs";

export const run = async (t) => {
  await t.viewport(1440, 900);
  await t.goto("/welcome");
  await onboard(t);
  await t.waitFor(`location.pathname === "/due"`, "onboarding lands on What's due");
  await t.goto("/settings");
  await t.waitText(
    "Each school's token stays in this browser's vault",
    "in the demo, Settings says tokens stay in this browser's vault",
  );
};
