import type { Bridge } from "~/shared/ipc";

declare global {
  interface Window {
    /** Main's bridge, from the preload. Absent in the web demo, which has no main process. */
    readonly constellation?: Bridge;
  }
}
