import type { Bridge } from "~/shared/ipc";

declare global {
  interface Window {
    /** Main's bridge, from the preload. */
    readonly constellation: Bridge;
  }
}
