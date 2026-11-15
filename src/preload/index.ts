import { contextBridge, ipcRenderer } from "electron";

import { FAKES_SWITCH, invoker, type Bridge } from "../shared/ipc";

/** The sandboxed preload's `process`, which carries the window's `additionalArguments`. */
declare const process: { readonly argv: readonly string[] };

/** The renderer's only door to main. It never sees `ipcRenderer`. */
contextBridge.exposeInMainWorld("constellation", {
  fakes: process.argv.includes(FAKES_SWITCH),
  invoke: invoker((channel, input) => ipcRenderer.invoke(channel, input)),
} satisfies Bridge);
