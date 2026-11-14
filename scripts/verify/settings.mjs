import { addAiKey } from "./ai-key.mjs";
import { onboard } from "./onboard.mjs";

const SIDEBAR = '[data-testid="sidebar"]';
const NAV = '[data-testid="settings-nav"]';
const BODY = '[data-testid="settings-body"]';
const DIALOG = '[role="dialog"]';
const DIALOG_FIELD = `${DIALOG} input[type="password"]`;
const PANEL = '[data-testid="thread-panel"]';
const LIST = '[data-testid="queue-list"]';
const LOG = '[data-testid="writes-log"]';
const CARD = (school) => `[data-school="${school}"]`;
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [120, 240] });

const SECRETS = {
  short: "SNTL-short",
  lcc: "SENTINEL-token-lakeshore-7f3a9c2e41",
  rsu: "SENTINEL-token-riverbend-b81d06fa37",
  ai: "SENTINEL-aikey-first-52c7e09d1b",
  reconnect: "SENTINEL-token-reconnect-c94e17ab02",
  unreachable: "SENTINEL-token-unreachable-0de8a6b3",
  replaced: "SENTINEL-token-replaced-3ab7f2c915",
  afterDisconnect: "SENTINEL-token-afterdisco-e260d4c7",
  aiReplaced: "SENTINEL-aikey-replaced-96f1b3e2a8",
  aiAgain: "SENTINEL-aikey-again-17c4d0e9fb",
  fromSidebar: "SENTINEL-token-fromsidebar-a3d95e7c",
  fromDue: "SENTINEL-token-fromdue-5d02b8e17f",
};

const READ_SURFACES = `async () => {
  const decode = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
    if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value.buffer);
    if (value instanceof CryptoKey) return "[key extractable=" + value.extractable + "]";
    if (typeof value === "object") return Object.entries(value).map(([key, inner]) => key + "=" + decode(inner)).join("\\n");
    return String(value);
  };
  const indexedValues = [];
  for (const { name } of await indexedDB.databases()) {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open(name); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    for (const store of db.objectStoreNames) {
      const read = db.transaction(store).objectStore(store);
      const [keys, values] = await Promise.all([read.getAllKeys(), read.getAll()].map((request) => new Promise((resolve) => { request.onsuccess = () => resolve(request.result); })));
      keys.forEach((key, i) => indexedValues.push({ store, text: decode(key) + "\\n" + decode(values[i]) }));
    }
    db.close();
  }
  return {
    dom: document.documentElement.outerHTML,
    inputs: [...document.querySelectorAll("input, textarea")].map((field) => field.value).join("\\n"),
    localStorage: JSON.stringify({ ...localStorage }),
    sessionStorage: JSON.stringify({ ...sessionStorage }),
    url: location.href + "\\n" + JSON.stringify(history.state),
    indexedDB: indexedValues.map((entry) => entry.text).join("\\n"),
    indexedStores: indexedValues.map((entry) => entry.store),
    window: Object.getOwnPropertyNames(window).map((name) => { try { const value = window[name]; return typeof value === "string" ? value : ""; } catch { return ""; } }).join("\\n"),
    // What DevTools can ask main for: every key, and each one's stand-in.
    bridge: window.constellation ? JSON.stringify(await Promise.all((await window.constellation.invoke("vault.keys")).map(async (key) => [key, await window.constellation.invoke("vault.standIn", { key })]))) : "",
  };
}`;

const surfaces = async (t) => {
  const page = await t.eval(`(${READ_SURFACES})()`);
  const { entries } = await t.cdp("Page.getNavigationHistory");
  return {
    ...page,
    history: entries.map((entry) => `${entry.url}\n${entry.title}`).join("\n"),
    console: t.consoleEntries.join("\n"),
    mainVault: await t.vaultFile(),
  };
};

const whereFound = (read, needle) =>
  [
    "dom",
    "inputs",
    "localStorage",
    "sessionStorage",
    "url",
    "indexedDB",
    "history",
    "console",
    "window",
    "bridge",
    "mainVault",
  ].filter((surface) => read[surface].includes(needle));

const vaultKeys = (text) => Object.keys(JSON.parse(text)).sort().join();

const assertNoLeak = async (t, tag) => {
  const read = await surfaces(t);
  const leaks = Object.entries(SECRETS).flatMap(([name, secret]) =>
    whereFound(read, secret).map((surface) => `${name} in ${surface}`),
  );
  t.assert(leaks.length === 0, `${tag}: no sentinel on any surface`, leaks.join(", "));
};

const assertScanWorks = async (t) => {
  const canary = "CANARY-proves-the-scan-looks-4e1f";
  await t.eval(`(async () => {
    document.body.dataset.canary = ${JSON.stringify(canary)};
    window.verifyCanary = ${JSON.stringify(canary)};
    localStorage.setItem("verify.canary", ${JSON.stringify(canary)});
    sessionStorage.setItem("verify.canary", ${JSON.stringify(canary)});
    console.log(${JSON.stringify(canary)});
    const db = await new Promise((resolve) => { const open = indexedDB.open("verify-canary"); open.onupgradeneeded = () => open.result.createObjectStore("s"); open.onsuccess = () => resolve(open.result); });
    await new Promise((resolve) => { const tx = db.transaction("s", "readwrite"); tx.objectStore("s").put({ raw: new TextEncoder().encode(${JSON.stringify(canary)}) }, "k"); tx.oncomplete = resolve; });
    db.close();
    history.replaceState(history.state, "", location.pathname + "?canary=" + ${JSON.stringify(canary)});
  })()`);
  await t.sleep(100);
  const found = whereFound(await surfaces(t), canary);
  const expected = [
    "dom",
    "localStorage",
    "sessionStorage",
    "url",
    "indexedDB",
    "history",
    "console",
    "window",
  ];
  t.assert(
    expected.every((surface) => found.includes(surface)),
    "the leak scan finds a canary on each surface",
    found.join(", "),
  );
  await t.eval(`(async () => {
    delete document.body.dataset.canary;
    delete window.verifyCanary;
    localStorage.removeItem("verify.canary");
    sessionStorage.removeItem("verify.canary");
    await new Promise((resolve) => { const del = indexedDB.deleteDatabase("verify-canary"); del.onsuccess = resolve; del.onerror = resolve; });
    history.replaceState(history.state, "", location.pathname);
  })()`);
  const entriesWithCanary = t.consoleEntries.filter((entry) => entry.includes(canary));
  for (const entry of entriesWithCanary)
    t.consoleEntries.splice(t.consoleEntries.indexOf(entry), 1);
};

const fieldState = (t, selector) =>
  t.eval(
    `(() => { const field = document.querySelector(${JSON.stringify(selector)}); return field && { value: field.value, focused: document.activeElement === field, type: field.type, autocomplete: field.autocomplete, spellcheck: field.spellcheck, html: field.getAttribute("spellcheck") }; })()`,
  );

const assertSafeField = async (t, selector, tag) => {
  const field = await fieldState(t, selector);
  t.assert(
    field?.type === "password" && field.autocomplete === "off" && field.html === "false",
    `${tag}: the field is a password field with autocomplete and spellcheck off`,
    JSON.stringify(field),
  );
  const toggles = await t.eval(
    `[...document.querySelector(${JSON.stringify(selector)}).closest("form").querySelectorAll("button")].filter((b) => /show|reveal|hide/i.test(b.innerText + (b.getAttribute("aria-label") ?? ""))).length`,
  );
  t.assert(toggles === 0, `${tag}: no reveal toggle`, String(toggles));
};

const assertRejected = async (t, selector, scope, reason, typed, tag, timeout) => {
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${scope} [role="alert"]`)})?.innerText.includes(${JSON.stringify(reason)})`,
    `${tag}: says "${reason}"`,
    timeout,
  );
  const words = await t.text(`${scope} [role="alert"]`);
  t.assert(!words.includes(typed), `${tag}: the message does not echo the input`, words);
  const field = await fieldState(t, selector);
  t.assert(field?.value === "", `${tag}: the field is empty`);
  t.assert(field?.focused === true, `${tag}: the field has focus`);
};

const enter = async (t, selector, secret) => {
  await t.click(selector);
  await t.type(secret);
};

const shooter = (t) => {
  let number = 70;
  return (name) => t.shot(name, number++);
};

const cardStatus = (school) => `document.querySelector('${CARD(school)}')?.dataset.connection`;
const attentionDot = `Boolean(document.querySelector('[data-testid="sidebar"] [data-attention="true"]'))`;
const writes = (t) => t.eval(`window.__faultLab.writes().length`);
const lms = (t, expression) =>
  t.eval(
    `(async () => { const lms = JSON.parse(await window.__faultLab.stored()); return ${expression}; })()`,
  );

const openSection = async (t, label) => {
  if ((await t.eval(`location.pathname`)) !== "/settings")
    await t.click("Settings", { within: SIDEBAR });
  await t.waitFor(`document.querySelector(${JSON.stringify(NAV)})`, `Settings opens for ${label}`);
  await t.click(label, { within: NAV });
  await t.waitFor(
    `document.querySelector('${NAV} [aria-current="page"]')?.innerText === ${JSON.stringify(label)}`,
    `the ${label} section is showing`,
  );
};

const assertLayout = async (t, width, height, tag) => {
  await t.viewport(width, height);
  await t.sleep(150);
  for (const section of ["Connections", "AI", "Demo"]) {
    await t.click(section, { within: NAV });
    await t.sleep(80);
    const result = await t.eval(`(() => {
      const box = (el) => el.getBoundingClientRect();
      const nav = box(document.querySelector(${JSON.stringify(NAV)}));
      const body = document.querySelector(${JSON.stringify(BODY)});
      const sidebar = box(document.querySelector(${JSON.stringify(SIDEBAR)}));
      const bodyBox = box(body);
      const clipped = [...body.querySelectorAll("button, input:not([aria-hidden=true]), h2, h3, table, select, [role=switch], [role=combobox]")].filter((el) => { const r = box(el); return r.width > 0 && (r.right > bodyBox.right + 0.5 || r.left < bodyBox.left - 0.5); }).map((el) => el.innerText || el.tagName);
      return { sidebar: sidebar.width, navLeft: nav.left, navRight: nav.right, sidebarRight: sidebar.right, bodyLeft: bodyBox.left, bodyRight: bodyBox.right, bodyBottom: bodyBox.bottom, overflowX: body.scrollWidth - body.clientWidth, clipped };
    })()`);
    const sidebarWidth = width < 1280 ? 48 : 288;
    t.assert(
      result.sidebar === sidebarWidth,
      `${tag} ${section}: sidebar is ${sidebarWidth}px`,
      JSON.stringify(result),
    );
    t.assert(
      result.navLeft === result.sidebarRight && result.bodyLeft === result.navRight,
      `${tag} ${section}: nav sits between the sidebar and the content`,
      JSON.stringify(result),
    );
    t.assert(
      result.bodyRight === width && result.bodyBottom === height,
      `${tag} ${section}: content fills to the window's edge`,
      JSON.stringify(result),
    );
    t.assert(
      result.overflowX <= 0,
      `${tag} ${section}: no sideways scroll`,
      String(result.overflowX),
    );
    t.assert(
      result.clipped.length === 0,
      `${tag} ${section}: no control is clipped`,
      result.clipped.join(", "),
    );
    const squeezed = await t.eval(
      `[...document.querySelectorAll("[data-fault] h3")].filter((title) => title.getBoundingClientRect().width < 160).length`,
    );
    t.assert(
      squeezed === 0,
      `${tag} ${section}: one-shot titles keep their width`,
      String(squeezed),
    );
  }
};

const RAIL_LINKS = [
  `button[title^="Search"]`,
  `a[title="What's due"]`,
  `a[title^="Messages"]`,
  `a[title="Calendar"]`,
  `button[title="Courses"]`,
  `a[title^="Settings"]`,
];

