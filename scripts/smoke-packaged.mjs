import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

import { REFUSED_ENV, REFUSED_SWITCHES } from "../src/main/security.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP =
  process.argv[2] ??
  join(ROOT, "out/release", process.arch === "arm64" ? "mac-arm64" : "mac", "Constellation.app");
const BINARY = join(APP, "Contents/MacOS/Constellation");
const WAIT_MS = 30_000;
const STORE_KEY = "_app://constellation\u0000\u0001lms-app.v1";

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

const launch = async (args, extraEnv = {}) => {
  const userData = await mkdtemp(join(tmpdir(), "constellation-smoke-"));
  const env = { ...process.env, CONSTELLATION_TELEMETRY_ENABLED: "false", ...extraEnv };
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

const BUILT_IN_THREADS = ["t-north-star", "t-queue", "t-inbox"];

const storeLog = async (userData) => {
  const folder = join(userData, "Local Storage/leveldb");
  const files = await readdir(folder).catch(() => []);
  const logs = files.filter((name) => name.endsWith(".log"));
  return Buffer.concat(
    await Promise.all(
      logs.map((file) => readFile(join(folder, file)).catch(() => Buffer.alloc(0))),
    ),
  );
};

const storeWritten = async (userData) => (await storeLog(userData)).includes(STORE_KEY);

const inStore = (bytes, text) =>
  bytes.includes(Buffer.from(text, "latin1")) || bytes.includes(Buffer.from(text, "utf16le"));

const checkFuses = async () => {
  const wire = await getCurrentFuseWire(BINARY);
  const wrong = Object.entries(FUSES).filter(
    ([name, on]) => wire[FuseV1Options[name]] !== (on ? FuseState.ENABLE : FuseState.DISABLE),
  );
  if (wrong.length) throw new Error(`fuses differ from FUSES: ${wrong.map(([n]) => n)}`);
  console.log(`ok fuses: ${Object.entries(FUSES).map(([n, on]) => `${n}=${on}`)}`);
};

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
    const log = await storeLog(app.userData);
    if (!inStore(log, '"threads":')) throw new Error("the saved store has no threads to check");
    if (inStore(log, '"seeded":true'))
      throw new Error("the packaged app saved a seeded demo thread");
    const missing = BUILT_IN_THREADS.filter((id) => !inStore(log, `"id":"${id}"`));
    if (missing.length > 0)
      throw new Error(
        `the packaged app's first store has no built-in thread ${missing.join(", ")}`,
      );
    console.log(
      "ok no demo: the packaged app's first store holds North Star, the grading list and Messages, and no seeded demo thread",
    );
    console.log(`ok --inspect=${port}: ignored, nothing listens`);
  } finally {
    await app.stop();
  }
};

const checkRefused = async (args, env, what) => {
  const port = await freePort();
  const app = await launch(
    args.map((arg) => `${arg}=${port}`),
    env,
  );
  try {
    const deadline = Date.now() + WAIT_MS;
    while (app.running()) {
      if (await answers(port)) throw new Error(`${what} opened port ${port}`);
      if (Date.now() > deadline) throw new Error(`app kept running with ${what}`);
      await sleep(50);
    }
    const code = await app.exited;
    if (code !== 1) throw new Error(`app exited with ${code}, not 1, on ${what}`);
    if (await storeWritten(app.userData)) throw new Error(`app loaded its window on ${what}`);
    console.log(`ok ${what}: quit with 1 before any window, port ${port} never answered`);
  } finally {
    await app.stop();
  }
};

console.log(`smoke: ${APP}`);
await checkFuses();
await checkWindowAndInspect();
for (const name of REFUSED_SWITCHES) await checkRefused([`--${name}`], {}, `--${name}`);
for (const name of REFUSED_ENV) await checkRefused([], { [name]: join(tmpdir(), "refused") }, name);
