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

import { handle } from "../shared/ipc";

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
import { createVault } from "./vault";

const RENDERER_DIR = fileURLToPath(new URL("../dist", import.meta.url));
const PRELOAD = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
/** Set by `npm run dev` to its vite server. A packaged app always loads its bundled files. */
const DEV_URL = app.isPackaged ? undefined : process.env.CONSTELLATION_DEV_URL;
/** Set by `npm run verify`, which drives the window over CDP. A window that is never shown still paints, and nothing can cover it. */
const HIDDEN = !app.isPackaged && process.env.CONSTELLATION_WINDOW === "hidden";
/** The one origin besides `app://` that main answers IPC from: `npm run dev`'s server, or the vite server verify moves the window to after the app loads. */
const DEV_ORIGIN = app.isPackaged
  ? undefined
  : (DEV_URL ?? process.env.CONSTELLATION_VERIFY_ORIGIN);
/** Set by `npm run verify`: only the fake LMS's schools, so a run never reaches a real Canvas host. */
const FAKE_ONLY = !app.isPackaged && process.env.CONSTELLATION_LMS === "fake";
/** Only the unpackaged app takes CDP. A packaged app quits before it opens a window (`npm run smoke:packaged`). */
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
  const vault = createVault(join(userData, "vault.json"), safeStorage);
  const lms = lmsHandlers({
    makeServer: fakeServer(createFileStorage(join(userData, "lms.json"))),
    realNow: () => Date.now(),
    leaseFor: (key) => vault.lease(key),
    packaged: app.isPackaged,
    fetch: FAKE_ONLY ? null : (url, init) => net.fetch(url, init),
    // "Don't Send" is the default, so a dialog the renderer times to land mid-typing can't take a Return as a yes.
    confirmSend: async ({ host, target, lines }) => {
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        message: `Send to ${target} on ${host}?`,
        detail: lines.join("\n\n"),
        buttons: ["Send", "Don't Send"],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    },
    // Main reads the file itself, so the renderer never names a path.
    choosePackage: async () => {
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
      // Error tracking (step 9) sends these on; until then main accepts a well-formed report and drops it.
      "error.report": async () => {},
      "vault.enroll": ({ key, token }) => vault.enroll(key, token),
      "vault.keys": async () => vault.keys(),
      "vault.forget": async ({ key }) => vault.forget(key),
      "vault.standIn": ({ key }) => vault.standIn(key),
      ...lms,
    },
  );
  const window = new BrowserWindow({ ...windowOptions(PRELOAD), show: !HIDDEN });
  lockNavigation(window.webContents, (url) => void shell.openExternal(url));
  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  await window.loadURL(DEV_URL ?? APP_URL);
};

if (DEBUGGER_ASKED) app.exit(1);
else if (app.requestSingleInstanceLock()) void start();
else app.quit();