const sidebarRail = async (t) => {
  const visible = (selector) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => el.getClientRects().length > 0)`;
  const pageBoxes = () =>
    t.eval(
      `JSON.stringify(['[data-testid="screen-header"]', ${JSON.stringify(BODY)}].map((selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }))`,
    );
  const sidebarWidth = () =>
    t.eval(`document.querySelector(${JSON.stringify(SIDEBAR)}).getBoundingClientRect().width`);
  const railLinks = await t.eval(
    `${JSON.stringify(RAIL_LINKS)}.map((selector) => { const el = document.querySelector(${JSON.stringify(SIDEBAR)} + " " + selector); const r = el?.getBoundingClientRect(); return { selector, shown: Boolean(r && r.width > 0 && r.right <= 48) }; })`,
  );
  t.assert(
    railLinks.every((link) => link.shown),
    "1180: the rail shows search, What's due, Messages, Calendar, Courses and Settings as icons",
    JSON.stringify(railLinks),
  );
  t.assert(
    (await t.eval(
      `${visible(`${SIDEBAR} [data-testid="school-row"], [data-testid="sidebar-chats"], [data-testid="settled-area"]`)}.length`,
    )) === 0,
    "1180: the rail leaves out schools, chats and Settled",
  );
  t.assert(
    (await t.has('a[href="/settings"] [data-testid="sidebar-warning-dot"]')) ===
      (await t.eval(
        `[...document.querySelectorAll('[data-testid="school-row"]')].some((row) => ["expired", "disconnected"].includes(row.dataset.connection))`,
      )),
    "1180: the Settings gear carries a warning dot exactly when a school is not connected",
  );
  const steps = await t.eval(
    `[...document.querySelectorAll(${JSON.stringify(`${SIDEBAR} a[title="What's due"], ${SIDEBAR} a[title^="Messages"], ${SIDEBAR} a[title="Calendar"], ${SIDEBAR} button[title="Courses"]`)})].map((el) => Math.round(el.getBoundingClientRect().top))`,
  );
  t.assert(
    steps.length === 4 && steps.every((top, i) => i === 0 || top - steps[i - 1] === 36),
    "1180: Courses follows Calendar on the rail's 36px step",
    JSON.stringify(steps),
  );
  t.assert(
    !(await t.has(`${SIDEBAR} [aria-label$="sidebar"]`)),
    "1180: the rail has no separate expand toggle",
  );
  t.assert(
    (await t.has('[data-testid="rail-courses-dot"]')) ===
      (await t.eval(
        `[...document.querySelectorAll('[data-testid="school-row"]')].some((row) => /\\bneeds? approval\\b/.test(row.title))`,
      )),
    "1180: the Courses item carries an amber dot exactly when a course has work waiting on your approval",
  );
  const before = await pageBoxes();
  const expand = 'button[title="Courses"]';

  await t.click(expand, { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(SIDEBAR)}).getBoundingClientRect().width === 256 && ${visible('[data-testid="school-row"]')}.length > 0`,
    "1180: Courses lays the full sidebar over the page",
  );
  t.assert(
    (await pageBoxes()) === before,
    "1180: the page behind the expanded sidebar holds still",
    `${before} vs ${await pageBoxes()}`,
  );
  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector('[data-testid="sidebar-scrim"]')`,
    "1180: Escape closes the expanded sidebar",
  );
  t.assert(
    await t.eval(`document.activeElement?.matches('button[title="Courses"]')`),
    "1180: Escape hands focus back to the Courses item",
  );
  t.assert(
    (await sidebarWidth()) === 48,
    "1180: and the rail is back",
    String(await sidebarWidth()),
  );

  await t.click(expand, { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector('[data-testid="sidebar-scrim"]')`,
    "1180: Courses opens it again",
  );
  await t.click('[data-testid="sidebar-scrim"]');
  await t.waitFor(
    `!document.querySelector('[data-testid="sidebar-scrim"]')`,
    "1180: a click beside it closes it",
  );

  await t.click(expand, { within: SIDEBAR });
  await t.waitFor(
    `${visible(`${SIDEBAR} a[href^="/courses/"]`)}.length > 0`,
    "1180: the expanded sidebar lists courses",
  );
  await t.click(`${SIDEBAR} a[href^="/courses/"]`);
  await t.waitFor(
    `location.pathname.startsWith("/courses/") && !document.querySelector('[data-testid="sidebar-scrim"]') && document.querySelector(${JSON.stringify(SIDEBAR)}).getBoundingClientRect().width === 48`,
    "1180: opening a course from the expanded sidebar goes there and folds it back to the rail",
  );
  await t.click('a[title^="Settings"]', { within: SIDEBAR });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(NAV)})`,
    "1180: Settings opens from the rail",
  );
};

const assertWelcomeLayout = async (t, width, height, tag) => {
  await t.viewport(width, height);
  const result = await t.steady(`(() => {
    const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const heading = box("main h1"), mark = box("main img"), button = [...document.querySelectorAll("main button")].find((el) => el.innerText === "Set up")?.getBoundingClientRect();
    const center = (r) => r && (r.left + r.right) / 2;
    return { heading: center(heading), mark: center(mark), button: center(button), middle: innerWidth / 2, sideways: document.documentElement.scrollWidth - innerWidth, vertical: document.documentElement.scrollHeight - innerHeight };
  })()`);
  t.assert(
    ["heading", "mark", "button"].every((key) => Math.abs(result[key] - result.middle) <= 1),
    `${tag}: the mark, the title, and Set up are centered`,
    JSON.stringify(result),
  );
  t.assert(
    result.sideways <= 0 && result.vertical <= 0,
    `${tag}: the welcome screen fits without scrolling`,
    JSON.stringify(result),
  );
};

const assertSetupLayout = async (t, width, height, tag) => {
  await t.viewport(width, height);
  const result = await t.steady(`(() => {
    const column = document.querySelector('[data-testid="where-you-teach"]').getBoundingClientRect();
    const clipped = [...document.querySelectorAll("main button, main input, main a, main h2")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 0.5 || r.left < -0.5); }).map((el) => el.innerText || el.getAttribute("aria-label") || el.tagName);
    return { width: column.width, sideways: document.documentElement.scrollWidth - innerWidth, clipped };
  })()`);
  t.assert(result.width <= 640, `${tag}: the setup column keeps its width`, JSON.stringify(result));
  t.assert(result.sideways <= 0, `${tag}: no sideways scroll`, JSON.stringify(result));
  t.assert(result.clipped.length === 0, `${tag}: no control is clipped`, result.clipped.join(", "));
};

const assertFinishInView = async (t, width, height, tag) => {
  await t.viewport(width, height);
  const seen = await t.steady(`(() => {
    const button = [...document.querySelectorAll("main button")].find((b) => b.innerText === "Finish setup");
    const reason = document.getElementById(button.getAttribute("aria-describedby"));
    return [button, reason].map((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  })()`);
  t.assert(
    seen.every(Boolean),
    `${tag}: Finish setup and why it waits are on screen`,
    JSON.stringify(seen),
  );
};

const LCC = "lakeshore.instructure.com";
const RSU = "riverbend.instructure.com";
const NOWHERE = "nowhere.example.edu";
const RSU_TYPO = "riverbend.instructre.com";
const ROW = (host) => `[data-host="${host}"]`;
const ROW_FIELD = (host) => `${ROW(host)} input[type="password"]`;
const ADDRESS = '[data-testid="address-field"]';
const rowStatus = (host) =>
  `document.querySelector(${JSON.stringify(ROW(host))})?.dataset.connection`;
const storedHosts = `(JSON.parse(localStorage.getItem("lms-app.v1") ?? "{}").state?.schools ?? []).map((school) => school.host)`;

const addAddress = async (t, host, { scope, typed = host } = {}) => {
  await t.click(ADDRESS, { within: scope });
  await t.type(typed);
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ROW(host))})`,
    `typing ${host} adds a row`,
  );
};

const ROW_ADDRESS = (host) => `${ROW(host)} [data-testid="row-address"]`;
const ELSEWHERE = "elsewhere.example.edu";
const rowAlerts = (row) =>
  `[...document.querySelectorAll(${JSON.stringify(`${row} [role="alert"]`)})].map((alert) => alert.innerText)`;
const tokenLength = (t, selector) =>
  t.eval(`document.querySelector(${JSON.stringify(selector)})?.value.length ?? -1`);

