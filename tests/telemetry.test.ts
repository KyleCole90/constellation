import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

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

const rig = (overrides: Partial<TelemetryOptions> = {}) => {
  const sent: { url: string; body: string }[] = [];
  let enabled = true;
  const telemetry = createTelemetry({
    key: "phc_test",
    appRoot: APP_ROOT,
    host: "https://eu.i.posthog.com/",
    env: undefined,
    offline: false,
    choice: { read: () => enabled, write: (on) => (enabled = on) },
    appVersion: "0.0.1-alpha.1",
    os: "darwin arm64",
    osVersion: "15.1",
    send: async (url, body) => void sent.push({ url, body }),
    ...overrides,
  });
  return { telemetry, sent };
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

const bodyOf = (request: { body: string } | undefined): unknown => JSON.parse(request?.body ?? "");

describe("a crash report", () => {
  it("carries no student data from a main error's message, name or function name", async () => {
    for (const name of [STUDENT.identifier, STUDENT.snake, STUDENT.long]) {
      const { telemetry, sent } = rig();
      const { type, stack } = errorReport(studentError(name, name));
      expect(stack).toContain(" at ");
      await telemetry.report(type, stack, "main");
      expect(sent).toHaveLength(1);
      expectNoStudentData(sent[0]?.body ?? "");
    }
  });

  it("carries no student data from a renderer's stack or type, whatever it sends", async () => {
    const { telemetry, sent } = rig();
    for (const type of ["TypeError", STUDENT.identifier, STUDENT.snake, STUDENT.long])
      await telemetry.report(type, RENDERER_STACK, "renderer");
    expect(sent).toHaveLength(4);
    for (const { body } of sent) expectNoStudentData(body);
  });

  it("names only JavaScript's own error types", async () => {
    const { telemetry, sent } = rig();
    for (const type of ["RangeError", "MayaLopez", "Error"])
      await telemetry.report(type, "", "main");
    expect(sent.map((request) => bodyOf(request))).toMatchObject(
      ["RangeError", "Error", "Error"].map((type) => ({
        properties: { $exception_list: [{ type }] },
      })),
    );
  });

  it("keeps the type, the app's own files and positions oldest first, the version and the OS", async () => {
    const { telemetry, sent } = rig();
    await telemetry.report("TypeError", RENDERER_STACK, "renderer");
    const request = sent[0];
    expect(request?.url).toBe("https://eu.i.posthog.com/i/v0/e/");
    const body = bodyOf(request);
    expect(body).toMatchObject({
      api_key: "phc_test",
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
      filename,
      lineno,
      colno,
      in_app: true,
    });
    const withheld = { platform: "web:javascript", filename: "<withheld>", in_app: false };
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
  it("only when the build has a key, the env allows it, and the teacher hasn't opted out", async () => {
    for (const overrides of [
      { key: "" },
      { env: "false" },
      { env: " FALSE " },
      { offline: true },
    ] satisfies Partial<TelemetryOptions>[]) {
      const { telemetry, sent } = rig(overrides);
      expect(telemetry.status().available).toBe(false);
      await telemetry.report("TypeError", RENDERER_STACK, "renderer");
      expect(sent).toEqual([]);
    }
    const { telemetry, sent } = rig({ env: "true" });
    expect(telemetry.status()).toEqual({ enabled: true, available: true });
    telemetry.choose(false);
    expect(telemetry.status().enabled).toBe(false);
    await telemetry.report("TypeError", RENDERER_STACK, "renderer");
    expect(sent).toEqual([]);
    telemetry.choose(true);
    await telemetry.report("TypeError", RENDERER_STACK, "renderer");
    expect(sent).toHaveLength(1);
  });

  it("at most 25 times a launch, and a failed send never throws", async () => {
    const { telemetry, sent } = rig();
    for (let i = 0; i < 30; i += 1) await telemetry.report("TypeError", "", "main");
    expect(sent).toHaveLength(25);
    const failing = rig({ send: async () => Promise.reject(new Error("offline")) });
    await expect(failing.telemetry.report("TypeError", "", "main")).resolves.toBeUndefined();
  });
});
