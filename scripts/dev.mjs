// `npm run dev`: vite in this process, then Electron against it. A change under src/main, src/preload or src/shared
// rebuilds main and preload and restarts Electron; the renderer reloads through vite. `npm run dev:web` is the web app alone.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";
import { build } from "vite/pack";

import config from "../vite.config.ts";
import { startDevServer } from "./dev-server.mjs";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const MAIN_SIDE = /^(main|preload|shared)\//;

const pack = () =>
  Promise.all(
    [config.pack ?? []].flat().map((entry) => build({ ...entry, config: false, logLevel: "warn" })),
  );

const running = (child) => child.exitCode === null && child.signalCode === null;

const server = await startDevServer();
let app = null;
let pending;

const quit = async () => {
  clearTimeout(pending);
  if (app && running(app)) app.kill();
  await server.close();
  process.exit(0);
};

const launch = () => {
  const child = spawn(electron, ["."], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CONSTELLATION_DEV_URL: server.origin },
  });
  app = child;
  // Quitting the app ends the session. A restart swaps `app` out first, so its exit doesn't.
  child.once("exit", () => {
    if (app === child) void quit();
  });
};

const restart = async () => {
  try {
    await pack();
  } catch (error) {
    console.error(error);
    return;
  }
  const old = app;
  app = null;
  if (old && running(old)) {
    const exited = once(old, "exit");
    old.kill();
    await exited;
  }
  launch();
};

await pack();
launch();
// vite already watches the project, so main and preload ride on its watcher.
server.watcher.on("all", (_event, path) => {
  if (!MAIN_SIDE.test(relative(SRC, path))) return;
  clearTimeout(pending);
  pending = setTimeout(() => void restart(), 100);
});

process.once("SIGINT", () => void quit());
// vite exits this process itself on SIGTERM, skipping `quit`. Electron goes with it.
process.once("exit", () => app?.kill());