const retype = async (t, selector, text) => {
  await t.click(selector);
  await t.eval(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await t.type(text);
  await t.key("Enter");
};

const fixesTypo = async (t, shot, { scope, secret, tag }) => {
  await addAddress(t, RSU_TYPO, { scope });
  const at = (selector) => (scope ? `${scope} ${selector}` : selector);
  await enter(t, at(ROW_FIELD(RSU_TYPO)), secret);
  await shot(`${tag}-typo-row`);
  await retype(t, at(ROW_ADDRESS(RSU_TYPO)), `https://${RSU}/login`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(at(ROW(RSU)))})`,
    `${tag}: editing a typed row's address moves the row there`,
  );
  t.assert(!(await t.has(at(ROW(RSU_TYPO)))), `${tag}: no row is left at the typo`);
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(at(ROW_ADDRESS(RSU)))}).value`)) === RSU,
    `${tag}: the edited address reads as its host`,
  );
  t.assert(
    (await tokenLength(t, at(ROW_FIELD(RSU)))) === secret.length,
    `${tag}: the pasted token stays in the row`,
  );
  await shot(`${tag}-typo-fixed`);
};

const addressAlert = (scope = "body") =>
  `(document.querySelector(${JSON.stringify(`${scope} ${ADDRESS}`)})?.closest(".flex-col")?.querySelector('[role="alert"]')?.innerText ?? "")`;
const clearAddress = (t, scope = "body") =>
  t.eval(
    `(() => { const field = document.querySelector(${JSON.stringify(`${scope} ${ADDRESS}`)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ""); field.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
const focusedRow = `document.activeElement?.closest("[data-host]")?.dataset.host ?? ""`;

const refusesDuplicate = async (
  t,
  typed,
  { scope = "body", rows, focusHost, tag, words = "already added" },
) => {
  await t.click(ADDRESS, { within: scope });
  await t.type(typed);
  await t.key("Enter");
  await t.waitFor(
    `${addressAlert(scope)}.includes(${JSON.stringify(words)})`,
    `${tag}: adding a school again says ${words}`,
  );
  t.assert(
    !(await t.eval(addressAlert(scope))).includes(typed.toLowerCase()),
    `${tag}: the message does not echo the address`,
  );
  t.assert(
    (await t.eval(
      `document.querySelectorAll(${JSON.stringify(`${scope} [data-host]`)}).length`,
    )) === rows,
    `${tag}: no second row appears`,
  );
  t.assert(
    (await t.eval(focusedRow)) === focusHost,
    `${tag}: focus lands on the school's row`,
    await t.eval(focusedRow),
  );
};

// Pretends to be another platform for every page load until the returned function undoes it.
const pretendPlatform = async (t, platform, brand) => {
  const { identifier } = await t.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(Navigator.prototype, "platform", { get: () => ${JSON.stringify(platform)} }); Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => ({ platform: ${JSON.stringify(brand)} }) });`,
  });
  await t.reload();
  return async () => {
    await t.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await t.reload();
  };
};

const onDeviceRadio = `document.querySelector('input[name="ai-source"][value="on-device"]')`;

const finishReason = (t) =>
  t.eval(`(() => {
    const button = [...document.querySelectorAll("main button")].find((b) => b.innerText === "Finish setup");
    const reason = document.getElementById(button?.getAttribute("aria-describedby") ?? "");
    return reason && reason.getBoundingClientRect().width > 0 ? reason.innerText : "";
  })()`);

const atWelcome = `location.pathname === "/welcome" && [...document.querySelectorAll("main button")].some((b) => b.innerText === "Set up")`;
const atSetup = `location.pathname === "/setup" && Boolean(document.querySelector(${JSON.stringify(ADDRESS)}))`;

const backAndForthFromSetup = async (t, tag) => {
  const entries = await t.eval("history.length");
  await t.eval("history.back()");
  await t.waitFor(atWelcome, `${tag}: Back from setup returns to the welcome screen`);
  await t.eval("history.forward()");
  await t.waitFor(atSetup, `${tag}: Forward from welcome returns to setup`);
  t.assert(
    (await t.eval("history.length")) === entries,
    `${tag}: Back and Forward add no entries`,
    `${entries} entries before, ${await t.eval("history.length")} after`,
  );
};

const onboarding = async (t, shot) => {
  await t.viewport(1440, 900);
  await t.goto("/");
  await t.waitFor(`location.pathname === "/welcome"`, "a first run lands on /welcome");
  for (const path of ["/due", "/settings", "/threads/t-north-star"]) {
    await t.goto(path);
    await t.waitFor(
      `location.pathname === "/welcome"`,
      `a first run opening ${path} lands on /welcome`,
    );
  }
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await t.reload();
  seededComments = await lms(
    t,
    `lms.submissions.flatMap((s) => s.comments ?? []).filter((c) => c.mine).length`,
  );
  await assertScanWorks(t);
  await t.waitText(
    "Nothing reaches your LMS until you approve it.",
    "the welcome screen makes the promise",
  );
  t.assert(
    (await t.eval("document.title")) === "Constellation",
    "the page title names the product",
  );
  t.assert(
    (await t.text("main")).includes("Each school is a star in your academic journey."),
    "the welcome screen carries the tagline",
  );
  t.assert(
    (await t.eval(`document.querySelector('link[rel="icon"]').href`)).includes("mark.svg"),
    "the favicon is the mark",
  );
  t.assert(!(await t.has("main input")), "the welcome screen asks for nothing");
  await shot("welcome");
  await assertWelcomeLayout(t, 1180, 800, "welcome 1180x800");
  await t.viewport(1440, 900);

  const welcomeEntry = await t.eval("history.state.__TSR_index");
  const beforeSetUp = await t.eval("history.length");
  await t.click("Set up");
  await t.waitFor(atSetup, "Set up opens the one setup page at /setup");
  t.assert(
    (await t.eval("history.length")) === beforeSetUp + 1,
    "Set up adds one history entry, so Back has a welcome screen to return to",
    `${beforeSetUp} entries before, ${await t.eval("history.length")} after`,
  );
  await backAndForthFromSetup(t, "setup");
  t.assert(
    !/demo/i.test(await t.text('[data-testid="where-you-teach"]')),
    "setup: the real school form offers no demo schools beside it",
    await t.text('[data-testid="where-you-teach"]'),
  );
  t.assert(
    (await t.text('[data-testid="demo-offer"]')).includes("Just looking?"),
    "setup: demo schools are offered below the form, for a look around",
  );
  const privacyWords = await t.eval(
    `document.querySelector('[data-testid="setup-privacy"]').textContent`,
  );
  t.assert(
    !/whatever you choose|CONSTELLATION_|JavaScript|web demo/.test(privacyWords),
    "setup: Privacy has no checkbox that does nothing and no developer words",
    privacyWords,
  );
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('input[name="ai-source"]')].every((radio) => radio.closest("fieldset").disabled)`,
    )) === true,
    "the AI choice waits for a connected school",
  );
  t.assert(
    !(await t.eval(
      `[...document.querySelectorAll("main button")].find((b) => b.innerText === "Finish setup")?.disabled === false`,
    )),
    "Finish waits for a connected school",
  );
  await t.reload();
  await t.waitFor(atSetup, "a reload stays on the setup page");
  await backAndForthFromSetup(t, "setup after a reload");
  await assertSetupLayout(t, 1180, 800, "setup 1180x800");
  t.assert(
    (await finishReason(t)).includes("Connect a school"),
    "setup 1180x800: a disabled Finish says why",
    await finishReason(t),
  );
  await shot("finish-reason-narrow");
  await t.viewport(1440, 900);

  await t.click(ADDRESS);
  await t.type("not an address");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector('[data-testid="where-you-teach"] [role="alert"]')?.innerText.includes("isn't a web address")`,
    "a malformed address is refused in words",
  );
  t.assert(
    !(await t.text('[data-testid="where-you-teach"] [role="alert"]')).includes("not an address"),
    "the address error does not echo the input",
  );
  t.assert(!(await t.has("[data-host]")), "a malformed address adds no row");
  await t.eval(
    `(() => { const field = document.querySelector(${JSON.stringify(ADDRESS)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, ""); field.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );

  await addAddress(t, LCC, { typed: `https://${LCC}/login` });
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(ROW(LCC))}) !== null`)) === true,
    "a pasted URL becomes its host",
  );
  t.assert(
    (await t.eval(`document.querySelector('${ROW(LCC)} a')?.href`)) ===
      `https://${LCC}/profile/settings`,
    "the row links to that school's token page",
  );
  t.assert(
    (await t.eval(`document.querySelectorAll('${ROW(LCC)} ol li').length`)) >= 3 &&
      (await t.text(`${ROW(LCC)} ol`)).includes("New Access Token"),
    "the row lists the same token steps as the Reconnect dialog",
    await t.text(ROW(LCC)),
  );
  await assertSafeField(t, ROW_FIELD(LCC), "connect row");

  await enter(t, ROW_FIELD(LCC), SECRETS.short);
  const typed = whereFound(await surfaces(t), SECRETS.short);
  t.assert(
    typed.includes("inputs"),
    "the scan sees a value still in the field, so it can see one left behind",
    typed.join(", "),
  );
  await t.key("Enter");
  await assertRejected(t, ROW_FIELD(LCC), ROW(LCC), "at least", SECRETS.short, "a too-short token");
  t.assert(
    (await t.eval(rowStatus(LCC))) === "new" && (await t.eval(storedHosts)).length === 0,
    "a too-short token leaves no school behind",
  );
  await shot("too-short-rejected");
  await assertNoLeak(t, "after the too-short token");

  await addAddress(t, NOWHERE);
  await enter(t, ROW_FIELD(NOWHERE), SECRETS.unreachable);
  await t.key("Enter");
  await assertRejected(
    t,
    ROW_FIELD(NOWHERE),
    ROW(NOWHERE),
    "Couldn't find a school",
    SECRETS.unreachable,
    "an unknown address",
    20_000,
  );
  t.assert(
    (await t.eval(rowStatus(NOWHERE))) !== "connected" &&
      !(await t.has('[data-host][data-connection="connected"]')),
    "an unknown address leaves no row connected",
  );
  t.assert(!(await t.eval(storedHosts)).includes(NOWHERE), "an unknown address is not saved");
  t.assert(
    (await t.text(`${ROW(NOWHERE)} [role="alert"]`)).includes("help desk"),
    "an unknown address says what to do next",
    await t.text(`${ROW(NOWHERE)} [role="alert"]`),
  );
  await shot("unknown-address-rejected");
  t.assert(
    !(await t.has('[data-testid="demo-offer"]')),
    "setup: once a real school is typed, the demo offer goes",
  );
  await retype(t, ROW_ADDRESS(NOWHERE), "harvard");
  await t.waitFor(
    `${rowAlerts(ROW(NOWHERE))}.join().includes("isn't a web address")`,
    "setup: a bad edit says why",
  );
  t.assert(
    (await t.eval(rowAlerts(ROW(NOWHERE)))).length === 1,
    "setup: a bad edit replaces the token error, not stacks on it",
    JSON.stringify(await t.eval(rowAlerts(ROW(NOWHERE)))),
  );
  await t.key("Escape");
  await retype(t, ROW_ADDRESS(NOWHERE), ELSEWHERE);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ROW(ELSEWHERE))})`,
    "setup: the row moves to the edited address",
  );
  t.assert(
    (await t.eval(rowAlerts(ROW(ELSEWHERE)))).length === 0,
    "setup: a new address retires the error about the old one",
    JSON.stringify(await t.eval(rowAlerts(ROW(ELSEWHERE)))),
  );
  await shot("setup-edited-address");
  await t.click(`[aria-label="Remove ${ELSEWHERE}"]`);
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(ROW(ELSEWHERE))})`,
    "Remove drops the typed row",
  );

  await t.eval(`(() => {
    window.__stages = [];
    window.__courseReads = [];
    new MutationObserver(() => {
      const words = document.querySelector('[data-testid="connect-stage"]')?.innerText;
      if (words && window.__stages.at(-1) !== words) window.__stages.push(words);
      const rows = [...document.querySelectorAll('[data-testid="course-reads"] li')];
      const read = \`\${rows.filter((row) => row.dataset.read === "true").length}/\${rows.length}\`;
      if (rows.length > 0 && window.__courseReads.at(-1) !== read) window.__courseReads.push(read);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  })()`);
  await t.eval(`window.__faultLab.setNoise({ latencyMs: [900, 900] })`);
  await enter(t, ROW_FIELD(LCC), SECRETS.lcc);
  await t.click(`${ROW(LCC)} button[type="submit"]`);
  const fieldAfter = await fieldState(t, ROW_FIELD(LCC));
  t.assert(
    !fieldAfter || fieldAfter.value === "",
    "the field is empty straight after submit",
    JSON.stringify(fieldAfter?.value?.length),
  );
  await t.waitFor(
    `document.querySelector('[data-testid="connect-stage"]')?.innerText === "Checking your token"`,
    "Lakeshore shows Checking your token while it waits",
  );
  await shot("connecting-stage");
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(ROW_ADDRESS(LCC))}).readOnly`)) === true,
    "setup: the address is locked while it connects",
  );
  await t.waitFor(`${rowStatus(LCC)} === "connected"`, "Lakeshore connects", 20_000);
  await t.eval(`window.__faultLab.setNoise({ latencyMs: [120, 240] })`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ROW(LCC))}).innerText.includes("Connected as")`,
    "Lakeshore says Connected as a name",
  );
  t.assert(
    /\d+ courses?/.test(await t.text(ROW(LCC))),
    "Lakeshore says how many courses it found",
    await t.text(ROW(LCC)),
  );
  const stages = await t.eval(`window.__stages`);
  t.assert(
    stages.includes("Checking your token") && stages.includes("Reading your courses"),
    "connecting showed real stages in order",
    stages.join(" > "),
  );
  t.assert(
    stages.indexOf("Checking your token") < stages.indexOf("Reading your courses"),
    "checking comes before reading",
    stages.join(" > "),
  );
  const found = Number(/(\d+) courses?/.exec(await t.text(ROW(LCC)))?.[1]);
  const reads = await t.eval(`window.__courseReads`);
  t.assert(
    reads[0] === `0/${found}` && stages.includes(`Reading your ${found} courses`),
    "connecting names each course while its first read runs",
    `${stages.join(" > ")} | ${reads.join(" > ")}`,
  );
  t.assert(
    (await t.text(ROW(LCC))).split(LCC).length === 2,
    "a connected school shows its address once",
    await t.text(ROW(LCC)),
  );
  t.assert(
    !(await t.eval(
      `document.querySelector('input[name="ai-source"]').closest("fieldset").disabled`,
    )),
    "a connected school opens the AI choice",
  );
  await shot("connected-row");
  await assertNoLeak(t, "after connecting Lakeshore");

  await t.click(`[aria-label="Remove ${LCC}"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG)})?.innerText.includes(${JSON.stringify(LCC)})`,
    "the X on a connected school asks first and names it",
  );
  await shot("remove-connected-confirm");
  await t.click("Cancel", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DIALOG)})`,
    "Cancel closes the remove confirm",
  );
  t.assert(
    (await t.eval(rowStatus(LCC))) === "connected" && (await t.eval(storedHosts)).includes(LCC),
    "Cancel keeps the connected school",
  );

  await addAddress(t, RSU);
  await enter(t, ROW_FIELD(RSU), SECRETS.rsu);
  await backAndForthFromSetup(t, "setup with a typed row");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ROW(RSU))})`,
    "Back and Forward keep a typed address that never connected",
  );
  t.assert(
    (await tokenLength(t, ROW_FIELD(RSU))) === 0,
    "Back and Forward drop a pasted token rather than keep it",
  );
  await assertNoLeak(t, "after Back and Forward with a pasted token");
  await shot("typed-row-after-back-forward");
  await enter(t, ROW_FIELD(RSU), SECRETS.rsu);
  await t.reload();
  await t.waitFor(
    `${rowStatus(LCC)} === "connected"`,
    "a reload mid-setup keeps the connected school",
  );
  t.assert(!(await t.has(ROW_FIELD(LCC))), "a reload never asks again for a saved token");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(ROW(RSU))})`,
    "a reload keeps a typed address that never connected",
  );
  t.assert(
    (await tokenLength(t, ROW_FIELD(RSU))) === 0,
    "a reload drops a pasted token rather than keep it",
  );
  t.assert(await t.has(ADDRESS), "a reload mid-setup stays on the setup page");
  await assertNoLeak(t, "after a reload with a pasted token");
  await shot("typed-row-after-reload");
  await t.click(`[aria-label="Remove ${RSU}"]`);
  await t.waitFor(`!document.querySelector(${JSON.stringify(ROW(RSU))})`, "Remove drops the row");
  await t.reload();
  await t.waitFor(`${rowStatus(LCC)} === "connected"`, "setup is back after the reload");
  t.assert(!(await t.has(ROW(RSU))), "a removed typed row stays gone after a reload");

  await fixesTypo(t, shot, { secret: SECRETS.rsu, tag: "setup" });
  await retype(t, ROW_ADDRESS(RSU), LCC);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${ROW(RSU)} [role="alert"]`)})?.innerText.includes("already added")`,
    "setup: editing an address to an added school says it's already added",
  );
  await t.key("Escape");
  t.assert(
    (await t.eval(`document.querySelector(${JSON.stringify(ROW_ADDRESS(RSU))}).value`)) === RSU &&
      !(await t.has(`${ROW(RSU)} [role="alert"]`)),
    "setup: Escape puts the address back and clears the message",
  );
  t.assert(
    (await tokenLength(t, ROW_FIELD(RSU))) === SECRETS.rsu.length,
    "setup: a refused edit keeps the token",
  );
  await t.click(ROW_FIELD(RSU));
  await t.key("Enter");
  await t.waitFor(`${rowStatus(RSU)} === "connected"`, "Riverbend connects", 20_000);
  t.assert(
    (await t.eval(storedHosts)).join() === `${LCC},${RSU}`,
    "both schools are saved in the order they were added",
    JSON.stringify(await t.eval(storedHosts)),
  );
  await assertNoLeak(t, "after connecting Riverbend");
  t.assert(
    vaultKeys(await t.vaultFile()) === "lcc,rsu",
    "main's vault holds an entry for each connected school",
    await t.vaultFile(),
  );
  t.assert(
    !(await t.eval(
      `indexedDB.databases().then((dbs) => dbs.some((db) => db.name === "lms-app-vault"))`,
    )),
    "the desktop app keeps no vault in IndexedDB",
  );
  t.assert(
    (await surfaces(t)).bridge.match(/stand-in:/g)?.length === 2,
    "DevTools can get a stand-in for each school from main, and the leak scan read both",
  );

  await t.click(`[aria-label="Remove ${RSU}"]`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG)})?.innerText.includes("forgets the token in your Mac's Keychain")`,
    "on the desktop, Remove says the token is forgotten from the Keychain, not a browser",
  );
  await t.click("Remove", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(ROW(RSU))})`,
    "confirming Remove drops the connected school",
  );
  t.assert(
    vaultKeys(await t.vaultFile()) === "lcc",
    "removing a school deletes its entry from main's vault",
    await t.vaultFile(),
  );
  t.assert(
    (await t.eval(storedHosts)).join() === LCC,
    "a removed school is no longer saved",
    JSON.stringify(await t.eval(storedHosts)),
  );
  await shot("removed-connected-school");
  await addAddress(t, RSU);
  await enter(t, ROW_FIELD(RSU), SECRETS.rsu);
  await t.key("Enter");
  await t.waitFor(`${rowStatus(RSU)} === "connected"`, "a removed school connects again", 20_000);

  const undoWindows = await pretendPlatform(t, "Win32", "Windows");
  await t.waitFor(`${onDeviceRadio}`, "the AI choice is back after reloading as Windows");
  t.assert(
    (await t.eval(`${onDeviceRadio}.disabled`)) === true,
    "not a Mac: the on-device option is disabled",
  );
  t.assert(
    (await t.text('[data-ai-source="on-device"]')).includes("Only on a Mac"),
    "not a Mac: the on-device option says why",
  );
  await t.click('input[name="ai-source"][value="on-device"]', { timeout: 300 }).catch(() => {});
  t.assert(
    (await t.eval(`${onDeviceRadio}.checked`)) === false,
    "not a Mac: clicking the on-device option selects nothing",
  );
  await shot("ai-not-mac");
  await undoWindows();
  const undoMac = await pretendPlatform(t, "MacIntel", "macOS");
  await t.waitFor(`${onDeviceRadio}`, "the AI choice is back after reloading as a Mac");
  t.assert(
    (await t.eval(`${onDeviceRadio}.disabled`)) === false,
    "a Mac: the on-device option is enabled",
  );
  await t.click('input[name="ai-source"][value="on-device"]');
  t.assert(
    (await t.eval(`${onDeviceRadio}.checked`)) === true,
    "a Mac: the on-device option can be chosen",
  );
  t.assert(
    !(await t.eval(
      `[...document.querySelectorAll("main button")].find((b) => b.innerText === "Finish setup").disabled`,
    )),
    "a Mac: on-device is enough to finish",
  );
  await shot("ai-on-device");
  await undoMac();

  await t.click('input[name="ai-source"][value="key"]');
  await t.waitFor(
    `document.querySelector('[data-ai-source="key"] input[type="password"]')`,
    "choosing a key shows its field",
  );
  t.assert(
    await t.eval(
      `[...document.querySelectorAll("main button")].find((b) => b.innerText === "Finish setup").disabled`,
    ),
    "a key choice waits for a saved key",
  );
  t.assert(
    (await finishReason(t)).includes("Save your key"),
    "a key choice says Finish waits for the key",
    await finishReason(t),
  );
  await assertSafeField(t, '[data-ai-source="key"] input[type="password"]', "AI key field");
  await shot("ai-key-field");
  await enter(t, '[data-ai-source="key"] input[type="password"]', SECRETS.ai);
  await t.click("Save key", { within: '[data-ai-source="key"]' });
  await t.waitText("Key saved", "the key is saved in words");
  await assertNoLeak(t, "after saving the AI key");

  await t.key("Meta+k");
  await t.key("Meta+b");
  const entries = await t.eval("history.length");
  await t.click("Finish setup");
  await t.waitFor(
    `location.pathname === "/threads/t-north-star"`,
    "with a key, North Star is the landing page",
  );
  t.assert(
    (await t.eval("history.length")) === entries,
    "Finish setup adds no entry",
    `${entries} entries before, ${await t.eval("history.length")} after`,
  );
  t.assert(
    (await t.eval("history.state.__TSR_index")) === welcomeEntry,
    "Finish setup takes the welcome entry's place, so Back skips welcome and setup",
    `landed on entry ${await t.eval("history.state.__TSR_index")}, welcome was ${welcomeEntry}`,
  );
  await t.eval("history.forward()");
  await t.waitFor(
    `location.pathname === "/threads/t-north-star"`,
    "Forward after Finish setup stays in the app, not back into setup",
  );
  t.assert(
    (await t.pageText()).includes("You approve every write."),
    "the composer promises approval with a key saved",
  );
  t.assert(await t.has(SIDEBAR), "⌘B pressed during setup leaves the sidebar open");
  t.assert(!(await t.has(DIALOG)), "⌘K pressed during setup leaves the palette closed");
  await shot("first-app-screen");
  await t.goto("/welcome");
  await t.waitFor(
    `location.pathname === "/threads/t-north-star"`,
    "after setup, /welcome goes to the app, not back into setup",
  );
  await assertNoLeak(t, "after onboarding");
};

const connections = async (t, shot) => {
  await openSection(t, "Connections");
  await t.waitFor(
    `${cardStatus("lcc")} === "connected" && ${cardStatus("rsu")} === "connected"`,
    "both cards say connected",
  );
  const card = await t.text(CARD("lcc"));
  t.assert(
    card.includes("Connected") &&
      card.includes("Read, grade, message, announce, copy, publish") &&
      /Synced .*ago|Synced just now/.test(card),
    "a card shows status, a permission summary, and sync age",
    card,
  );
  t.assert(
    !card.includes("Post grades and comments"),
    "the full permission list starts collapsed",
    card,
  );
  await t.click(`${CARD("lcc")} [data-testid="scope-toggle"]`);
  await t.waitFor(
    `document.querySelector('${CARD("lcc")}').innerText.includes("Post grades and comments")`,
    "details opens the full permission list",
  );
  await t.click(`${CARD("lcc")} [data-testid="scope-toggle"]`);
  await t.waitFor(
    `!document.querySelector('${CARD("lcc")}').innerText.includes("Post grades and comments")`,
    "details closes it again",
  );
  t.assert(
    /^Token saved [A-Z][a-z]{2} \d{1,2}$/.test(
      await t.text(`${CARD("lcc")} [data-testid="token-words"]`),
    ),
    "a saved token shows only words",
  );
  t.assert(
    !(await t.eval(
      `[...document.querySelectorAll('${BODY} *')].some((el) => /[•*]{3,}|\\.{3,}[a-z0-9]{2,}$/i.test(el.innerText ?? ""))`,
    )),
    "no masked preview anywhere",
  );
  t.assert(!(await t.has(`${BODY} input[type="password"]`)), "no token field is left on the page");
  await shot("settings-connections");

  await t.click("Replace token", { within: CARD("lcc") });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG_FIELD)})`,
    "Replace token opens the shared form",
  );
  await assertSafeField(t, DIALOG_FIELD, "replace dialog");
  await t.eval(`window.__faultLab.setNoise({ rate5xx: 1 })`);
  await enter(t, DIALOG_FIELD, SECRETS.unreachable);
  await t.click("Replace token", { within: DIALOG });
  await assertRejected(
    t,
    DIALOG_FIELD,
    DIALOG,
    "could not be reached",
    SECRETS.unreachable,
    "a school that can't be reached",
    30_000,
  );
  t.assert(
    (await t.text(`${DIALOG} [role="alert"]`)).includes("current token is still in use"),
    "a failed replace says the old token is still in use",
  );
  await t.eval(`window.__faultLab.setNoise({ rate5xx: 0 })`);
  await enter(t, DIALOG_FIELD, SECRETS.replaced);
  await t.click("Replace token", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DIALOG)})`,
    "the replace dialog closes",
  );
  await t.waitFor(
    `${cardStatus("lcc")} === "connected"`,
    "the card stays connected after replacing",
  );
  await assertNoLeak(t, "after replacing a token");

  await t.eval(`window.__faultLab.setNoise({ rate5xx: 1 })`);
  await t.click("Sync now", { within: CARD("rsu") });
  await t.waitFor(
    `${cardStatus("rsu")} === "sync-failed"`,
    "a failed sync shows Sync failed",
    30_000,
  );
  t.assert(await t.eval(attentionDot), "the footer attention dot agrees with Sync failed");
  t.assert(
    (await t.text(CARD("rsu"))).includes("couldn't be reached"),
    "the card gives the reason",
  );
  t.assert((await t.text(SIDEBAR)).includes("Constellation"), "the sidebar names the product");
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('${SIDEBAR} [data-school-star]')].map((star) => star.dataset.schoolStar).join()`,
    )) === "lcc,rsu",
    "each school is a star in the sidebar",
  );
  t.assert(
    await t.eval(`document.querySelector('${SIDEBAR} [data-connection="sync-failed"]') !== null`),
    "the sidebar dot says Sync failed",
  );
  await t.eval(`window.__faultLab.setNoise({ rate5xx: 0, latencyMs: [700, 700] })`);
  await t.click("Sync now", { within: CARD("rsu") });
  await t.waitFor(`${cardStatus("rsu")} === "syncing"`, "syncing shows on the card");
  t.assert(
    await t.eval(`document.querySelector('${SIDEBAR} [data-connection="syncing"]') !== null`),
    "the sidebar dot says Syncing",
  );
  const rsuCourseTop = `document.querySelector('${SIDEBAR} [aria-label$=" ENG 210"]').getBoundingClientRect().top`;
  const topWhileSyncing = await t.eval(rsuCourseTop);
  await t.waitFor(`${cardStatus("rsu")} === "connected"`, "a good sync recovers", 20_000);
  t.assert(
    (await t.eval(rsuCourseTop)) === topWhileSyncing,
    "a sync starting or ending doesn't move the course rows under the pointer",
    `${topWhileSyncing} -> ${await t.eval(rsuCourseTop)}`,
  );
  t.assert(!(await t.eval(attentionDot)), "the attention dot clears");
  await t.eval(`window.__faultLab.setNoise({ latencyMs: [120, 240] })`);

  const before = await t.eval(
    `Object.keys(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).length`,
  );
  await t.click("Disconnect", { within: CARD("rsu") });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG)})?.innerText.includes("nothing is deleted from the LMS")`,
    "Disconnect asks first and says nothing is deleted",
  );
  t.assert(
    (await t.text(DIALOG)).includes("unsent work and approvals are kept"),
    "the confirm says drafts are kept",
  );
  await shot("disconnect-confirm");
  await t.click("Cancel", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DIALOG)})`,
    "Cancel closes the confirm",
  );
  t.assert((await t.eval(cardStatus("rsu"))) === "connected", "Cancel leaves the school connected");
  await t.click("Disconnect", { within: CARD("rsu") });
  await t.click("Disconnect", { within: DIALOG });
  await t.waitFor(
    `${cardStatus("rsu")} === "disconnected"`,
    "Disconnect leaves the school not connected",
  );
  t.assert((await t.text(CARD("rsu"))).includes("Not connected"), "the card says Not connected");
  t.assert((await t.text(SIDEBAR)).includes("Reconnect"), "the sidebar offers Reconnect");
  t.assert(
    (await t.eval(
      `Object.keys(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).length`,
    )) === before,
    "disconnecting keeps every draft",
  );
  await t.click("Disconnect", { within: CARD("lcc") });
  await t.click("Disconnect", { within: DIALOG });
  await t.waitFor(`${cardStatus("lcc")} === "disconnected"`, "both schools are disconnected");
  await t.click("What's due", { within: SIDEBAR });
  await t.waitFor(
    `document.querySelectorAll('[data-disconnected]').length === 2`,
    "What's due names both disconnected schools",
  );
  const blind = await t.pageText();
  t.assert(
    blind.includes("Reconnect one to see its work here.") && !blind.includes("Nothing is due"),
    "with every school disconnected, What's due says it can't see the work",
    blind,
  );
  await shot("due-all-disconnected");
  await t.click("Reconnect", { within: '[data-disconnected="lcc"]' });
  await enter(t, DIALOG_FIELD, SECRETS.fromDue);
  await t.click("Connect", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector('[data-disconnected="lcc"]') && document.querySelector('[data-disconnected="rsu"]') && document.querySelector('[data-testid="due-list"]')`,
    "reconnecting from What's due brings Lakeshore's work back and keeps Riverbend's notice",
    30_000,
  );
  await shot("due-reconnected-one");
  await openSection(t, "Connections");
  await t.click("Connect", { within: CARD("rsu") });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG_FIELD)})`,
    "Connect opens the shared form",
  );
  await t.key("Escape");
  await t.waitFor(`!document.querySelector(${JSON.stringify(DIALOG)})`, "Escape closes Connect");
  const ADD = '[data-testid="add-institution"]';
  await refusesDuplicate(t, RSU, {
    scope: ADD,
    rows: 0,
    focusHost: "",
    words: "Riverbend State University is already here. Connect it above.",
    tag: "Settings, a disconnected school",
  });
  t.assert(
    (await t.eval(
      `document.activeElement === document.querySelector('${CARD("rsu")} [data-action="connect"]')`,
    )) === true,
    "Settings, a disconnected school: focus lands on its card's Connect",
    await t.eval(`document.activeElement?.outerHTML.slice(0, 120)`),
  );
  await shot("settings-duplicate-disconnected-school");
  await clearAddress(t, ADD);

  t.assert(
    !(await t.text(CARD("lcc"))).includes("Remove school"),
    "a connected school offers Disconnect, not Remove school",
  );
  t.assert(
    (await t.eval(
      `Object.values(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).some((change) => change.school === "rsu")`,
    )) === false,
    "Riverbend has no drafts",
  );
  await shot("disconnected-card");
  await t.click("Remove school", { within: CARD("rsu") });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG)})?.innerText.includes("Nothing is deleted from the LMS")`,
    "Remove school asks first and says nothing is deleted",
  );
  t.assert((await t.text(DIALOG)).includes("Remove Riverbend"), "the confirm names the school");
  await shot("remove-disconnected-confirm");
  await t.click("Cancel", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DIALOG)})`,
    "Cancel closes the confirm",
  );
  t.assert((await t.eval(cardStatus("rsu"))) === "disconnected", "Cancel keeps the school");
  await t.click("Remove school", { within: CARD("rsu") });
  await t.click("Remove", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector('${CARD("rsu")}') && !document.querySelector(${JSON.stringify(DIALOG)})`,
    "confirming Remove drops the disconnected school's card",
  );
  t.assert(
    !(await t.text(SIDEBAR)).includes("Riverbend"),
    "the sidebar no longer offers to reconnect a removed school",
  );
  t.assert(
    (await t.eval(storedHosts)).join() === LCC,
    "a removed disconnected school is no longer saved",
    JSON.stringify(await t.eval(storedHosts)),
  );
  await shot("removed-disconnected-school");

  await addAddress(t, RSU, { scope: ADD });
  await enter(t, `${ADD} ${ROW_FIELD(RSU)}`, SECRETS.afterDisconnect);
  await t.key("Enter");
  await t.waitFor(
    `${cardStatus("rsu")} === "connected"`,
    "a removed school can be added and connected again",
    20_000,
  );
  await assertNoLeak(t, "after disconnecting and connecting");
};

const ai = async (t, shot) => {
  await openSection(t, "AI");
  const row = '[data-testid="ai-source-row"]';
  const says = (label, tag) =>
    t.waitFor(
      `document.querySelector(${JSON.stringify(row)})?.innerText.includes(${JSON.stringify(label)})`,
      tag,
    );
  await says("Anthropic key", "the AI section says drafts come from the saved key");
  t.assert(
    (await t.text('[data-testid="ai-agent-row"]')).includes("Rule-based drafts"),
    "the active agent's label comes from the agent",
  );
  await shot("settings-ai");
  await t.click("Replace key", { within: row });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG_FIELD)})`,
    "Replace key opens a field",
  );
  await assertSafeField(t, DIALOG_FIELD, "AI dialog");
  await enter(t, DIALOG_FIELD, SECRETS.aiReplaced);
  await t.click("Replace key", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DIALOG)})`,
    "the AI dialog closes after replacing",
  );
  await says("Anthropic key", "the key is still the source after replacing");
  await t.click("Remove key", { within: row });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG)})?.innerText.includes("Your chats are kept and come back when AI is on.")`,
    "Remove key asks first and says chats are kept",
  );
  await says("Anthropic key", "the key stays until the removal is confirmed");
  await t.click("Remove key", { within: DIALOG });
  await says("Off", "confirming Remove key turns AI off");
  t.assert(!(await t.has('[data-testid="ai-agent-row"]')), "with AI off there is no active agent");
  await t.click("Use on-device model", { within: row });
  await says("On-device model", "the on-device model can be chosen in Settings");
  await t.click("Turn off AI", { within: row });
  await t.click("Turn off AI", { within: DIALOG });
  await says("Off", "confirming Turn off AI turns it off");
  await t.click("Use a key", { within: row });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG_FIELD)})`,
    "Use a key opens a field",
  );
  await t.click("Save key", { within: DIALOG });
  await assertRejected(t, DIALOG_FIELD, DIALOG, "Paste a key first", "\0", "a blank key");
  await enter(t, DIALOG_FIELD, SECRETS.aiAgain);
  await t.key("Enter");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DIALOG)})`,
    "the AI dialog closes after adding",
  );
  await says("Anthropic key", "the key is the source again");
  t.assert(
    (await t.text('[data-testid="ai-agent-row"]')).includes("Rule-based drafts"),
    "the label stays rule-based, since no model is wired up",
  );
  await assertNoLeak(t, "after the AI key changes");
};

