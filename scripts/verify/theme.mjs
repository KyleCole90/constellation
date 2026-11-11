// The light and dark themes: the first frame matches the OS or the stored choice, Settings switches it, text and focus rings clear WCAG AA, and the main screens pass the layout audit in both at 1440x900 and 1280x720.
import { APP_URL } from "../../src/main/security.ts";
import { addAiKey } from "./ai-key.mjs";

const SIDEBAR = '[data-testid="sidebar"]';
const NAV = '[data-testid="settings-nav"]';
const THEME_GROUP = '[role="radiogroup"][aria-label="Theme"]';
const QUIET = JSON.stringify({ rate429: 0, rate5xx: 0, rateLost: 0, latencyMs: [20, 60] });
const SIZES = [
  [1440, 900],
  [1280, 720],
];
const THEMES = ["light", "dark"];

const os = (t, scheme) => t.media({ "prefers-color-scheme": scheme });

// The mean brightness of each painted frame, so a frame shown in the other theme before the stylesheet or the app loads shows up.
const SIDE_OF_FRAMES = `async (frames) => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const sides = [];
  for (const data of frames) {
    const image = new Image();
    image.src = "data:image/png;base64," + data;
    await image.decode();
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    const [r, g, b] = pixels;
    sides.push(r > 200 && g < 60 && b > 200 ? "old" : sum / (pixels.length / 4) > 128 ? "light" : "dark");
  }
  return sides;
}`;

const luminanceOf = String.raw`(theme) => {
  const probe = document.createElement("div");
  document.documentElement.append(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const resolve = (css) => {
    probe.style.backgroundColor = "";
    probe.style.backgroundColor = css;
    const value = getComputedStyle(probe).backgroundColor;
    if (!probe.style.backgroundColor) throw new Error("not a colour: " + css);
    return value;
  };
  const paint = (layers) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const layer of layers) {
      const color = resolve(layer);
      ctx.fillStyle = "#010203";
      ctx.fillStyle = color;
      if (ctx.fillStyle === "#010203" && !/^rgba?\(1, 2, 3/.test(color)) throw new Error("canvas can't paint " + color + " from " + layer);
      ctx.fillRect(0, 0, 1, 1);
    }
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a !== 255) throw new Error("not opaque: " + layers.join(" over "));
    return [r, g, b];
  };
  const channel = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return (surface, ink) => {
    const back = paint(surface);
    const front = paint([...surface, ink]);
    const [hi, lo] = [luminance(back), luminance(front)].sort((x, y) => y - x);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
}`;

const v = (name) => `var(--${name})`;
const SURFACES = {
  background: [v("background")],
  card: [v("background"), v("card")],
  popover: [v("background"), v("popover")],
  sidebar: [v("background"), v("sidebar")],
  "selected row": [v("background"), v("card"), v("selected")],
  "hovered row": [v("background"), v("accent")],
  button: [v("background"), v("card"), v("secondary")],
  message: [v("background"), v("message-surface")],
};
const TEXT = [
  "foreground",
  "secondary-label",
  "tertiary-label",
  "muted-foreground",
  "info-foreground",
  "success-foreground",
  "warning-foreground",
  "error-foreground",
];
const SCHOOLS = ["lcc", "rsu"];
const CRITS = [1, 2, 3, 4];
const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

// [what, surface layers, text or ring colour, the AA minimum]
const PAIRS = [
  ...Object.entries(SURFACES).flatMap(([surface, layers]) =>
    TEXT.map((ink) => [`${ink} on ${surface}`, layers, v(ink), 4.5]),
  ),
  ...["background", "card", "popover", "sidebar", "selected row"].map((surface) => [
    `focus ring on ${surface}`,
    SURFACES[surface],
    v("ring"),
    3,
  ]),
  ["primary-foreground on primary", [v("background"), v("primary")], v("primary-foreground"), 4.5],
  [
    "primary-ink on a 10% primary tint",
    [v("background"), tint(v("primary"), 10)],
    v("primary-ink"),
    4.5,
  ],
  ["sidebar-foreground on sidebar", SURFACES.sidebar, v("sidebar-foreground"), 4.5],
  ["sidebar-muted-foreground on sidebar", SURFACES.sidebar, v("sidebar-muted-foreground"), 4.5],
  ["reading text on background", SURFACES.background, "var(--paper-foreground)", 4.5],
  [
    "error-foreground on error-surface",
    [v("background"), v("error-surface")],
    v("error-foreground"),
    4.5,
  ],
  [
    "warning-foreground on warning-surface",
    [v("background"), v("warning-surface")],
    v("warning-foreground"),
    4.5,
  ],
  ...SCHOOLS.flatMap((school) => [
    [`${school} badge`, [v("card"), tint(v(`school-${school}`), 10)], v(`school-${school}`), 4.5],
    [
      `text on a ${school} calendar marker`,
      [v("background"), tint(v(`school-${school}`), 16)],
      v("foreground"),
      4.5,
    ],
    [
      `secondary text on a ${school} calendar marker`,
      [v("background"), tint(v(`school-${school}`), 16)],
      v("secondary-label"),
      4.5,
    ],
  ]),
  ...CRITS.map((n) => [
    `criterion ${n} number`,
    [v("background"), v(`crit-${n}`)],
    v("background"),
    4.5,
  ]),
];

