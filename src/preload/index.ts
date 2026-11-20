import { contextBridge, ipcRenderer } from "electron";

import { FAKES_SWITCH, invoker, type Bridge } from "../shared/ipc";

declare const process: { readonly argv: readonly string[] };

contextBridge.exposeInMainWorld("constellation", {
  fakes: process.argv.includes(FAKES_SWITCH),
  invoke: invoker((channel, input) => ipcRenderer.invoke(channel, input)),
} satisfies Bridge);