const pick = async (t, trigger, option) => {
  await t.click(trigger);
  await t.waitFor(
    `document.querySelector('[data-testid="picker-popup"]')?.checkVisibility()`,
    `the picker opens for ${option}`,
  );
  await t.click(option, { within: '[data-testid="picker-popup"]' });
  await t.waitFor(
    `!document.querySelector('[data-testid="picker-popup"]')?.checkVisibility()`,
    `the picker closes on ${option}`,
  );
};

const noiseDials = async (t, shot) => {
  await openSection(t, "Demo");
  const value = (key) => t.text(`[data-dial-value="${key}"]`);
  t.assert((await writes(t)) === 0, "nothing has reached the LMS before any send");
  t.assert((await t.text(LOG)).includes("Nothing has reached the LMS"), "the writes log says so");
  await t.click('[data-dial="rate429"]');
  await t.key("ArrowUp");
  await t.waitFor(
    `parseFloat(document.querySelector('[data-dial-value="rate429"]').innerText) > 0`,
    "moving a dial changes the rate",
  );
  t.assert(
    (await t.eval(`window.__faultLab.noise().rate429`)) > 0,
    "the dial reached the fake LMS",
    await value("rate429"),
  );
  const slowest = await t.eval(`window.__faultLab.noise().latencyMs[1]`);
  await t.click('[data-dial="slowest"]');
  await t.key("ArrowUp");
  await t.waitFor(
    `window.__faultLab.noise().latencyMs[1] !== ${slowest}`,
    "moving the slowest dial changes the answer speed",
  );
  const card = '[data-testid="noise-card"]';
  const buttons = await t.eval(
    `[...document.querySelector('${card}').querySelectorAll("button")].map((b) => b.innerText.trim())`,
  );
  t.assert(
    buttons.length === 1 && buttons[0] === "Reset to calm",
    "one reset control for random failures",
    JSON.stringify(buttons),
  );
  t.assert(
    (await t.text(card)).includes("200–900 ms"),
    "the card says the reset also sets the answer speed",
  );
  await t.click("Reset to calm", { within: card });
  await t.waitFor(
    `(({ rate429, rate5xx, rateLost, latencyMs }) => rate429 === 0 && rate5xx === 0 && rateLost === 0 && latencyMs[0] === 200 && latencyMs[1] === 900)(window.__faultLab.noise())`,
    "Reset to calm zeroes the rates and restores the answer speed",
  );
  t.assert((await value("rate429")) === "0%", "the dial shows zero");
  t.assert((await value("slowest")) === "900 ms", "the slowest dial shows 900 ms");
  await t.eval(`window.__faultLab.setNoise({ latencyMs: [120, 240] })`);
  const dial = '[role="switch"][aria-label="Demo script"]';
  t.assert(
    (await t.eval(`document.querySelector('${dial}').getAttribute("aria-checked")`)) === "false",
    "the demo script starts off in this run",
  );
  await t.click(dial);
  await t.waitFor(`window.__faultLab.demoScript().enabled`, "the switch turns the demo script on");
  await t.click(dial);
  await t.waitFor(
    `!window.__faultLab.demoScript().enabled`,
    "the switch turns the demo script off",
  );
  await shot("settings-demo");
};