const contrastFailures = (t) =>
  t.eval(`(() => {
    const ratio = (${luminanceOf})();
    return ${JSON.stringify(PAIRS)}.flatMap(([what, surface, ink, min]) => {
      try {
        const got = ratio(surface, ink);
        return got >= min ? [] : [what + " " + got + ":1, needs " + min];
      } catch (error) {
        return [what + ": " + error.message];
      }
    });
  })()`);

const backgroundIs = (t, theme) =>
  t.eval(`(() => {
    const ratio = (${luminanceOf})();
    const side = ratio([${JSON.stringify(v("background"))}], "#000") > ratio([${JSON.stringify(v("background"))}], "#fff") ? "light" : "dark";
    return side === ${JSON.stringify(theme)};
  })()`);

// The page about to reload turns magenta, so the frames it still shows can be told from the new page's.
const OLD_PAGE = `new Promise((painted) => { document.documentElement.replaceChildren(); document.documentElement.style.background = "#f0f"; requestAnimationFrame(() => requestAnimationFrame(painted)); }).then(() => null)`;

const firstFrames = async (t, label, theme) => {
  const frames = [];
  const off = t.on("Page.screencastFrame", ({ data, sessionId }) => {
    frames.push(data);
    void t.cdp("Page.screencastFrameAck", { sessionId });
  });
  await t.eval(OLD_PAGE);
  await t.cdp("Page.startScreencast", {
    format: "png",
    maxWidth: 360,
    maxHeight: 225,
    everyNthFrame: 1,
  });
  for (let waited = 0; frames.length === 0 && waited < 3000; waited += 20) await t.sleep(20);
  await t.reload();
  await t.waitFor(`document.querySelector("#root > *")`, `${label}: the app renders`);
  await t.sleep(300);
  await t.cdp("Page.stopScreencast");
  off();
  const painted = await t.eval(`(${SIDE_OF_FRAMES})(${JSON.stringify(frames)})`);
  t.assert(painted.includes("old"), `${label}: the frames start on the page before the reload`);
  const sides = painted.slice(painted.lastIndexOf("old") + 1);
  t.assert(
    sides.length >= 1 && sides.every((side) => side === theme),
    `${label}: all ${sides.length} frames the new page paints are ${theme}`,
    sides.join(" "),
  );
  t.assert(await backgroundIs(t, theme), `${label}: the page background is ${theme}`);
};

// The build lowers light-dark() to variables that only a stylesheet's color-scheme sets, so the shipped CSS gets its own pass at every OS and choice.
const COMBOS = [
  ["light", null, "light"],
  ["dark", null, "dark"],
  ["dark", "light", "light"],
  ["light", "dark", "dark"],
];

const builtApp = async (t) => {
  // app:// serves the build, so this is the shipped app on its own origin.
  await t.cdp("Page.navigate", { url: APP_URL });
  await t.waitFor(
    `location.href.startsWith(${JSON.stringify(APP_URL)}) && document.readyState === "complete"`,
    "the built app loads",
  );
  for (const [scheme, choice, theme] of COMBOS) {
    const label = `built app, OS ${scheme}, ${choice ?? "no"} choice`;
    await os(t, scheme);
    await t.eval(
      choice
        ? `localStorage.setItem("constellation.theme", ${JSON.stringify(choice)})`
        : `localStorage.removeItem("constellation.theme")`,
    );
    await firstFrames(t, label, theme);
    const failures = await contrastFailures(t);
    t.assert(
      failures.length === 0,
      `${label}: ${PAIRS.length} text and focus-ring pairs clear WCAG AA`,
      failures.join("\n      "),
    );
  }
};

const pickTheme = async (t, label) => {
  await t.click(label, { within: THEME_GROUP });
  await t.waitFor(
    `document.querySelector('${THEME_GROUP} [aria-checked="true"]')?.innerText === ${JSON.stringify(label)}`,
    `Settings marks ${label} as the theme`,
  );
};

