import { contextBridge } from "electron";

/** The renderer's only door to main. It has no channels yet; the typed IPC map adds them (docs/electron-spec.md, D16). */
contextBridge.exposeInMainWorld("constellation", {});