const openStudent = async (t, student) => {
  if (!(await t.has(LIST))) await t.click("Expand queue");
  await t.waitFor(`document.querySelector(${JSON.stringify(LIST)})`, "the queue list is showing");
  await t.click(student, { within: LIST });
  const drafted = `document.querySelector("[data-focused]")?.innerText.includes(${JSON.stringify(student)})`;
  await t.waitFor(
    `${drafted} || document.querySelector('[data-testid="grade-open"]')?.innerText.includes(${JSON.stringify(student)})`,
    `${student}: opens`,
  );
  if (!(await t.eval(drafted)))
    await t.click("Draft with Claude", { within: '[data-testid="grade-open"]' });
  await t.waitFor(drafted, `${student}: draft appears`);
  await t.waitFor(
    `!document.querySelector('[data-testid="agent-working"]')`,
    `${student}: agent finished`,
  );
};

// The panel slides in over 200ms, and a click aimed mid-slide lands beside the tab it was aimed at.
const openPreview = async (t) => {
  await t.waitFor(
    `document.querySelector(${JSON.stringify(PANEL)})?.getAnimations().length === 0`,
    "the panel has finished opening",
  );
  await t.click("Preview", { within: PANEL });
  await t.waitFor(
    `document.querySelector('${PANEL} [role="tab"][aria-selected="true"]')?.innerText === "Preview"`,
    "the Preview tab is showing",
  );
};

const approveStudent = async (t, student) => {
  await t.openGradingList();
  await openStudent(t, student);
  await openPreview(t);
  await t.click("[data-approve]");
  await t.waitFor(
    `document.body.innerText.includes("Undo approval")`,
    `${student}: approval lands`,
  );
};

const expireFlow = async (t, shot) => {
  await approveStudent(t, "Darnell Pruitt");
  t.assert((await writes(t)) === 0, "approving alone writes nothing");
  await openSection(t, "Demo");
  await pick(t, '[aria-label="School to expire"]', "Riverbend State University");
  await pick(t, '[aria-label="School to expire"]', "Lakeshore Community College");
  await t.click("Expire token", { within: '[data-fault="expire"]' });
  await t.waitFor(
    `document.querySelector('[data-fault="expire"]').innerText.includes("Token expired")`,
    "the Demo tab shows the school expired",
  );
  t.assert((await writes(t)) === 0, "expiring a token writes nothing");

  await openSection(t, "Connections");
  await t.waitFor(`${cardStatus("lcc")} === "expired"`, "Settings shows Token expired");
  const waiting = await t.text(`${CARD("lcc")} [data-testid="waiting-words"]`);
  t.assert(
    waiting.includes("1 change is waiting") && waiting.includes("does not send"),
    "the card counts what's waiting and says reconnecting won't send it",
    waiting,
  );
  t.assert(await t.has('[data-testid="school-reconnect"]'), "the sidebar shows the expired token");
  t.assert(
    await t.eval(`document.querySelector('${SIDEBAR} [data-connection="expired"]') !== null`),
    "the sidebar dot says expired",
  );
  t.assert(await t.eval(attentionDot), "the footer attention dot shows");
  const { width, height } = t.size;
  await t.viewport(1180, 800);
  t.assert(
    await t.eval(
      `document.querySelector('a[href="/settings"] [data-testid="sidebar-warning-dot"]')?.getClientRects().length > 0`,
    ),
    "at 1180 the rail's Settings gear carries a warning dot for the expired school",
  );
  await t.viewport(width, height);
  t.assert(
    !(await t.eval(
      `[...document.querySelectorAll('${CARD("lcc")} button')].some((b) => b.innerText === "Sync now")`,
    )),
    "an expired school offers no Sync now",
  );
  await shot("settings-expired");

  await t.click("Reconnect", { within: CARD("lcc") });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG_FIELD)})`,
    "Reconnect opens the shared form",
  );
  await enter(t, DIALOG_FIELD, SECRETS.replaced);
  await t.click("Connect", { within: DIALOG });
  await assertRejected(t, DIALOG_FIELD, DIALOG, "refused", SECRETS.replaced, "a revoked token");
  t.assert(
    (await t.eval(cardStatus("lcc"))) === "expired",
    "a refused token leaves the school expired",
  );
  await shot("reconnect-refused");
  await t.key("Escape");
  await t.waitFor(`!document.querySelector(${JSON.stringify(DIALOG)})`, "Escape closes the dialog");

  await t.openGradingList();
  await openStudent(t, "Darnell Pruitt");
  await openPreview(t);
  await t.waitFor(
    `document.querySelector('[data-banner="reconnect"]')`,
    "an approved change on an expired token shows the reconnect banner",
  );
  t.assert(
    !(await t.text(PANEL)).includes("Send to"),
    "the panel offers no send until reconnecting",
  );
  t.assert((await writes(t)) === 0, "an expired token writes nothing");
  await shot("send-expired-banner");
  await t.click("Reconnect", { within: PANEL });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG_FIELD)})`,
    "the banner opens the same form as Settings",
  );
  await assertSafeField(t, DIALOG_FIELD, "banner dialog");
  t.assert(
    (await t.eval(`document.querySelectorAll('${DIALOG} ol li').length`)) >= 3,
    "the banner's form has the enrollment steps",
  );
  await enter(t, DIALOG_FIELD, SECRETS.reconnect);
  await t.click("Connect", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DIALOG)})`,
    "the banner's dialog closes after connecting",
  );
  await t.waitFor(
    `!document.querySelector('[data-banner="reconnect"]') && document.querySelector(${JSON.stringify(PANEL)}).innerText.includes("Send to")`,
    "reconnecting brings the send back",
  );
  await t.sleep(500);
  t.assert((await writes(t)) === 0, "reconnecting sends nothing by itself");
  await assertNoLeak(t, "after reconnecting from the banner");
  await t.click("Send to", { within: PANEL });
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]')`,
    "the approved send lands",
    20_000,
  );
  t.assert((await writes(t)) >= 1, "the log grows after the approved send");
};

