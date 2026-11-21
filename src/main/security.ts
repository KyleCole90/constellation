import { isAbsolute, relative, resolve } from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";

export const APP_SCHEME = "app";
const APP_HOST = "constellation";
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/`;

export const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const REFUSED_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "proxy-server",
  "proxy-pac-url",
  "host-rules",
  "host-resolver-rules",
  "ignore-certificate-errors",
  "ignore-certificate-errors-spki-list",
  "ssl-key-log-file",
] as const;
export const REFUSED_ENV = ["SSLKEYLOGFILE"] as const;

export const launchRefused = (
  hasSwitch: (name: string) => boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean =>
  REFUSED_SWITCHES.some((name) => hasSwitch(name)) ||
  REFUSED_ENV.some((name) => env[name] !== undefined);

export const windowOptions = (
  preload: string,
  args: readonly string[] = [],
): BrowserWindowConstructorOptions => ({
  width: 1280,
  height: 820,
  title: "Constellation",
  webPreferences: {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    preload,
    ...(args.length > 0 ? { additionalArguments: [...args] } : {}),
  },
});

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

export const lockNavigation = (
  contents: {
    on(
      event: "will-navigate",
      listener: (event: { preventDefault(): void }, url: string) => void,
    ): unknown;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  },
  openExternal: (url: string) => void,
) => {
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    openIfHttps(url, openExternal);
  });
  contents.setWindowOpenHandler(({ url }) => {
    openIfHttps(url, openExternal);
    return { action: "deny" };
  });
};

export const denyPermissions = (session: {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, grant: (granted: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: (contents: unknown, permission: string) => boolean): void;
}) => {
  session.setPermissionRequestHandler((_contents, _permission, grant) => grant(false));
  session.setPermissionCheckHandler(() => false);
};

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
