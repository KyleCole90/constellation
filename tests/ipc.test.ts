import { describe, expect, it } from "vite-plus/test";

import type { SchoolId } from "../src/shared/domain/ids";
import { handle, invoker } from "../src/shared/ipc";

import { fakeLmsHandlers } from "./fixtures/bridge";

type Listener = (sender: string | null, input: unknown) => Promise<unknown>;

const APP = "app://constellation/";

/** Main's side: the listeners `handle` registers, by channel, and every input a handler was given. */
const registered = () => {
  const listeners = new Map<string, Listener>();
  const reports: unknown[] = [];
  const handled: unknown[] = [];
  const record = async (input: unknown) => void handled.push(input);
  handle(
    (channel, listener) => listeners.set(channel, listener),
    (sender) => sender === APP,
    {
      "error.report": async (report) => {
        reports.push(report);
      },
      "telemetry.status": async () => ({ enabled: true, available: false }),
      "telemetry.choose": record,
      "vault.enroll": record,
      "vault.keys": async () => [],
      "vault.forget": record,
      "vault.standIn": async () => null,
      "agent.run": async (input) => {
        handled.push(input);
        return { ok: false, reason: "no agent in this rig" };
      },
      ...fakeLmsHandlers(),
    },
  );
  const call = async (channel: string, input: unknown, sender: string | null = APP) => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`no listener for ${channel}`);
    return listener(sender, input);
  };
  return { listeners, reports, handled, call };
};

const REPORT = { type: "TypeError", stack: "at render (app.tsx:12:3)" };

describe("main's handlers", () => {
  it("register one listener per channel", () => {
    expect([...registered().listeners.keys()]).toEqual([
      "error.report",
      "telemetry.status",
      "telemetry.choose",
      "vault.enroll",
      "vault.keys",
      "vault.forget",
      "vault.standIn",
      "agent.run",
      "lms.schoolAt",
      "lms.verify",
      "lms.courses",
      "lms.assignments",
      "lms.students",
      "lms.submissions",
      "lms.file",
      "lms.linkExport",
      "lms.conversations",
      "lms.announcements",
      "lms.observe",
      "lms.apply",
      "lms.newCourses",
      "lms.copySources",
      "lms.courseContent",
      "lms.migrations",
      "lms.samplePackages",
      "lms.pickPackage",
      "lms.lab",
      "lms.labNext",
      "lms.stored",
      "lms.findSubmission",
    ]);
  });

  it("pass a well-formed input to the handler", async () => {
    const main = registered();
    await expect(main.call("error.report", REPORT)).resolves.toBeUndefined();
    expect(main.reports).toEqual([REPORT]);
  });

  it.each([
    ["nothing", undefined],
    ["a string", "TypeError"],
    ["a missing stack", { type: "TypeError" }],
    ["a number for the type", { type: 1, stack: "" }],
    ["a message, which never leaves the renderer", { ...REPORT, message: "Ada Lovelace" }],
  ])("reject %s without running the handler", async (_name, input) => {
    const main = registered();
    await expect(main.call("error.report", input)).rejects.toThrow();
    expect(main.reports).toEqual([]);
  });

  it.each([
    ["another origin", "https://example.com/"],
    ["a file", "file:///etc/passwd"],
    ["a frame that is gone", null],
  ])("refuse a call from %s without running the handler", async (_name, sender) => {
    const main = registered();
    await expect(main.call("error.report", REPORT, sender)).rejects.toThrow("untrusted sender");
    await expect(main.call("vault.forget", { key: "lcc" }, sender)).rejects.toThrow();
    expect(main.reports).toEqual([]);
    expect(main.handled).toEqual([]);
  });

  it.each([
    ["vault.enroll", { key: "lcc", token: "" }],
    ["vault.enroll", { key: "", token: "abc" }],
    ["vault.enroll", { key: "lcc" }],
    ["vault.enroll", { key: "lcc", token: "abc", extra: true }],
    ["vault.forget", { key: 7 }],
    ["vault.forget", "lcc"],
    ["vault.standIn", {}],
    ["agent.run", { request: "", history: [], scope: {} }],
    [
      "agent.run",
      { request: "Draft a grade.", history: [{ role: "system", text: "x" }], scope: {} },
    ],
    ["agent.run", { request: "Draft a grade.", history: [], scope: {}, model: "claude-fable-5-2" }],
  ])("reject %s with a bad input %j", async (channel, input) => {
    const main = registered();
    await expect(main.call(channel, input)).rejects.toThrow();
    expect(main.handled).toEqual([]);
  });

  it("must cover every channel, spelled right", () => {
    const register = () => {};
    const trusted = () => true;
    // @ts-expect-error: a missing handler fails to compile.
    handle(register, trusted, {});
    // @ts-expect-error: a misspelled handler fails to compile.
    handle(register, trusted, { "error.reprot": async () => {} });
  });
});

describe("the renderer's invoke", () => {
  it("returns a well-formed output", async () => {
    const invoke = invoker(async () => undefined);
    await expect(invoke("error.report", REPORT)).resolves.toBeUndefined();
  });

  it("rejects an output that doesn't parse", async () => {
    const invoke = invoker(async () => ({ leaked: true }));
    await expect(invoke("error.report", REPORT)).rejects.toThrow();
  });

  it.each([["lcc", 7], "lcc", null])("rejects vault keys that don't parse: %j", async (output) => {
    const invoke = invoker(async () => output);
    await expect(invoke("vault.keys", undefined)).rejects.toThrow();
  });

  it("rejects a stand-in that isn't text", async () => {
    const invoke = invoker(async () => 42);
    await expect(invoke("vault.standIn", { key: "lcc" as SchoolId })).rejects.toThrow();
  });

  it("rejects a channel that isn't in the map without sending it", async () => {
    const sent: string[] = [];
    const invoke = invoker(async (channel) => {
      sent.push(channel);
    });
    // @ts-expect-error: the renderer is untrusted, so the runtime check must hold even when the types don't.
    await expect(invoke("vault.reveal", {})).rejects.toThrow("No IPC channel");
    expect(sent).toEqual([]);
  });

  it("carries a bad input to main, which rejects it", async () => {
    const main = registered();
    const invoke = invoker((channel, input) => Promise.resolve(main.call(channel, input)));
    // @ts-expect-error: main parses inputs, so a renderer that gets past the types is still refused.
    await expect(invoke("error.report", { type: "TypeError" })).rejects.toThrow();
    expect(main.reports).toEqual([]);
  });
});