const failureLab = async (t, shot) => {
  await openSection(t, "Demo");
  await t.waitFor(
    `Number(document.querySelector(${JSON.stringify(LOG)})?.dataset.count) >= 1`,
    "the writes log shows the send",
  );
  const log = await t.text(LOG);
  t.assert(
    log.includes("Darnell Pruitt") && log.includes("Grade"),
    "the log says who and which fields",
    log,
  );
  t.assert(!/SENTINEL|Bearer|token/i.test(log), "the log carries no secret", log);
  const count = await writes(t);
  await t.eval(`document.querySelector(${JSON.stringify(LOG)}).scrollIntoView()`);
  await shot("writes-log");

  const fault = (id) => `[data-fault="${id}"]`;
  for (const id of ["partial", "lost", "throttle"]) {
    t.assert(!(await t.text(fault(id))).includes("Armed"), `${id}: not armed at first`);
    await t.click("Arm", { within: fault(id) });
    await t.waitFor(
      `document.querySelector(${JSON.stringify(fault(id))}).innerText.includes("Armed")`,
      `${id}: shows armed`,
    );
    t.assert(
      (await t.eval(`document.querySelector('${fault(id)} button:not([aria-label])').disabled`)) ===
        true,
      `${id}: can't be armed twice`,
    );
    t.assert((await t.text(fault(id))).length > 60, `${id}: says what will happen`);
  }
  const armed = await t.eval(`window.__faultLab.armed()`);
  t.assert(
    armed.failedFields.length === 1 && armed.lostResponses === 1 && armed.throttles === 1,
    "the lab holds each armed fault",
    JSON.stringify(armed),
  );
  t.assert((await writes(t)) === count, "arming writes nothing");
  await t.eval(
    `document.querySelector('[data-fault="partial"]').scrollIntoView({ block: "center" })`,
  );
  await shot("demo-armed");
  await t.reload();
  await t.waitFor(
    `document.querySelector('[data-fault="throttle"]')`,
    "the Demo tab comes back after a reload",
  );
  t.assert(
    (await t.eval(`location.search`)).includes("section=demo"),
    "the section survives a reload",
  );
  t.assert(
    !(await t.text('[data-fault="throttle"]')).includes("Armed"),
    "a reload clears what was armed, as the screen says",
  );

  await pick(t, '[aria-label="Submission to change"]', "Maya Ortiz, Essay 2");
  await t.click('[aria-label="New grade"]');
  await t.key("Backspace");
  await t.key("Backspace");
  await t.type("71");
  await t.click("Change grade", { within: '[data-fault="regrade"]' });
  await t.waitFor(
    `document.querySelector('[data-fault="regrade"]').innerText.includes("is now 71")`,
    "the regrade shows what it did",
  );
  const regraded = await lms(
    t,
    `lms.submissions.find((s) => s.studentName === "Maya Ortiz" && s.assignment === lms.assignments.find((a) => a.shortTitle === "Essay 2")?.ref).grade`,
  );
  t.assert(regraded === 71, "the grade changed in the fake LMS", String(regraded));
  t.assert((await writes(t)) === count, "someone else's change is not one of the app's writes");

  await t.click("Arm", { within: fault("throttle") });
  await t.waitFor(
    `document.querySelector('[data-fault="throttle"]').innerText.includes("Armed")`,
    "throttle is armed for a real send",
  );
  await approveStudent(t, "Hannah Stroud");
  t.assert((await writes(t)) === count, "another approval writes nothing yet");
  await t.click("Send to", { within: PANEL });
  await t.waitFor(
    `document.querySelector('[data-testid="sent-banner"]')`,
    "the send waits out the throttle and lands",
    20_000,
  );
  t.assert((await writes(t)) > count, "the log grows only after this approved send");
  await openSection(t, "Demo");
  t.assert(
    !(await t.text('[data-fault="throttle"]')).includes("Armed"),
    "the throttle has fired and shows disarmed",
  );
};

const reloadStays = async (t) => {
  await openSection(t, "Connections");
  await t.reload();
  await t.waitFor(
    `${cardStatus("lcc")} === "connected" && ${cardStatus("rsu")} === "connected"`,
    "a reload stays connected",
  );
  await t.waitFor(`document.querySelector(${JSON.stringify(SIDEBAR)})`, "the shell comes back");
  const dots = await t.eval(
    `[...document.querySelectorAll('${SIDEBAR} [data-connection]')].map((dot) => dot.dataset.connection)`,
  );
  t.assert(
    dots.length === 2 && dots.every((dot) => dot === "connected" || dot === "syncing"),
    "both sidebar dots stay connected while the launch sync runs",
    JSON.stringify(dots),
  );
  await t.waitFor(
    `document.querySelectorAll('${SIDEBAR} [data-connection="connected"]').length === 2`,
    "both sidebar dots stay connected",
  );
  await assertNoLeak(t, "after a reload");
};

const REAL_SCHOOL = {
  id: "verify-real",
  abbr: "VR",
  name: "Verify Real Canvas",
  host: "verify-real.instructure.com",
  provider: "canvas",
};

/** A real school can't connect under verify, so it joins the saved workspace the way a reload would find it. */
const withSchools = async (t, saved, pick) => {
  await t.eval(`(() => {
    const stored = JSON.parse(${JSON.stringify(saved)});
    stored.state.schools = (${pick})(stored.state.schools, ${JSON.stringify(REAL_SCHOOL)});
    localStorage.setItem("lms-app.v1", JSON.stringify(stored));
  })()`);
  await t.reload();
};

