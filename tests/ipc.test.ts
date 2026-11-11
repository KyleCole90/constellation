import { describe, expect, it } from "vite-plus/test";

import { handle, invoker } from "../src/shared/ipc";

type Listener = (event: unknown, input: unknown) => unknown;

/** Main's side: the listeners `handle` registers, by channel, and every input a handler was given. */
const registered = () => {
  const listeners = new Map<string, Listener>();
  const reports: unknown[] = [];
  handle((channel, listener) => listeners.set(channel, listener), {
    "error.report": async (report) => {
      reports.push(report);
    },
  });
  const call = async (channel: string, input: unknown) => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`no listener for ${channel}`);
    return listener({}, input);
  };
  return { listeners, reports, call };
};

const REPORT = { type: "TypeError", stack: "at render (app.tsx:12:3)" };

describe("main's handlers", () => {
  it("register one listener per channel", () => {
    expect([...registered().listeners.keys()]).toEqual(["error.report"]);
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

  it("must cover every channel, spelled right", () => {
    const register = () => {};
    // @ts-expect-error: a missing handler fails to compile.
    handle(register, {});
    // @ts-expect-error: a misspelled handler fails to compile.
    handle(register, { "error.reprot": async () => {} });
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