const tour = async (t, name, theme) => {
  for (const [width, height] of SIZES) {
    await t.viewport(width, height);
    await t.sleep(200);
    await t.shot(`${name}-${theme}-${width}`);
  }
  await t.viewport(1440, 900);
};

const inBothThemes = async (t, name) => {
  for (const theme of THEMES) {
    await os(t, theme);
    await tour(t, name, theme);
  }
};

export const run = async (t) => {
  await t.viewport(1440, 900);
  await builtApp(t);
  await os(t, "light");
  await t.goto("/welcome");
  await t.eval(`sessionStorage.setItem("verify.noise", ${JSON.stringify(QUIET)})`);
  await firstFrames(t, "OS light, no choice", "light");
  await os(t, "dark");
  await firstFrames(t, "OS dark, no choice", "dark");

  await t.waitText("Set up");
  await t.click("Set up");
  await t.click("Use demo institutions and tokens");
  await t.waitFor(
    `document.querySelectorAll("[data-host]").length > 0`,
    "the demo schools fill in",
  );
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
  await inBothThemes(t, "setup");
  await t.click(`input[name="ai-source"][value="none"]`);
  await t.click("Finish setup");
  await t.waitFor(`location.pathname === "/due"`, "setup lands on What's due");
  await inBothThemes(t, "whats-due");

  await addAiKey(t);
  await inBothThemes(t, "grading-list");
  await t.click("Maya Ortiz", { within: '[data-testid="queue-list"]' });
  await t.waitFor(
    `document.querySelector("[data-focused]")?.innerText.includes("Maya Ortiz, Essay 2") && !document.querySelector('[data-testid="agent-working"]')`,
    "Maya's draft is ready",
    30_000,
  );
  await inBothThemes(t, "grading-draft");

  await t.click("Calendar", { within: SIDEBAR });
  await t.waitFor(`document.querySelector('[data-testid="calendar-grid"]')`, "the Calendar opens");
  await inBothThemes(t, "calendar");

  await t.click("Settings", { within: SIDEBAR });
  await t.click("Appearance", { within: NAV });
  await t.waitFor(
    `document.querySelector(${JSON.stringify(THEME_GROUP)})`,
    "Appearance shows the theme choice",
  );
  t.assert(
    (await t.text(`${THEME_GROUP} [aria-checked="true"]`)) === "System",
    "the theme starts on System",
  );
  await inBothThemes(t, "settings-appearance");
  await t.eval(`document.querySelector('${THEME_GROUP} [aria-checked="true"]').focus()`);
  await t.key("ArrowRight");
  t.assert(
    (await t.eval(
      `document.activeElement.getAttribute("aria-checked") === "true" && document.activeElement.innerText`,
    )) === "Light",
    "ArrowRight moves the theme choice and focus from System to Light",
  );
  await t.key("ArrowLeft");
  await t.key("ArrowLeft");
  t.assert(
    (await t.text(`${THEME_GROUP} [aria-checked="true"]`)) === "Dark",
    "ArrowLeft wraps the theme choice from System to Dark",
  );
  await pickTheme(t, "System");
  await t.viewport(1280, 720);
  t.assert(
    await t.eval(
      `(() => { const pinned = document.querySelector('${SIDEBAR} [data-testid="sidebar-list"]').previousElementSibling; return parseFloat(getComputedStyle(pinned).borderBottomWidth) > 0; })()`,
    ),
    "a divider separates the pinned nav from the scrolling rail at 1280x720",
  );
  await t.viewport(1440, 900);

  await os(t, "dark");
  await pickTheme(t, "Light");
  t.assert(await backgroundIs(t, "light"), "Light overrides a dark OS");
  await firstFrames(t, "Light chosen, OS dark", "light");
  await os(t, "light");
  await pickTheme(t, "Dark");
  t.assert(await backgroundIs(t, "dark"), "Dark overrides a light OS");
  await firstFrames(t, "Dark chosen, OS light", "dark");
  await pickTheme(t, "System");
  t.assert(await backgroundIs(t, "light"), "System goes back to the light OS");
  await os(t, "dark");
  t.assert(await backgroundIs(t, "dark"), "System follows the OS when it changes, with no reload");
  await firstFrames(t, "System chosen, OS dark", "dark");
  await t.click("Light", { within: THEME_GROUP });
  await t.reload();
  await t.waitFor(`document.querySelector(${JSON.stringify(THEME_GROUP)})`, "Settings reloads");
  t.assert(
    (await t.text(`${THEME_GROUP} [aria-checked="true"]`)) === "Light",
    "the chosen theme stays through a reload",
  );
  await os(t, "dark");
};