const realSchoolSettings = async (t, shot) => {
  const saved = await t.eval(`localStorage.getItem("lms-app.v1")`);
  const bodyHas = (text) =>
    t.eval(
      `document.querySelector(${JSON.stringify(BODY)})?.innerText.includes(${JSON.stringify(text)})`,
    );

  await withSchools(t, saved, `(demo, real) => [real]`);
  await t.goto("/settings");
  await t.waitFor(
    `document.querySelector('${CARD(REAL_SCHOOL.id)}')`,
    "the real school's card shows",
  );
  const nav = await t.text(NAV);
  t.assert(!nav.includes("Demo"), "with only a real school, Settings has no Demo section", nav);
  await shot("real-school-settings");

  await t.goto("/settings?section=demo");
  await t.waitFor(`document.querySelector('${BODY} h2')`, "a Demo link opens Settings");
  t.assert(!(await bodyHas("Failure lab")), "a Demo link shows no Failure lab for a real school");
  t.assert(await t.has(CARD(REAL_SCHOOL.id)), "a Demo link opens Connections instead");
  await shot("real-school-demo-link");

  await openSection(t, "Appearance");
  t.assert(!(await bodyHas("browser")), "Appearance doesn't talk about a browser");
  await shot("real-school-appearance");

  await openSection(t, "Connections");
  await t.click("Connect", { within: CARD(REAL_SCHOOL.id) });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG_FIELD)})`,
    "the token dialog opens",
  );
  const dialog = await t.text(DIALOG);
  t.assert(
    !dialog.includes("Use a demo token"),
    "a real school isn't offered a demo token",
    dialog,
  );
  await shot("real-school-token-dialog");
  await t.key("Escape");

  await withSchools(t, saved, `(demo, real) => [real, ...demo]`);
  await openSection(t, "Demo");
  const target = await t.text('[aria-label="School to expire"]');
  t.assert(
    target !== REAL_SCHOOL.name,
    "beside a demo school, the Failure lab expires only demo schools",
    target,
  );
  await shot("mixed-schools-demo");

  await t.eval(`localStorage.setItem("lms-app.v1", ${JSON.stringify(saved)})`);
  await t.reload();
  await openSection(t, "Connections");
  await t.waitFor(
    `${cardStatus("lcc")} === "connected" && ${cardStatus("rsu")} === "connected"`,
    "the demo workspace comes back",
  );
};

let seededComments = null;

const assertWiped = async (t, tag) => {
  await t.waitFor(`location.pathname === "/welcome"`, `${tag}: lands on /welcome`);
  const stored = await t.eval(`(async () => {
    const state = JSON.parse(localStorage.getItem("lms-app.v1") ?? "{}").state ?? {};
    const lms = JSON.parse((await window.__faultLab.stored()) ?? "{}");
    return {
      changes: Object.keys(state.changes ?? {}).length,
      connected: Object.values(state.connections ?? {}).filter((c) => c.status !== "disconnected").length,
      onboarding: state.onboarding,
      ai: state.aiSource,
      writes: (lms.writeLog ?? []).length,
      tokens: (lms.tokens ?? lms.issuedTokens ?? []).length,
      mine: lms.submissions?.flatMap((s) => s.comments ?? []).filter((c) => c.mine).length ?? null,
      regrade: (lms.submissions ?? []).find((s) => s.studentName === "Maya Ortiz" && s.grade === 71) ? 1 : 0,
    };
  })()`);
  t.assert(stored.changes === 0, `${tag}: no changes left`, JSON.stringify(stored));
  t.assert(stored.connected === 0, `${tag}: no connections left`, JSON.stringify(stored));
  t.assert(stored.ai === "none", `${tag}: no AI key left`, JSON.stringify(stored));
  t.assert(
    (stored.onboarding ?? "welcome") === "welcome",
    `${tag}: onboarding starts over`,
    JSON.stringify(stored),
  );
  t.assert(
    stored.writes === 0 && (await writes(t)) === 0,
    `${tag}: the writes log is empty`,
    JSON.stringify(stored),
  );
  t.assert(
    (stored.mine === null || stored.mine === seededComments) && stored.regrade === 0,
    `${tag}: the fake LMS is back to its seed`,
    JSON.stringify(stored),
  );
  const read = await surfaces(t);
  t.assert(
    !read.indexedStores.includes("secrets"),
    `${tag}: IndexedDB holds no secrets`,
    read.indexedStores.join(", "),
  );
  await assertNoLeak(t, tag);
};

const resetFromDemo = async (t, shot) => {
  await openSection(t, "Demo");
  await t.click("Reset demo data", { within: BODY });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG)})?.innerText.includes("Reset demo data?")`,
    "Reset asks first",
  );
  const words = await t.text(DIALOG);
  t.assert(
    ["change", "thread", "token", "fake LMS"].every((word) => words.includes(word)),
    "the confirm names what is wiped",
    words,
  );
  await shot("reset-confirm");
  await t.click("Cancel", { within: DIALOG });
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DIALOG)})`,
    "Cancel closes the reset confirm",
  );
  t.assert((await writes(t)) > 0, "Cancel wipes nothing");
  await t.click("Reset demo data", { within: BODY });
  const entries = await t.eval("history.length");
  await t.click("Reset demo data", { within: DIALOG });
  await assertWiped(t, "reset from Demo");
  t.assert(
    (await t.eval("history.length")) === entries,
    "Reset demo replaces the page with /welcome, so Back has no gated entry to bounce off",
    `${entries} entries before, ${await t.eval("history.length")} after`,
  );
  await t.waitFor(
    `document.body.innerText.includes("Demo data was reset.")`,
    "the welcome screen says the demo data was reset",
  );
  await t.reload();
  await assertWiped(t, "reset, then reload");
  t.assert(
    !(await t.eval(`document.body.innerText.includes("Demo data was reset.")`)),
    "the reset notice is gone after a reload",
  );
  await shot("welcome-after-reset");
};

const DEEP_LINK = "/settings?section=ai";

const oneSchoolThenAdd = async (t, shot) => {
  await t.goto(DEEP_LINK);
  await t.waitFor(atWelcome, `a first run opening ${DEEP_LINK} lands on /welcome`);
  const linkEntry = await t.eval("history.state.__TSR_index");
  await t.click("Set up");
  await t.waitFor(atSetup, "after Reset demo, Set up opens /setup");
  await backAndForthFromSetup(t, "after Reset demo");
  await t.click(ADDRESS);
  await t.type("harvard");
  await t.key("Enter");
  await t.waitFor(
    `${addressAlert('[data-testid="where-you-teach"]')}.includes("isn't a web address")`,
    "an address with no dot is refused",
  );
  await t.click("Try it with demo schools");
  await t.waitFor(
    `document.querySelectorAll("[data-host]").length === 2`,
    "the demo fill adds both demo schools",
  );
  t.assert(
    (await t.eval(addressAlert('[data-testid="where-you-teach"]'))) === "",
    "the demo fill retires the old address error",
    await t.eval(addressAlert('[data-testid="where-you-teach"]')),
  );
  await clearAddress(t);
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('[data-host] input[type="password"]')].every((field) => field.value.length >= 20)`,
    )) === true,
    "the demo fill puts a token in each row",
  );
  t.assert(
    !(await t.has('[data-host][data-connection="connected"]')),
    "the demo fill connects nothing by itself",
  );
  await refusesDuplicate(t, `HTTPS://${LCC.toUpperCase()}/courses/12`, {
    rows: 2,
    focusHost: LCC,
    tag: "setup",
  });
  await shot("setup-duplicate-school");
  await t.click(`${ROW(LCC)} button[type="submit"]`);
  await t.waitFor(
    `${rowStatus(LCC)} === "connected"`,
    "the demo token connects by the same row",
    20_000,
  );
  await t.click('input[name="ai-source"][value="none"]');
  await assertFinishInView(t, 1280, 720, "setup 1280x720, one school connected");
  await t.viewport(1440, 900);
  await t.click("Finish setup");
  await t.waitFor(
    `location.pathname + location.search === ${JSON.stringify(DEEP_LINK)}`,
    "Finish setup opens the link the person came in on, and the app works with one school",
  );
  t.assert(
    (await t.eval("history.state.__TSR_index")) === linkEntry,
    "the link takes the welcome entry's place, so Back skips welcome and setup",
    `landed on entry ${await t.eval("history.state.__TSR_index")}, welcome was ${linkEntry}`,
  );
  t.assert(
    (await t.eval(
      `[...document.querySelectorAll('${SIDEBAR} [data-school-star]')].map((star) => star.dataset.schoolStar).join()`,
    )) === "lcc",
    "only the connected school is a star",
  );
  t.assert(!(await t.eval(attentionDot)), "a school never added is not an alarm");
  await shot("sidebar-one-school");

  await openSection(t, "Connections");
  const ADD = '[data-testid="add-institution"]';
  t.assert(!(await t.has(`${ADD} [data-host]`)), "Add institution lists no saved school again");
  await refusesDuplicate(t, LCC, {
    scope: ADD,
    rows: 0,
    focusHost: "",
    words: "Lakeshore Community College is already connected above.",
    tag: "Settings, a connected school",
  });
  await shot("settings-duplicate-saved-school");
  for (let index = 0; index < LCC.length; index++) await t.key("Backspace");
  await fixesTypo(t, shot, { scope: ADD, secret: SECRETS.fromSidebar, tag: "settings" });
  await assertSafeField(t, `${ADD} ${ROW_FIELD(RSU)}`, "Add institution row");
  t.assert(
    (await t.eval(`document.querySelectorAll('${ADD} ${ROW(RSU)} ol li').length`)) >= 3,
    "the Add institution row lists the token steps",
  );
  await shot("settings-add-institution");
  await refusesDuplicate(t, `https://${RSU}/`, {
    scope: ADD,
    rows: 1,
    focusHost: RSU,
    tag: "Settings, a typed row",
  });
  await shot("settings-duplicate-typed-school");
  await t.key("Enter");
  await t.waitFor(
    `${cardStatus("rsu")} === "connected"`,
    "the added school gets its own connected card",
    20_000,
  );
  t.assert(!(await t.has(`${ADD} ${ROW(RSU)}`)), "the connected row leaves the add form");
  await t.waitFor(
    `document.querySelectorAll('${SIDEBAR} [data-connection="connected"]').length === 2`,
    "both schools are connected",
  );
  await assertNoLeak(t, "after adding a school in Settings");

  await t.click("Disconnect", { within: CARD("rsu") });
  await t.click("Disconnect", { within: DIALOG });
  await t.waitFor(`${cardStatus("rsu")} === "disconnected"`, "Settings: Riverbend disconnects");
  await t.click("Remove school", { within: CARD("rsu") });
  await t.click("Remove", { within: DIALOG });
  await t.waitFor(`!document.querySelector('${CARD("rsu")}')`, "Settings: Riverbend is removed");
  await t.sleep(200);
  t.assert(
    !(await t.has(`${ADD} [data-host]`)),
    "a school removed from its card leaves no row under Add institution",
    await t.text(ADD),
  );
  await shot("settings-removed-added-school");

  const TYPO = "lakeshor.instructure.com";
  await clearAddress(t, ADD);
  await addAddress(t, TYPO, { scope: ADD });
  await enter(t, `${ADD} ${ROW_FIELD(TYPO)}`, SECRETS.unreachable);
  await t.key("Enter");
  await t.waitFor(
    `${rowAlerts(`${ADD} ${ROW(TYPO)}`)}.join().includes("Couldn't find a school")`,
    "Settings: an unknown address is refused",
    20_000,
  );
  await retype(t, `${ADD} ${ROW_ADDRESS(TYPO)}`, RSU);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(`${ADD} ${ROW(RSU)}`)})`,
    "Settings: the row moves to the edited address",
  );
  t.assert(
    (await t.eval(rowAlerts(`${ADD} ${ROW(RSU)}`))).length === 0,
    "Settings: a new address retires the error about the old one",
    JSON.stringify(await t.eval(rowAlerts(`${ADD} ${ROW(RSU)}`))),
  );
  await shot("settings-edited-address");
  await t.eval(`window.__faultLab.setNoise({ latencyMs: [900, 900] })`);
  await enter(t, `${ADD} ${ROW_FIELD(RSU)}`, SECRETS.rsu);
  await t.click(`${ADD} ${ROW(RSU)} button[type="submit"]`);
  t.assert(
    (await t.eval(
      `document.querySelector(${JSON.stringify(`${ADD} ${ROW_ADDRESS(RSU)}`)}).readOnly`,
    )) === true,
    "Settings: the address is locked while it connects",
  );
  await shot("settings-connecting-locked");
  await t.waitFor(
    `${cardStatus("rsu")} === "connected"`,
    "Settings: Riverbend connects again",
    20_000,
  );
  await t.eval(`window.__faultLab.setNoise({ latencyMs: [120, 240] })`);
  await assertNoLeak(t, "after the edited address in Settings");
};

const palette = async (t) => {
  await t.key("Meta+k");
  await t.waitFor(`document.querySelector('${DIALOG} input')`, "the palette opens");
  await t.type("Settings");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG)}).innerText.includes("Settings")`,
    "the palette lists Settings",
  );
  await t.key("Enter");
  await t.waitFor(`location.pathname === "/settings"`, "the palette goes to Settings");

  const openReset = async () => {
    await t.key("Meta+k");
    await t.waitFor(`document.querySelector('${DIALOG} input')`, "the palette opens again");
    await t.type("Reset demo");
    await t.waitFor(
      `document.querySelector(${JSON.stringify(DIALOG)}).innerText.includes("Reset demo data")`,
      "the palette lists Reset",
    );
    await t.key("Enter");
    await t.waitFor(
      `document.querySelector(${JSON.stringify(DIALOG)})?.innerText.includes("Reset demo data?")`,
      "the palette's Reset still opens the confirm",
    );
  };
  await openReset();
  t.assert(
    (await t.eval(`location.pathname`)) === "/settings",
    "the palette's Reset hasn't gone anywhere yet",
  );
  await t.click("Cancel", { within: DIALOG });
  await t.waitFor(`!document.querySelector(${JSON.stringify(DIALOG)})`, "Cancel closes it");
  t.assert(
    (await t.eval(
      `document.querySelectorAll('${SIDEBAR} [data-connection="connected"]').length`,
    )) === 2,
    "Cancel from the palette wipes nothing",
  );
  await openReset();
  await t.click("Reset demo data", { within: DIALOG });
  await assertWiped(t, "reset from the palette");
};

const FORM = "[data-change][data-focused]";
const FOOTER_NOTE = '[data-testid="still-missing"]';
const storedChanges = `Object.keys(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).length`;
const RATINGS = /Exemplary|Proficient|Developing|Beginning/;

const rowWith = (t, ...words) =>
  t.eval(
    `[...document.querySelectorAll("[data-row]")].find((row) => ${JSON.stringify(words)}.every((word) => row.innerText.includes(word)))?.dataset.row`,
  );

const typedScoreLimits = async (t, shot) => {
  const box = `document.querySelectorAll('[data-typed-score]')[0]`;
  const outOf = Number(
    await t.eval(`${box}.closest("[data-score]").innerText.match(/\\d+\\s*$/)[0]`),
  );
  const retype = async (text) => {
    await t.eval(`${box}.focus()`);
    for (const _ of await t.eval(`${box}.value`)) await t.key("Backspace");
    await t.type(text);
  };
  const shows = (value, label) =>
    t.waitFor(`${box}.value === ${JSON.stringify(value)}`, `no key: ${label}`);

  await retype(String(outOf + 5));
  await shot("typed-score-over-max");
  await t.key("Tab");
  await shows(String(outOf), "a score above the max holds at the max");
  await shot("typed-score-held-at-max");
  await retype("-3");
  await t.key("Tab");
  await shows("0", "a negative score holds at 0");
  await t.eval(`${box}.focus()`);
  await t.key("ArrowUp");
  await shows("1", "ArrowUp raises a typed score");
  await t.key("ArrowDown");
  await shows("0", "ArrowDown lowers a typed score");
};

const clearedFormIsDropped = async (t, shot) => {
  const box = `document.querySelectorAll('[data-typed-score]')[0]`;
  await t.eval(`${box}.focus()`);
  await t.type("10");
  await t.key("Enter");
  await t.waitFor(`${storedChanges} === 1`, "no key: typing a score saves the form");
  t.assert((await t.text(FORM)).includes("In progress"), "no key: a typed score reads In progress");
  await shot("no-key-typed-score");
  await t.eval(`${box}.focus()`);
  for (const _ of await t.eval(`${box}.value`)) await t.key("Backspace");
  await t.key("Enter");
  await t.waitFor(`${storedChanges} === 0`, "no key: clearing the only score saves nothing");
  const form = await t.text(FORM);
  t.assert(
    form.includes("Not started") && !form.includes("In progress"),
    "no key: a form cleared back to blank says Not started again",
    form,
  );
  t.assert(await t.eval(`${box}.value === ""`), "no key: the cleared score stays empty");
  await shot("no-key-cleared-score");
};

