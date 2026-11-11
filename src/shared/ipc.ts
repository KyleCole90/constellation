import * as v from "valibot";

import type { VaultKey } from "./providers/provider";

/**
 * A renderer error as it crosses to main: its type and its stack, never its message (docs/electron-spec.md, D23).
 * Strict, so a payload carrying anything more is rejected rather than trimmed.
 */
const RendererError = v.strictObject({ type: v.string(), stack: v.string() });

/** A school's id or `ai-key`. Main can't check a school id against anything yet, so any non-empty string passes. */
export const VaultKeySchema = v.custom<VaultKey>(
  (input) => typeof input === "string" && input !== "",
);
const ByKey = v.strictObject({ key: VaultKeySchema });

interface Channel {
  readonly input: v.GenericSchema;
  readonly output: v.GenericSchema;
}

/** Every channel between the renderer and main, declared once (docs/electron-spec.md, D16). */
const ipc = {
  "error.report": { input: RendererError, output: v.void() },
  "vault.enroll": {
    input: v.strictObject({ key: VaultKeySchema, token: v.pipe(v.string(), v.minLength(1)) }),
    output: v.void(),
  },
  "vault.keys": { input: v.void(), output: v.array(VaultKeySchema) },
  "vault.forget": { input: ByKey, output: v.void() },
  /** What the renderer's fake LMS checks in place of the token, which never leaves main. Null when there is no entry. */
  "vault.standIn": { input: ByKey, output: v.nullable(v.string()) },
} satisfies Record<string, Channel>;

type Ipc = typeof ipc;
type ChannelName = keyof Ipc;
type Input<C extends ChannelName> = v.InferInput<Ipc[C]["input"]>;
type Output<C extends ChannelName> = v.InferOutput<Ipc[C]["output"]>;

/** One handler per channel. A missing or misspelled one fails to compile. */
type Handlers = {
  readonly [C in ChannelName]: (
    input: v.InferOutput<Ipc[C]["input"]>,
  ) => Promise<v.InferInput<Ipc[C]["output"]>>;
};

/**
 * `ipcMain.handle`, typed loosely enough that shared code needn't import `electron`.
 * Main passes each call's sender frame URL, or null when the frame is gone.
 */
type Register = (
  channel: string,
  listener: (sender: string | null, input: unknown) => Promise<unknown>,
) => void;

const serve = <C extends ChannelName>(channel: C, handler: Handlers[C], input: unknown) =>
  handler(v.parse(ipc[channel].input, input));

/**
 * Registers every handler in main. A call from a frame `trusted` refuses, or with an input that doesn't parse,
 * rejects before its handler runs.
 */
export const handle = (
  register: Register,
  trusted: (sender: string) => boolean,
  handlers: Handlers,
) => {
  for (const channel of Object.keys(ipc) as ChannelName[])
    register(channel, async (sender, input) => {
      if (sender === null || !trusted(sender)) throw new Error(`${channel}: untrusted sender`);
      return serve(channel, handlers[channel], input);
    });
};

/** What the preload exposes to the renderer as `window.constellation`. */
export interface Bridge {
  invoke<C extends ChannelName>(channel: C, input: Input<C>): Promise<Output<C>>;
}

const isChannel = (name: unknown): name is ChannelName =>
  typeof name === "string" && Object.hasOwn(ipc, name);

/**
 * The renderer's `invoke`, over `ipcRenderer.invoke`. The renderer is untrusted, so the channel is checked here too,
 * and each output is parsed before the renderer sees it.
 */
export const invoker =
  (send: (channel: ChannelName, input: unknown) => Promise<unknown>): Bridge["invoke"] =>
  async (channel, input) => {
    if (!isChannel(channel)) throw new Error(`No IPC channel named ${JSON.stringify(channel)}`);
    return v.parse(ipc[channel].output, await send(channel, input));
  };
