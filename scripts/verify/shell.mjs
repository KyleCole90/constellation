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
    `({ process: typeof process, require: typeof require, bridge: Object.keys(window.constellation ?? {}).sort(), fakes: window.constellation?.fakes })`,
  );
  t.assert(
    globals.process === "undefined" &&
      globals.require === "undefined" &&
      JSON.stringify(globals.bridge) === '["fakes","invoke"]' &&
      globals.fakes === true,
    "the page has no process or require, and window.constellation exposes only invoke and whether it runs on fakes (it does, under verify)",
    JSON.stringify(globals),
  );
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
  const permissions = await t.eval(
    `Promise.all([Notification.requestPermission(), navigator.permissions.query({ name: "notifications" }).then((status) => status.state)])`,
  );
  t.assert(
    JSON.stringify(permissions) === '["denied","denied"]',
    "the page is refused a permission it asks for, and a check reports it as not held",
    JSON.stringify(permissions),
  );

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