const noKeyFlow = async (t, shot) => {
  const page = () => t.text("body");
  t.assert(!(await t.has("[data-composer]")), "no key: the queue has no composer");
  t.assert(
    (await t.text('[data-testid="pinned-queue"]')).includes("Not started"),
    "no key: the queue says Not started",
  );
  t.assert(!(await page()).includes("Needs draft"), "no key: no chip says Needs draft");
  t.assert(
    !(await t.has('[aria-label^="New thread"]')),
    "no key: no sidebar button starts a new thread",
  );
  t.assert(
    !(await t.has("[data-row] input")) && !(await page()).includes("Select all shown"),
    "no key: blank forms offer no checkboxes and no Select all, since nothing can be batched",
  );

  await t.goto("/threads/t-general");
  await t.waitFor(
    `location.pathname === "/due"`,
    "no key: a general thread's URL goes to What's due",
  );
  await t.openGradingList();
  await t.waitFor(
    `document.querySelector('[data-testid="queue-list"]')`,
    "no key: the list opens from What's due",
  );

  await t.key("Meta+k");
  await t.waitFor(`document.querySelector('${DIALOG} input')`, "no key: the palette opens");
  t.assert(
    !(await t.text(DIALOG)).includes("New thread"),
    "no key: the palette lists no general thread",
  );
  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector(${JSON.stringify(DIALOG)})`,
    "no key: the palette closes",
  );

  await t.click(`[data-row="${await rowWith(t, "Essay 2", "Not started")}"] button`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(FORM)})`,
    "no key: opening a row shows a form",
  );
  t.assert(await t.has("[data-criterion]"), "no key: this form has rubric rows");
  const form = await t.text(FORM);
  t.assert(!(await page()).includes("AI draft"), "no key: no AI draft label");
  t.assert(
    form.includes("Not started") && !form.includes("In progress"),
    "no key: an untouched form says Not started, the same word as its row",
    form,
  );
  t.assert(
    (await t.text('[data-testid="draft-grade"]')).includes("Not scored"),
    "no key: the total reads Not scored",
  );
  t.assert(!RATINGS.test(form), "no key: an unset score shows no rating words", form);
  t.assert(!(await t.has("[data-rationale]")), "no key: the form has no rationale");
  t.assert(!(await t.has("[data-composer]")), "no key: the form has no composer");
  t.assert(!form.includes("Discard"), "no key: an untouched form has nothing to discard");
  const scores = await t.eval(`document.querySelectorAll('[data-typed-score]').length`);
  t.assert(scores > 0, "no key: scores can be typed");
  t.assert(
    await t.eval(
      `[...document.querySelectorAll('[data-typed-score]')].every((input) => input.value === "")`,
    ),
    "no key: every score starts empty",
  );
  t.assert(
    await t.eval(`document.querySelector('[data-edit-field]').value === ""`),
    "no key: the comment starts empty",
  );
  t.assert((await t.eval(storedChanges)) === 0, "no key: opening a form saved nothing");
  await shot("no-key-blank-form");
  await clearedFormIsDropped(t, shot);

  await t.reload();
  await t.waitFor(
    `document.querySelector('[data-testid="queue-list"]')`,
    "no key: reloading on an untouched form returns to the list",
  );
  t.assert(!(await t.has(FORM)), "no key: the untouched form is gone after the reload");
  await t.click(`[data-row="${await rowWith(t, "Essay 2", "Not started")}"] button`);
  await t.waitFor(
    `document.querySelector(${JSON.stringify(FORM)})`,
    "no key: the row opens again after the reload",
  );

  await t.click("Preview", { within: '[data-testid="thread-panel"]' });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(FOOTER_NOTE)})`,
    "no key: the preview says what's left",
  );
  t.assert(
    (await t.text(FOOTER_NOTE)).startsWith("Fill in "),
    "no key: the preview asks for the blanks",
  );
  t.assert(!(await t.has("[data-approve]")), "no key: nothing can be approved yet");
  await shot("no-key-approve-gate");
  await t.click("[data-card-edit]", { within: FORM });
  await t.waitFor(
    `document.querySelector('[data-typed-score]') && !document.querySelector('[data-testid="thread-panel"]')`,
    "no key: Edit closes the preview and opens the form back up",
  );

  for (let index = 0; index < scores; index++) {
    t.assert(
      (await t.text(`${FORM} [data-card-missing]`)).startsWith("Fill in "),
      `no key: the form still names what's left with ${scores - index} blank`,
      await t.text(`${FORM} [data-card-primary]`),
    );
    await t.eval(`document.querySelectorAll('[data-typed-score]')[${index}].focus()`);
    await t.type(index === 0 ? "0" : "5");
    await t.key("Enter");
    await t.waitFor(
      `document.querySelectorAll('[data-typed-score]')[${index}].value !== ""`,
      `no key: score ${index + 1} holds`,
    );
    if (index === 0 && scores > 1)
      t.assert(
        (await t.text(FORM)).includes("In progress"),
        "no key: a started form reads In progress",
        await t.text(FORM),
      );
  }
  t.assert((await t.eval(storedChanges)) === 1, "no key: the first edit saved the form");
  await typedScoreLimits(t, shot);
  t.assert(RATINGS.test(await t.text(FORM)), "no key: a set score shows its rating");
  const chordButton = `${FORM} [data-testid="card-actions"] [data-approve]`;
  const offersChord = `document.querySelector(${JSON.stringify(chordButton)})?.innerText.startsWith("Approve and send")`;
  t.assert(
    !(await t.eval(offersChord)) && (await t.has(chordButton)),
    "no key: a form with no comment offers Approve, not Approve and send",
    await t.text(`${FORM} [data-testid="card-actions"]`),
  );
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.matches(${JSON.stringify(chordButton)})`,
    "no key: ⌘↵ on a form with no comment stops on Approve",
  );
  t.assert(
    await t.eval(
      `Object.values(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).every((c) => c.state.tag === "draft")`,
    ),
    "no key: ⌘↵ on a form with no comment approves nothing",
  );
  await shot("no-key-no-comment-stops");
  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector('[data-testid="thread-panel"]') && document.querySelector(${JSON.stringify(`${FORM} textarea`)})`,
    "no key: Escape goes back to the form",
  );
  await t.eval(`document.querySelector(${JSON.stringify(`${FORM} textarea`)}).focus()`);
  await t.type("Clear thesis. Cite the second source.");
  await t.key("Tab");
  await t.waitFor(
    `(document.querySelector(${JSON.stringify(chordButton)})?.innerText ?? "").trim() === "Approve"`,
    "no key: a filled hand-typed form offers Approve, as an AI draft does (#51)",
  );
  t.assert(
    !(await t.eval(offersChord)),
    "no key: a filled hand-typed form never offers Approve and send (#51)",
    await t.text(`${FORM} [data-testid="card-actions"]`),
  );
  await shot("no-key-filled-card");
  await t.click("Preview", { within: FORM });
  await t.waitFor(
    `document.querySelector('[data-testid="thread-panel"] [data-approve]')`,
    "no key: the preview is still one click away, and a filled form can be approved there",
  );
  t.assert(!(await t.has(FOOTER_NOTE)), "no key: a filled form asks for nothing");
  t.assert(!(await page()).includes("AI draft"), "no key: a hand-written form never says AI draft");
  await t.key("Escape");
  await t.waitFor(
    `!document.querySelector('[data-testid="thread-panel"]')`,
    "no key: Escape closes the preview",
  );
  await t.eval(
    `(() => { const input = document.querySelector('[data-typed-score]'); input.focus(); input.select(); })()`,
  );
  await t.type("99");
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector('[data-typed-score]').value === "25"`,
    "no key: a score over the maximum is capped",
  );
  await t.sleep(300);
  t.assert(
    !(await t.has(`${FORM} [data-testid="receipt"]`)) &&
      (await t.eval(
        `Object.values(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).every((c) => c.state.tag === "draft")`,
      )),
    "no key: ⌘↵ on a capped score sends nothing, so the person sees the 25 first",
  );
  const before = await t.eval(`window.__faultLab.writes().length`);
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.activeElement?.hasAttribute("data-approve")`,
    "no key: ⌘↵ on a filled hand grade stops on Approve (#51)",
  );
  await t.key("Enter");
  await t.waitFor(
    `document.body.innerText.includes("Undo approval")`,
    "no key: Approve stops at Approved. Not sent (#51)",
  );
  t.assert(
    (await t.eval(`window.__faultLab.writes().length`)) === before &&
      !(await t.has(`${FORM} [data-testid="receipt"]`)),
    "no key: Approve alone writes nothing to the LMS (#51)",
  );
  await shot("no-key-approved-not-sent");
  await t.key("Meta+Enter");
  await t.waitFor(
    `document.querySelector('${FORM} [data-testid="receipt"]')`,
    "no key: ⌘↵ then sends the approved grade",
    20_000,
  );
  t.assert(
    (await t.eval(`window.__faultLab.writes().length`)) > before,
    "no key: the send reached the fake LMS",
  );
  t.assert(
    await t.eval(
      `Object.values(JSON.parse(localStorage.getItem("lms-app.v1")).state.changes).some((c) => c.state.tag === "sent" && c.state.approval.via === "button")`,
    ),
    "no key: the approval is on record as the button",
  );
  await shot("no-key-sent");

  await addAiKey(t);
  t.assert(await t.has("[data-composer]"), "with a key: the composer is back");
  if (!(await t.has('[data-testid="queue-list"]'))) await t.click("Expand queue");
  await t.waitFor(
    `document.querySelector('[data-testid="queue-list"]')`,
    "with a key: the queue list is showing",
  );
  t.assert(
    !(await t.text('[data-testid="pinned-queue"]')).includes("Needs draft"),
    "with a key: the queue keeps the one word, Not started",
  );
  await t.click(`[data-row="${await rowWith(t, "Not started")}"] button`);
  await t.waitFor(
    `document.querySelector('[data-testid="grade-open"]')`,
    "with a key: opening a row offers Draft with Claude",
  );
  await t.click("Draft with Claude", { within: '[data-testid="grade-open"]' });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(FORM)})?.innerText.includes("AI draft. Not sent")`,
    "with a key: Draft with Claude writes an AI draft",
  );
  t.assert(await t.has("[data-composer]"), "with a key: the draft has a composer");
  await shot("with-key-draft");
};

const NO_SCHOOL_SCREENS = [
  ["due", "What's due", "/due"],
  ["grading-list", '[data-testid="grading-list-link"]', "/threads/"],
  ["calendar", "Calendar", "/calendar"],
];
const STALE_WORDS = ["Nothing is due", "list above", "Nothing to grade here", "connected yet"];

const saysNoSchool = async (t, shot, gap) => {
  for (const [screen, link, path] of NO_SCHOOL_SCREENS) {
    await t.click(link, screen === "grading-list" ? {} : { within: SIDEBAR });
    await t.waitFor(
      `location.pathname.startsWith(${JSON.stringify(path)})`,
      `${gap}: ${screen} opens`,
    );
    await t.sleep(300);
    await shot(`no-school-${gap}-${screen}`);
    t.assert(
      await t.has(`[data-testid="no-school"][data-gap="${gap}"] a[href="/settings"]`),
      `${gap}: ${screen} says to ${gap === "none" ? "add" : "reconnect"} a school and links to Connections`,
    );
    const words = await t.pageText();
    t.assert(
      STALE_WORDS.every((stale) => !words.includes(stale)),
      `${gap}: ${screen} says nothing about work it cannot see`,
      words,
    );
  }
};

const noSchool = async (t, shot) => {
  await openSection(t, "Connections");
  for (const school of ["lcc", "rsu"]) {
    await t.click("Disconnect", { within: CARD(school) });
    await t.click("Disconnect", { within: DIALOG });
    await t.waitFor(`${cardStatus(school)} === "disconnected"`, `${school} disconnects`);
  }
  await saysNoSchool(t, shot, "disconnected");
  await openSection(t, "Connections");
  for (const school of ["lcc", "rsu"]) {
    await t.click("Remove school", { within: CARD(school) });
    await t.click("Remove", { within: DIALOG });
    await t.waitFor(
      `!document.querySelector('${CARD(school)}') && !document.querySelector(${JSON.stringify(DIALOG)})`,
      `${school} is removed`,
    );
  }
  await saysNoSchool(t, shot, "none");
};

const demoShortcut = async (t, shot) => {
  await onboard(t);
  await t.waitFor(`location.pathname === "/due"`, "the demo schools with no AI land on What's due");
  await t.openGradingList();
  await t.waitFor(
    `document.querySelectorAll('[data-row]').length === 32`,
    "the queue has its 32 rows",
  );
  await noKeyFlow(t, shot);
  await t.key("Meta+k");
  await t.waitFor(
    `document.querySelector('${DIALOG} input')`,
    "the palette opens for the last reset",
  );
  await t.type("Reset demo");
  await t.key("Enter");
  await t.waitFor(
    `document.querySelector(${JSON.stringify(DIALOG)})?.innerText.includes("Reset demo data?")`,
    "the last reset asks first",
  );
  await t.click("Reset demo data", { within: DIALOG });
  await assertWiped(t, "the last reset");
};

export const run = async (t) => {
  const shot = shooter(t);
  await onboarding(t, shot);
  await connections(t, shot);
  await ai(t, shot);
  await noiseDials(t, shot);
  await expireFlow(t, shot);
  await failureLab(t, shot);
  await reloadStays(t);
  await realSchoolSettings(t, shot);
  await openSection(t, "Connections");
  await assertLayout(t, 1440, 900, "1440x900");
  await assertLayout(t, 1180, 800, "1180x800");
  await sidebarRail(t);
  await t.click("Demo", { within: NAV });
  await t.sleep(100);
  await shot("settings-demo-1180");
  await t.viewport(1440, 900);
  await t.click("Connections", { within: NAV });
  await resetFromDemo(t, shot);
  await oneSchoolThenAdd(t, shot);
  await palette(t);
  await demoShortcut(t, shot);
  await onboard(t);
  await noSchool(t, shot);
};
