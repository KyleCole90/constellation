import { WORKSPACE_STORAGE_KEY } from "../../src/renderer/stores/storage-key.ts";

/** The workspace's storage key as a string literal, for page expressions: `localStorage.getItem(${KEY})`. */
export const KEY = JSON.stringify(WORKSPACE_STORAGE_KEY);
