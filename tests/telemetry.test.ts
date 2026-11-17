import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import * as v from "valibot";

import { createTelemetry, type TelemetryOptions } from "../src/main/telemetry";
import { errorReport } from "../src/shared/ipc";

/** An app's folder with a built bundle in it: the only files a frame may name. */
const APP_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "constellation-app-")));
for (const file of ["out/dist/assets/index-Ab12.js", "out/main/index.mjs"]) {
  mkdirSync(dirname(join(APP_ROOT, file)), { recursive: true });
  writeFileSync(join(APP_ROOT, file), "");
}

/** Student data, planted wherever an error can carry it, as plain identifiers too. None of it may reach PostHog. */
const STUDENT = {
  name: "Maria Garcia",
  identifier: "MayaLopez",
  snake: "Maya_Lopez",
  long: `Student${"x".repeat(93)}`,
  login: "mgarcia",
  email: "maria.garcia@lakeshore.edu",
  grade: "B+ 87/100",
  token: "7~AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  course: "https://lakeshore.instructure.com/courses/4821/assignments/77",
  home: "/Users/mgarcia/",
};
const PLANTED = Object.values(STUDENT);

type Saved = ReturnType<TelemetryOptions["saved"]["read"]>;

/**
 * Telemetry over an in-memory `telemetry.json`. Each POST takes the next of `answers`, a status or a thrown network
 * error, then 200 once they run out. The timer never fires in a test, so only a full queue or `flush` sends.
 */
