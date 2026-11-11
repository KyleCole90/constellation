// The live app is wired the way tests/security.test.ts checks the parts: main serves app:// under the CSP, the window
// runs sandboxed with only the preload's bridge, main parses what crosses it, and navigation stays locked.
import { APP_URL, CSP } from "../../src/main/security.ts";

export const run = async (t) => {
  await t.goto(APP_URL);
  await t.waitFor(
    `!!document.querySelector("h1")?.innerText.trim()`,
    "the built app renders its first screen under app://",
  );
  const header = await t.eval(
    `fetch(location.href).then((response) => response.headers.get("content-security-policy"))`,
  );
  t.assert(header === CSP, "an app:// response carries the CSP", header);
  const globals = await t.eval(
    `({ process: typeof process, require: typeof require, bridge: Object.keys(window.constellation ?? {}) })`,
  );
  t.assert(
    globals.process === "undefined" &&
      globals.require === "undefined" &&
      JSON.stringify(globals.bridge) === '["invoke"]',
    "the page has no process or require, and window.constellation exposes only invoke",
    JSON.stringify(globals),
  );
  // A well-formed report reaches main's handler, so the malformed one is refused by main's parse, not by a missing handler.
  const report = (input) =>
    t.eval(
      `window.constellation.invoke("error.report", ${JSON.stringify(input)}).then(() => "resolved", (error) => error.message)`,
    );
  const good = await report({ type: "TypeError", stack: "at render (app.tsx:12:3)" });
  const bad = await report({ type: "TypeError" });
  t.assert(
    good === "resolved" && bad !== "resolved",
    "invoking error.report resolves a well-formed report and rejects one without a stack",
    JSON.stringify({ good, bad }),
  );
  t.assert(await t.eval(`window.open(location.href) === null`), "window.open opens nothing");

  // A refused navigation stops loading without ever committing a new page.
  const away = new URL("/welcome", t.origin).href;
  const offs = [];
  const outcome = new Promise((resolve) => {
    offs.push(t.on("Page.frameNavigated", () => resolve("navigated")));
    offs.push(t.on("Page.frameStoppedLoading", () => resolve("stopped")));
  });
  await t.eval(`void (location.href = ${JSON.stringify(away)})`);
  const ended = await outcome;
  for (const off of offs) off();
  t.assert(
    ended === "stopped" && (await t.eval("location.href")).startsWith(APP_URL),
    "a page can't navigate the window away from the app",
    `${ended} at ${await t.eval("location.href")}`,
  );
};
