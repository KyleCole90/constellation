import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { WebContents } from "electron";
import { describe, expect, it } from "vite-plus/test";

import { APP_URL, CSP, appFile, lockNavigation, windowOptions } from "../src/main/security";

const directives = new Map(
  CSP.split(";").map((part) => {
    const [name = "", ...sources] = part.trim().split(/\s+/);
    return [name, sources] as const;
  }),
);

describe("window options", () => {
  it("isolate and sandbox the renderer, with no Node in it", () => {
    expect(windowOptions("/preload.cjs").webPreferences).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: "/preload.cjs",
    });
  });
});

describe("CSP", () => {
  it("defaults to the app's own origin and connects nowhere else", () => {
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
  });

  it("runs no inline script, no eval and no remote script", () => {
    expect(directives.has("script-src")).toBe(false);
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|wasm-unsafe-eval|https?:|\*/);
  });

  it("widens only images, to data: URLs", () => {
    const widened = [...directives].filter(([, sources]) =>
      sources.some((source) => source !== "'self'" && source !== "'none'"),
    );
    expect(widened).toEqual([["img-src", ["'self'", "data:"]]]);
  });

  it("matches a page that has no inline script", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
    expect([...html.matchAll(/<script\b[^>]*>/g)].filter(([tag]) => !/\bsrc=/.test(tag))).toEqual(
      [],
    );
  });
});

describe("navigation lock", () => {
  const locked = () => {
    const contents = new EventEmitter();
    let openWindow: (details: { url: string }) => { action: string } = () => ({ action: "allow" });
    const opened: string[] = [];
    lockNavigation(
      Object.assign(contents, {
        setWindowOpenHandler: (handler: typeof openWindow) => (openWindow = handler),
      }) as unknown as WebContents,
      (url) => opened.push(url),
    );
    const navigate = (url: string) => {
      let prevented = false;
      contents.emit("will-navigate", { preventDefault: () => (prevented = true) }, url);
      return prevented;
    };
    return { navigate, openWindow: (url: string) => openWindow({ url }), opened };
  };

  it.each([
    "https://school.instructure.com/courses/1",
    "http://example.com",
    `${APP_URL}settings`,
    "file:///etc/passwd",
    "javascript:alert(1)",
  ])("denies navigating to %s", (url) => {
    expect(locked().navigate(url)).toBe(true);
  });

  it.each(["https://school.instructure.com/profile/settings", "http://example.com", "file:///etc"])(
    "denies a new window for %s",
    (url) => {
      expect(locked().openWindow(url)).toEqual({ action: "deny" });
    },
  );

  it("opens only https: links in the system browser", () => {
    const lock = locked();
    for (const url of [
      "https://a.example/x",
      "http://b.example",
      "file:///etc/passwd",
      "mailto:x@y.z",
      "not a url",
    ])
      lock.openWindow(url);
    lock.navigate("https://c.example/");
    lock.navigate("smb://d.example/share");
    expect(lock.opened).toEqual(["https://a.example/x", "https://c.example/"]);
  });
});

describe("app:// protocol", () => {
  const ROOT = "/app/out/dist";

  it("serves files from the renderer folder", () => {
    expect(appFile(ROOT, `${APP_URL}assets/index-abc.js`)).toBe(join(ROOT, "assets/index-abc.js"));
    expect(appFile(ROOT, `${APP_URL}theme.js`)).toBe(join(ROOT, "theme.js"));
  });

  it("serves index.html for app routes", () => {
    for (const route of ["", "due", "courses/lcc%3Acourse%3A1", "threads/t-1?x=1#y"])
      expect(appFile(ROOT, `${APP_URL}${route}`)).toBe(join(ROOT, "index.html"));
  });

  it("keeps dot segments the URL parser resolves inside the folder", () => {
    expect(appFile(ROOT, `${APP_URL}%2e%2e/%2e%2e/etc/passwd.txt`)).toBe(
      join(ROOT, "etc/passwd.txt"),
    );
  });

  it.each([
    `${APP_URL}..%2F..%2Fetc%2Fpasswd`,
    `${APP_URL}assets/..%2f..%2f..%2fsecret.txt`,
    `${APP_URL}%2E%2E%2Fdist-sibling%2Fx.js`,
    `${APP_URL}bad%E0%A4%A.js`,
    "app://elsewhere/index.html",
    "file:///app/out/dist/index.html",
    "https://constellation/index.html",
  ])("refuses %s", (url) => {
    expect(appFile(ROOT, url)).toBeNull();
  });
});
