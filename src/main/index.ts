import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  shell,
} from "electron";
import electronUpdater from "electron-updater";

import { FAKES_SWITCH, errorReport, handle, type Handlers } from "../shared/ipc";

import {
  APP_SCHEME,
  APP_URL,
  CSP,
  appFile,
  lockNavigation,
  trustedSender,
  windowOptions,
} from "./security";
import { createFileStorage, fakeServer, lmsHandlers } from "./lms";
import { anthropicAgent } from "./providers/anthropic";
import { claudeCodeAgent } from "./providers/claude-code";
import { jsonFile } from "./json-file";
import { TelemetrySavedSchema, createTelemetry } from "./telemetry";
import { startUpdates } from "./updates";
import { createVault } from "./vault";

const RENDERER_DIR = fileURLToPath(new URL("../dist", import.meta.url));
/** The folder holding `out/`: the repo, or the packaged app's `app.asar`. */
const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PRELOAD = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
/** Set by `npm run dev` to its vite server. A packaged app always loads its bundled files. */
const DEV_URL = app.isPackaged ? undefined : process.env.CONSTELLATION_DEV_URL;
/** Set by `npm run verify`, which drives the window over CDP. A window that is never shown still paints, and nothing can cover it. */
const HIDDEN = !app.isPackaged && process.env.CONSTELLATION_WINDOW === "hidden";
/** The one origin besides `app://` that main answers IPC from: `npm run dev`'s server, or the vite server verify moves the window to after the app loads. */
const DEV_ORIGIN = app.isPackaged
  ? undefined
  : (DEV_URL ?? process.env.CONSTELLATION_VERIFY_ORIGIN);
/** Set by `npm run verify`: only the fake LMS's schools and the rules agent, so a run never reaches Canvas or Anthropic. */
const FAKE_ONLY = !app.isPackaged && process.env.CONSTELLATION_LMS === "fake";
/**
 * Set by verify, and by a walker driving the app over CDP: a file holding the path "Choose a .imscc file" answers in
 * place of the native dialog, which CDP can't reach. An empty or missing file is a cancel. A packaged app never reads it.
 */
const PICKED_PACKAGE_FILE = app.isPackaged ? undefined : process.env.CONSTELLATION_PICKED_PACKAGE;
/** Set by verify to a fake `claude`, so a run never reaches the teacher's own. A packaged app never reads it. */
const CLAUDE_OVERRIDE = app.isPackaged ? undefined : process.env.CONSTELLATION_CLAUDE;
/**
 * Set by verify: a file each telemetry batch is appended to, one JSON line each, in place of PostHog. Without it an
 * unpackaged app sends nothing. A packaged app never reads it.
 */
const TELEMETRY_SINK = app.isPackaged ? undefined : process.env.CONSTELLATION_TELEMETRY_SINK;
const AI_OFF = {
  ok: false,
  reason: "AI drafts are off. Choose an AI source in Settings to turn them on.",
} as const;
/** Only the unpackaged app takes CDP. A packaged app quits before it opens a window (`npm run smoke:packaged`). */
/**
 * Baked in by `CONSTELLATION_UPDATES=on npm run build`, which only the release workflow runs. Every other build bakes
 * in `false`, so an unsigned build (`npm run smoke:packaged`, a local package) never checks.
 */
