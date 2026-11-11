import { isAbsolute, relative, resolve } from "node:path";

import type { BrowserWindowConstructorOptions, WebContents } from "electron";

export const APP_SCHEME = "app";
const APP_HOST = "constellation";
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/`;

/** `img-src data:` is for the CSS mask icons and the small assets vite inlines. Nothing else leaves `'self'`. */
export const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const windowOptions = (preload: string): BrowserWindowConstructorOptions => ({
  width: 1280,
  height: 820,
  title: "Constellation",
  webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload },
});

/**
 * Whether an IPC call comes from the app: a frame on `app://`, or on the dev server's origin when `npm run dev`
 * or verify serves the renderer. Anything else the window could ever load gets no handler.
 */
export const trustedSender =
  (devOrigin: string | undefined) =>
  (sender: string): boolean => {
    const url = URL.parse(sender);
    if (url?.protocol === `${APP_SCHEME}:`) return url.host === APP_HOST;
    return devOrigin !== undefined && url?.origin === URL.parse(devOrigin)?.origin;
  };

const openIfHttps = (url: string, openExternal: (url: string) => void) => {
  if (URL.parse(url)?.protocol === "https:") openExternal(url);
};

/** The window never leaves the app. An `https:` link opens in the system browser; anything else goes nowhere. */
export const lockNavigation = (contents: WebContents, openExternal: (url: string) => void) => {
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    openIfHttps(url, openExternal);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openIfHttps(url, openExternal);
    return { action: "deny" };
  });
};

/**
 * The file under `root` that an `app://` request names, or null for another host or a path that escapes `root`.
 * A path with no extension is an app route, so it gets `index.html`.
 */
export const appFile = (root: string, requestUrl: string): string | null => {
  const url = URL.parse(requestUrl);
  if (url?.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const file = resolve(root, `.${path}`);
  const inside = relative(root, file);
  if (inside.startsWith("..") || isAbsolute(inside)) return null;
  return /\.[^/]+$/.test(path) ? file : resolve(root, "index.html");
};