const rig = (overrides: Partial<TelemetryOptions> = {}, answers: (number | Error)[] = []) => {
  const sent: { url: string; body: string }[] = [];
  let saved: Saved = { enabled: true };
  const telemetry = createTelemetry({
    key: "phc_test",
    host: "https://eu.i.posthog.com/",
    appRoot: APP_ROOT,
    env: undefined,
    offline: false,
    saved: { read: () => saved, write: (next) => (saved = next) },
    appVersion: "0.0.1-alpha.1",
    os: "darwin arm64",
    osVersion: "15.1",
    flushMs: 3_600_000,
    send: async (url, body) => {
      sent.push({ url, body });
      const answer = answers.shift() ?? 200;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    ...overrides,
  });
  /** Every event PostHog was handed, batch by batch, retries included. */
  const events = () => sent.flatMap((request) => batchOf(request));
  return { telemetry, sent, events, saved: () => saved };
};

const expectNoStudentData = (body: string) => {
  for (const value of PLANTED) expect(body).not.toContain(value);
  for (const word of ["Maria", "Garcia", "Maya", "Lopez", "mgarcia", "lakeshore", "AbCdEf", "xxxx"])
    expect(body).not.toContain(word);
  expect(body).not.toContain(process.cwd());
  expect(body).not.toContain("/Users/");
};

/** A real thrown error whose message, name and function name all carry student data. */
const studentError = (functionName: string, errorName = "TypeError") => {
  const handlers = {
    [functionName]: () => {
      throw Object.assign(
        new TypeError(
          `Cannot grade ${STUDENT.name} <${STUDENT.email}>: ${STUDENT.grade} at ${STUDENT.course}?access_token=${STUDENT.token}\n` +
            `    at ${STUDENT.login} (${STUDENT.home}grades.js:1:1)\n` +
            `    at gradeFor (${STUDENT.home}Desktop/out/main/${STUDENT.login}.mjs:2:2)`,
        ),
        { name: errorName },
      );
    },
  };
  try {
    handlers[functionName]?.();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

/** A renderer stack, with student data in every place it can hide, in the app's own files and outside them. */
const RENDERER_STACK = [
  `TypeError: ${STUDENT.name} has no grade`,
  `    at ${STUDENT.email} (app://constellation/assets/index-Ab12.js:3:40)`,
  `    at ${STUDENT.snake} (app://constellation/assets/index-Ab12.js?token=${STUDENT.token}:5:6)`,
  `    at ${STUDENT.long} (app://constellation/assets/index-Ab12.js:10:20)`,
  `    at render (app://constellation/assets/${STUDENT.identifier}.js:4:4)`,
  `    at render (app://constellation/assets/${STUDENT.long}.js:4:4)`,
  `    at async load (http://localhost:4320/src/renderer/${STUDENT.identifier}.ts:7:8)`,
  `    at gradebook (${STUDENT.course}:1:1)`,
  `    at readRoster (file://${STUDENT.home}Library/Caches/roster-${STUDENT.login}.js:1:1)`,
  `    at Module.run (/Applications/${STUDENT.identifier}/app.asar/out/main/index.mjs:40:2)`,
  `    at Module.run (${pathToFileURL(join(APP_ROOT, "out/main/index.mjs")).href}:41:3)`,
  `    at Module.run (${APP_ROOT}/out/main/../../${STUDENT.identifier}.mjs:1:1)`,
  `    at Module.run (${APP_ROOT}/out/main/index.mjs:99999999:1)`,
  `    at process.processTicksAndRejections (node:internal/${STUDENT.identifier}:105:5)`,
  `${STUDENT.grade} and ${STUDENT.home}`,
].join("\n");

const BatchSchema = v.strictObject({
  api_key: v.string(),
  batch: v.array(
    v.strictObject({
      uuid: v.pipe(v.string(), v.uuid()),
      event: v.string(),
      timestamp: v.pipe(v.string(), v.isoTimestamp()),
      distinct_id: v.string(),
      properties: v.record(v.string(), v.unknown()),
    }),
  ),
});
const batchOf = (request: { body: string } | undefined) =>
  v.parse(BatchSchema, JSON.parse(request?.body ?? "")).batch;
const bodyOf = (request: { body: string } | undefined): unknown => batchOf(request)[0];

describe("a crash report", () => {
  it("carries no student data from a main error's message, name or function name", async () => {
    for (const name of [STUDENT.identifier, STUDENT.snake, STUDENT.long]) {
      const { telemetry, sent } = rig();
      const { type, stack } = errorReport(studentError(name, name));
      expect(stack).toContain(" at ");
      await telemetry.report({ type, stack }, "main");
      expect(sent).toHaveLength(1);
      expectNoStudentData(sent[0]?.body ?? "");
    }
  });

  it("carries no student data from a renderer's stack or type, whatever it sends", async () => {
    const { telemetry, sent } = rig();
    for (const type of ["TypeError", STUDENT.identifier, STUDENT.snake, STUDENT.long])
      await telemetry.report({ type, stack: RENDERER_STACK }, "renderer");
    expect(sent).toHaveLength(4);
    for (const { body } of sent) expectNoStudentData(body);
  });

  it("names only JavaScript's own error types", async () => {
    const { telemetry, sent } = rig();
    for (const type of ["RangeError", "MayaLopez", "Error"])
      await telemetry.report({ type, stack: "" }, "main");
    expect(sent.map((request) => bodyOf(request))).toMatchObject(
      ["RangeError", "Error", "Error"].map((type) => ({
        properties: { $exception_list: [{ type }] },
      })),
    );
  });

  it("keeps the type, the app's own files and positions oldest first, the version and the OS", async () => {
    const { telemetry, sent } = rig();
    await telemetry.report({ type: "TypeError", stack: RENDERER_STACK }, "renderer");
    const request = sent[0];
    expect(request?.url).toBe("https://eu.i.posthog.com/batch/");
    expect(JSON.parse(request?.body ?? "")).toMatchObject({ api_key: "phc_test" });
    const body = bodyOf(request);
    expect(body).toMatchObject({
      event: "$exception",
      properties: {
        $exception_list: [{ type: "TypeError", value: "(message withheld)" }],
        $process_person_profile: false,
        $geoip_disable: true,
        source: "renderer",
        app_version: "0.0.1-alpha.1",
        os: "darwin arm64",
        os_version: "15.1",
      },
    });
    const frames = (
      body as { properties: { $exception_list: { stacktrace: { frames: unknown } }[] } }
    ).properties.$exception_list[0]?.stacktrace.frames;
    const own = (filename: string, lineno: number, colno: number) => ({
      platform: "web:javascript",
      function: "<withheld>",
      filename,
      lineno,
      colno,
      in_app: true,
    });
    const withheld = {
      platform: "web:javascript",
      function: "<withheld>",
      filename: "<withheld>",
      in_app: false,
    };
    expect(frames).toEqual(
      [
        own("out/dist/assets/index-Ab12.js", 3, 40),
        own("out/dist/assets/index-Ab12.js", 5, 6),
        own("out/dist/assets/index-Ab12.js", 10, 20),
        withheld,
        withheld,
        withheld,
        withheld,
        withheld,
        withheld,
        own("out/main/index.mjs", 41, 3),
        withheld,
        withheld,
      ].reverse(),
    );
  });

  it("drops a message line that reads like a frame", () => {
    const { stack } = errorReport(studentError("grade"));
    expect(stack).not.toContain(STUDENT.login);
    expect(stack).toMatch(/^\n\s+at /);
  });

  it("is bounded before it crosses to main", () => {
    const error = new Error("x");
    error.name = "N".repeat(500);
    error.stack = `${String(error)}${"\n    at f (app://constellation/a.js:1:1)".repeat(5000)}`;
    const { type, stack } = errorReport(error);
    expect(type).toHaveLength(64);
    expect(stack.split("\n").length).toBeLessThanOrEqual(51);
  });
});

describe("crash reports are sent", () => {
  it("only when the build has a key, the env allows it, the launch isn't offline, and the teacher hasn't opted out", async () => {
    for (const overrides of [
      { key: "" },
      { env: "false" },
      { env: " FALSE " },
      { offline: true },
    ] satisfies Partial<TelemetryOptions>[]) {
      const { telemetry, sent, saved } = rig(overrides);
      expect(telemetry.status().available).toBe(false);
      await telemetry.report({ type: "TypeError", stack: RENDERER_STACK }, "renderer");
      telemetry.track({ event: "app_opened" });
      await telemetry.flush();
      expect(sent).toEqual([]);
      expect(saved().installId).toBeUndefined();
    }
    const { telemetry, sent } = rig({ env: "true" });
    expect(telemetry.status()).toEqual({ enabled: true, available: true });
    telemetry.choose(false);
    expect(telemetry.status().enabled).toBe(false);
    await telemetry.report({ type: "TypeError", stack: RENDERER_STACK }, "renderer");
    expect(sent).toEqual([]);
    telemetry.choose(true);
    await telemetry.report({ type: "TypeError", stack: RENDERER_STACK }, "renderer");
    expect(sent).toHaveLength(1);
  });

  it("at most 25 times a launch, and a failed send never throws", async () => {
    const { telemetry, events } = rig();
    for (let i = 0; i < 30; i += 1)
      await telemetry.report({ type: "TypeError", stack: "" }, "main");
    expect(events()).toHaveLength(25);
    const failing = rig({ send: async () => Promise.reject(new Error("offline")) });
    await expect(
      failing.telemetry.report({ type: "TypeError", stack: "" }, "main"),
    ).resolves.toBeUndefined();
  });
});

const opened = { event: "app_opened" } as const;

describe("usage events", () => {
  it("each carry their own uuid, this Mac's random id, the app version and no person or location", async () => {
    const { telemetry, sent, events, saved } = rig();
    telemetry.track({ event: "draft_requested", kind: "grade" });
    await telemetry.report({ type: "TypeError", stack: "" }, "main");
    const [draft, crash] = events();
    expect(sent).toHaveLength(1);
    expect(draft).toEqual({
      uuid: expect.any(String),
      event: "draft_requested",
      timestamp: expect.any(String),
      distinct_id: saved().installId,
      properties: {
        kind: "grade",
        $lib: "constellation-desktop",
        $lib_version: "0.0.1-alpha.1",
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
    expect(crash?.distinct_id).toBe(saved().installId);
    expect(crash?.uuid).not.toBe(draft?.uuid);
  });

  it("go in one POST once 20 wait, and the queue holds at most 200 while PostHog is down", async () => {
    const { telemetry, sent, events } = rig({}, [503]);
    for (let i = 0; i < 19; i += 1) telemetry.track(opened);
    expect(sent).toEqual([]);
    for (let i = 0; i < 231; i += 1) telemetry.track(opened);
    expect(sent).toHaveLength(1);
    await telemetry.flush();
    await telemetry.flush();
    expect(sent).toHaveLength(2);
    expect(batchOf(sent[0])).toHaveLength(20);
    expect(batchOf(sent[1])).toHaveLength(200);
    expect(batchOf(sent[1]).slice(0, 20)).toEqual(batchOf(sent[0]));
    expect(new Set(events().map((event) => event.uuid)).size).toBe(200);
  });

  it("are sent again with the same uuids after a 429, a 5xx or a network error, and dropped on any other status", async () => {
    const { telemetry, sent, events } = rig({}, [503, 429, new Error("offline"), 200, 400]);
    telemetry.track(opened);
    telemetry.track({ event: "onboarding_finished" });
    for (let i = 0; i < 4; i += 1) await telemetry.flush();
    expect(sent.map((request) => batchOf(request).map((event) => event.uuid))).toEqual(
      Array.from({ length: 4 }, () => batchOf(sent[0]).map((event) => event.uuid)),
    );
    await telemetry.flush();
    expect(sent).toHaveLength(4);
    telemetry.track(opened);
    await telemetry.flush();
    await telemetry.flush();
    expect(sent).toHaveLength(5);
    expect(events()).toHaveLength(9);
  });

  it("send one batch at a time", async () => {
    let answer = (_status: number) => {};
    const { telemetry, sent } = rig({
      send: async (url, body) => {
        sent.push({ url, body });
        return new Promise<number>((resolve) => (answer = resolve));
      },
    });
    telemetry.track(opened);
    const first = telemetry.flush();
    telemetry.track(opened);
    expect(telemetry.flush()).toBe(first);
    expect(sent).toHaveLength(1);
    answer(200);
    await first;
    const second = telemetry.flush();
    answer(200);
    await second;
    expect(sent.map((request) => batchOf(request).length)).toEqual([1, 1]);
  });

  it("stop at once, queue and all, when the teacher opts out, and a batch out at the time isn't sent again", async () => {
    let answer = (_status: number) => {};
    const { telemetry, sent, saved } = rig({
      send: async (url, body) => {
        sent.push({ url, body });
        return new Promise<number>((resolve) => (answer = resolve));
      },
    });
    telemetry.track(opened);
    const out = telemetry.flush();
    telemetry.track({ event: "onboarding_finished" });
    telemetry.choose(false);
    expect(saved().enabled).toBe(false);
    answer(503);
    await out;
    telemetry.track(opened);
    await telemetry.report({ type: "TypeError", stack: "" }, "main");
    await telemetry.flush();
    expect(sent).toHaveLength(1);
    telemetry.choose(true);
    telemetry.track({ event: "draft_requested", kind: "reply" });
    const back = telemetry.flush();
    answer(200);
    await back;
    expect(batchOf(sent[1]).map((event) => event.event)).toEqual(["draft_requested"]);
  });
});