const UPDATES = app.isPackaged && process.env.CONSTELLATION_UPDATES === "on";
const DEBUGGER_ASKED =
  app.isPackaged &&
  ["remote-debugging-port", "remote-debugging-pipe"].some((name) =>
    app.commandLine.hasSwitch(name),
  );

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const serve = async (request: Request): Promise<Response> => {
  const file = appFile(RENDERER_DIR, request.url);
  if (!file) return new Response(null, { status: 404 });
  try {
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", CSP);
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
};

const start = async () => {
  await app.whenReady();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  protocol.handle(APP_SCHEME, serve);
  const userData = app.getPath("userData");
  const telemetry = createTelemetry({
    // Both are baked in by `vp pack` from the build's environment (vite.config.ts). A build without a key sends
    // nothing; verify's sink takes any key, since nothing it writes reaches PostHog.
    key: TELEMETRY_SINK ? "sink" : (process.env.CONSTELLATION_POSTHOG_KEY ?? ""),
    host: process.env.CONSTELLATION_POSTHOG_HOST || "https://us.i.posthog.com",
    appRoot: APP_ROOT,
    env: process.env.CONSTELLATION_TELEMETRY_ENABLED,
    offline: !app.isPackaged && TELEMETRY_SINK === undefined,
    saved: jsonFile(join(userData, "telemetry.json"), TelemetrySavedSchema, { enabled: true }),
    appVersion: app.getVersion(),
    os: `${process.platform} ${process.arch}`,
    osVersion: process.getSystemVersion(),
    flushMs: TELEMETRY_SINK ? 500 : 10_000,
    send: TELEMETRY_SINK
      ? async (_url, body) => {
          await appendFile(TELEMETRY_SINK, `${body}\n`);
          return 200;
        }
      : async (url, body) =>
          (
            await net.fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            })
          ).status,
  });
  telemetry.track({ event: "app_opened" });
  app.on("before-quit", () => void telemetry.flush());
  const reportMain = (error: unknown) => {
    void telemetry.report(errorReport(error), "main");
  };
  // A monitor leaves an uncaught error's crash as it was. A rejection listener silences Electron's warning, so it warns.
  process.on("uncaughtExceptionMonitor", reportMain);
  process.on("unhandledRejection", (reason) => {
    process.emitWarning(
      reason instanceof Error ? (reason.stack ?? String(reason)) : String(reason),
      "UnhandledPromiseRejectionWarning",
    );
    reportMain(reason);
  });
  const vault = createVault(join(userData, "vault.json"), safeStorage);
  const keyAgent = anthropicAgent({
    lease: vault.lease("ai-key"),
    fetch: (url, init) => net.fetch(url, init),
  });
  const claudeCode = claudeCodeAgent(
    CLAUDE_OVERRIDE ? { locate: async () => CLAUDE_OVERRIDE } : {},
  );
  app.on("will-quit", claudeCode.stop);
  /** The teacher's choice, told by the renderer on load and on every change. Never a fallback from one to the other. */
  let source: Parameters<Handlers["agent.source"]>[0]["source"] = "none";
  const runAgent: Handlers["agent.run"] = async (input) => {
    switch (source) {
      case "none":
        return AI_OFF;
      case "key":
        return keyAgent(input);
      case "claude-code":
        return claudeCode.run(input);
    }
  };
  /** The teacher's last click, Return or Space in the window, as the OS delivered it. Page script can't produce one. */
  let pressedAt = Number.NEGATIVE_INFINITY;
  const lms = lmsHandlers({
    lms: FAKE_ONLY
      ? { kind: "fake", makeServer: fakeServer(createFileStorage(join(userData, "lms.json"))) }
      : { kind: "canvas", fetch: (url, init) => net.fetch(url, init) },
    realNow: () => Date.now(),
    leaseFor: (key) => vault.lease(key),
    pressedAt: () => pressedAt,
    // Main reads the file itself, so the renderer never names a path.
    choosePackage: async () => {
      if (PICKED_PACKAGE_FILE)
        return (await readFile(PICKED_PACKAGE_FILE, "utf8").catch(() => "")).trim() || null;
      const { canceled, filePaths } = await dialog.showOpenDialog(window, {
        title: "Choose a course export",
        properties: ["openFile"],
        filters: [{ name: "Common Cartridge", extensions: ["imscc"] }],
      });
      return canceled ? null : (filePaths[0] ?? null);
    },
  });
  handle(
    (channel, listener) =>
      ipcMain.handle(channel, (event, input) => listener(event.senderFrame?.url ?? null, input)),
    trustedSender(DEV_ORIGIN),
    {
      "analytics.track": async (event) => telemetry.track(event),
      "error.report": (report) => telemetry.report(report, "renderer"),
      "telemetry.status": async () => telemetry.status(),
      "telemetry.choose": async ({ enabled }) => telemetry.choose(enabled),
      "vault.enroll": ({ key, token }) => vault.enroll(key, token),
      "vault.keys": async () => vault.keys(),
      "vault.forget": async ({ key }) => vault.forget(key),
      "vault.standIn": ({ key }) => vault.standIn(key),
      "agent.run": FAKE_ONLY
        ? async () => ({ ok: false, reason: "This run drafts with the rules agent." })
        : runAgent,
      "agent.source": async (input) => {
        source = input.source;
      },
      "claudeCode.status": () => claudeCode.status(),
      ...lms,
    },
  );
  const window = new BrowserWindow({
    ...windowOptions(PRELOAD, FAKE_ONLY ? [FAKES_SWITCH] : []),
    show: !HIDDEN,
  });
  lockNavigation(window.webContents, (url) => void shell.openExternal(url));
  window.webContents.on("input-event", (_event, input) => {
    if (input.type === "mouseUp") pressedAt = Date.now();
  });
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && (input.key === "Enter" || input.key === " "))
      pressedAt = Date.now();
  });
  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  await window.loadURL(DEV_URL ?? APP_URL);
  // "Later" is the default, so a Return meant for the app can't restart it.
  if (UPDATES)
    startUpdates(electronUpdater.autoUpdater, async (version) => {
      const { response } = await dialog.showMessageBox(window, {
        type: "info",
        message: `Constellation ${version} is ready`,
        detail: "It installs when you quit. Restart now to use it sooner.",
        buttons: ["Restart Now", "Later"],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    });
};

if (DEBUGGER_ASKED) app.exit(1);
else if (app.requestSingleInstanceLock()) void start();
else app.quit();
