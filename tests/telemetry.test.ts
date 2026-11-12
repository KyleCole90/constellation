import { describe, expect, it } from "vite-plus/test";

import { createTelemetry, type TelemetryOptions } from "../src/main/telemetry";
import { errorReport } from "../src/shared/ipc";

/** Student data, planted wherever an error can carry it. None of it may reach PostHog. */
const STUDENT = {
  name: "Maria Garcia",
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
  for (const word of ["Maria", "Garcia", "mgarcia", "lakeshore", "AbCdEf"])
    expect(body).not.toContain(word);
  expect(body).not.toContain(process.cwd());
  expect(body).not.toContain("/Users/");
};

/** A real thrown error whose message, name and function name all carry student data. */
const studentError = () => {
  const handlers = {
    [STUDENT.name]: () => {
      throw new TypeError(
        `Cannot grade ${STUDENT.name} <${STUDENT.email}>: ${STUDENT.grade} at ${STUDENT.course}?access_token=${STUDENT.token}\n` +
          `    at ${STUDENT.login} (${STUDENT.home}grades.js:1:1)\n` +
          `    at gradeFor (${STUDENT.home}Desktop/out/main/${STUDENT.login}.mjs:2:2)`,
      );
    },
  };
  try {
    handlers[STUDENT.name]?.();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
};

/** What a renderer stack looks like, with student data in every place it can hide. */
const RENDERER_STACK = [
  `TypeError: ${STUDENT.name} has no grade`,
  `    at ${STUDENT.email} (app://constellation/assets/index-Ab12.js:3:40)`,
  `    at Object.<anonymous> (app://constellation/assets/index-Ab12.js?token=${STUDENT.token}:5:6)`,
  `    at renderGrade (app://constellation/assets/index-Ab12.js:10:20)`,
  `    at async load (http://localhost:4320/src/renderer/stores/workspace.ts:7:8)`,
  `    at gradebook (${STUDENT.course}:1:1)`,
  `    at readRoster (file://${STUDENT.home}Library/Caches/roster-${STUDENT.login}.js:1:1)`,
  `    at Module.run (/Applications/Constellation.app/Contents/Resources/app.asar/out/main/index.mjs:40:2)`,
  `    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)`,
  `${STUDENT.grade} and ${STUDENT.home}`,
].join("\n");

describe("a crash report", () => {
  it("carries no student data from a main error's message, name, function or path", async () => {
    const { telemetry, sent } = rig();
    const error = studentError();
    if (error instanceof Error) error.name = STUDENT.name;
    const { type, stack } = errorReport(error);
    await telemetry.report(type, stack, "main");
    expect(sent).toHaveLength(1);
    expectNoStudentData(sent[0]?.body ?? "");
  });

  it("carries no student data from a renderer's stack, whatever it sends", async () => {
    const { telemetry, sent } = rig();
    await telemetry.report("TypeError", RENDERER_STACK, "renderer");
    await telemetry.report(STUDENT.email, RENDERER_STACK, "renderer");
    expect(sent).toHaveLength(2);
    for (const { body } of sent) expectNoStudentData(body);
  });

  it("keeps the type, the app's own frames oldest first, the version and the OS", async () => {
    const { telemetry, sent } = rig();
    await telemetry.report("TypeError", RENDERER_STACK, "renderer");
    const request = sent[0];
    expect(request?.url).toBe("https://eu.i.posthog.com/i/v0/e/");
    const body: unknown = JSON.parse(request?.body ?? "");
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
    const frame = (
      fn: string,
      filename: string,
      lineno: number,
      colno: number,
      in_app: boolean,
    ) => ({
      platform: "web:javascript",
      function: fn,
      filename,
      lineno,
      colno,
      in_app,
    });
    expect(frames).toEqual(
      [
        frame("<withheld>", "assets/index-Ab12.js", 3, 40, true),
        frame("Object.<anonymous>", "assets/index-Ab12.js", 5, 6, true),
        frame("renderGrade", "assets/index-Ab12.js", 10, 20, true),
        frame("async load", "src/renderer/stores/workspace.ts", 7, 8, true),
        frame("gradebook", "<withheld>", 1, 1, false),
        frame("readRoster", "<withheld>", 1, 1, false),
        frame("Module.run", "out/main/index.mjs", 40, 2, true),
        frame(
          "process.processTicksAndRejections",
          "node:internal/process/task_queues",
          105,
          5,
          false,
        ),
      ].reverse(),
    );
  });

  it("drops a message line that reads like a frame", () => {
    const { stack } = errorReport(studentError());
    expect(stack).not.toContain(STUDENT.login);
    expect(stack).toMatch(/^\n\s+at /);
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
