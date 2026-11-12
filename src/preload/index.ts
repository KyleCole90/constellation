import { contextBridge, ipcRenderer } from "electron";

import { RULES_AGENT_SWITCH, invoker, type Bridge } from "../shared/ipc";

/** The sandboxed preload's `process`, which carries the window's `additionalArguments`. */
declare const process: { readonly argv: readonly string[] };

/** The renderer's only door to main. It never sees `ipcRenderer` (docs/electron-spec.md, D16). */
contextBridge.exposeInMainWorld("constellation", {
  agent: process.argv.includes(RULES_AGENT_SWITCH) ? "rules" : "claude",
  invoke: invoker((channel, input) => ipcRenderer.invoke(channel, input)),
} satisfies Bridge);
