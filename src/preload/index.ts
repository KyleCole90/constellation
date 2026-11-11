import { contextBridge, ipcRenderer } from "electron";

import { invoker, type Bridge } from "../shared/ipc";

/** The renderer's only door to main. It never sees `ipcRenderer` (docs/electron-spec.md, D16). */
contextBridge.exposeInMainWorld("constellation", {
  invoke: invoker((channel, input) => ipcRenderer.invoke(channel, input)),
} satisfies Bridge);
