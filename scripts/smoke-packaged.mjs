// Boots the packaged app and checks what only a packaged build can show: its fuses, that its window runs the
// app from app://, and that it lets no debugger in. Takes the .app path, or finds this Mac's `electron-builder --dir`
// output. A packaged app takes no CDP, so the window check reads the renderer's store from a scratch user-data
// folder. Starts its own app processes, and stops only those.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP =
  process.argv[2] ??
  join(ROOT, "out/release", process.arch === "arm64" ? "mac-arm64" : "mac", "Constellation.app");
const BINARY = join(APP, "Contents/MacOS/Constellation");
const WAIT_MS = 30_000;
/** The key the workspace store writes, under the app's own origin, in Chromium's localStorage log. */
const STORE_KEY = "_app://constellation\u0000\u0001lms-app.v1";

/** docs/electron-spec.md, "Security baseline", plus cookie encryption and no file:// privileges. */
const FUSES = {
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  EnableCookieEncryption: true,
  GrantFileProtocolExtraPrivileges: false,
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
    server.on("error", fail);
  });

const answers = async (port) => {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
};

/** Launches the app with its own user-data folder, so it never reads or locks a real install's data or Keychain item. */
const launch = async (args) => {
  const userData = await mkdtemp(join(tmpdir(), "constellation-smoke-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(BINARY, [`--user-data-dir=${userData}`, "--use-mock-keychain", ...args], {
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = new Promise((done) => child.on("exit", (code, signal) => done(code ?? signal)));
  let running = true;
  void exited.then(() => (running = false));
  const stop = async () => {
    if (running) child.kill();
    await exited;
    await rm(userData, { recursive: true, force: true });
  };
  return { userData, exited, running: () => running, stop };
};

const storeWritten = async (userData) => {
  const folder = join(userData, "Local Storage/leveldb");
  const files = await readdir(folder).catch(() => []);
  for (const file of files.filter((name) => name.endsWith(".log"))) {
    const bytes = await readFile(join(folder, file)).catch(() => Buffer.alloc(0));
    if (bytes.includes(STORE_KEY)) return true;
  }
  return false;
};

const checkFuses = async () => {
  const wire = await getCurrentFuseWire(BINARY);
  const wrong = Object.entries(FUSES).filter(
    ([name, on]) => wire[FuseV1Options[name]] !== (on ? FuseState.ENABLE : FuseState.DISABLE),
  );
  if (wrong.length) throw new Error(`fuses not as the spec sets them: ${wrong.map(([n]) => n)}`);
  console.log(`ok fuses: ${Object.entries(FUSES).map(([n, on]) => `${n}=${on}`)}`);
};

/** A normal launch, with `--inspect` that the fuse must ignore: the window runs the app, and no inspector listens. */
const checkWindowAndInspect = async () => {
  const port = await freePort();
  const app = await launch([`--inspect=${port}`]);
  try {
    const deadline = Date.now() + WAIT_MS;
    while (!(await storeWritten(app.userData))) {
      if (!app.running())
        throw new Error(`app exited (${await app.exited}) before its window loaded`);
      if (await answers(port)) throw new Error(`--inspect opened port ${port}`);
      if (Date.now() > deadline) throw new Error("the window never wrote its store from app://");
      await sleep(100);
    }
    if (await answers(port)) throw new Error(`--inspect opened port ${port}`);
    console.log("ok window: the renderer ran from app://constellation and wrote its store");
    console.log(`ok --inspect=${port}: ignored, nothing listens`);
  } finally {
    await app.stop();
  }
};

const checkRemoteDebugging = async () => {
  const port = await freePort();
  const app = await launch([`--remote-debugging-port=${port}`]);
  try {
    const deadline = Date.now() + WAIT_MS;
    while (app.running()) {
      if (await answers(port)) throw new Error(`--remote-debugging-port opened port ${port}`);
      if (Date.now() > deadline) throw new Error("app kept running with --remote-debugging-port");
      await sleep(50);
    }
    const code = await app.exited;
    if (code !== 1) throw new Error(`app exited with ${code}, not 1, on --remote-debugging-port`);
    if (await storeWritten(app.userData)) throw new Error("app loaded its window before quitting");
    console.log(
      `ok --remote-debugging-port=${port}: quit with 1 before any window, port never answered`,
    );
  } finally {
    await app.stop();
  }
};

console.log(`smoke: ${APP}`);
await checkFuses();
await checkWindowAndInspect();
await checkRemoteDebugging();
