import * as v from "valibot";

/**
 * A renderer error as it crosses to main: its type and its stack, never its message (docs/electron-spec.md, D23).
 * Strict, so a payload carrying anything more is rejected rather than trimmed.
 */
const RendererError = v.strictObject({ type: v.string(), stack: v.string() });

interface Channel {
  readonly input: v.GenericSchema;
  readonly output: v.GenericSchema;
}

/** Every channel between the renderer and main, declared once (docs/electron-spec.md, D16). */
const ipc = {
  "error.report": { input: RendererError, output: v.void() },
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

/** `ipcMain.handle`, typed loosely enough that shared code needn't import `electron`. */
type Register = (channel: string, listener: (event: unknown, input: unknown) => unknown) => void;

const serve = <C extends ChannelName>(channel: C, handler: Handlers[C], input: unknown) =>
  handler(v.parse(ipc[channel].input, input));

/** Registers every handler in main. Each input is parsed before its handler runs, and a bad one rejects the call. */
export const handle = (register: Register, handlers: Handlers) => {
  for (const channel of Object.keys(ipc) as ChannelName[])
    register(channel, (_event, input) => serve(channel, handlers[channel], input));
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
