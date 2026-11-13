/**
 * Crash reports to PostHog, sent from main only (docs/electron-spec.md, D20, D23, D24). A report carries an error's
 * type, its stack frames (file, line, column), the app version and the OS. It never carries message text:
 * every value counts as student data, so anything the scrubber can't prove is ours is dropped.
 *
 * This is one POST to PostHog's capture endpoint, not posthog-node, so nothing but the scrubbed report can ride along:
 * no person profile, no GeoIP, no autocapture, no breadcrumbs.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_FRAMES } from "../shared/ipc";

/**
 * One stack frame, oldest first, as PostHog's raw stack trace takes it. A frame in a file of this app's own bundle keeps
 * its path and position; any other frame is only `<withheld>`. No frame carries a function name: a name can come from
 * data (`{ [studentName]: () => … }`), and in a minified bundle the file and position already find the line. PostHog
 * drops a frame without `function` from Error tracking, so every frame names the same placeholder.
 */
type Frame =
  | {
      readonly platform: Platform;
      readonly function: typeof NO_NAME;
      readonly filename: string;
      readonly lineno: number;
      readonly colno: number;
      readonly in_app: true;
    }
  | {
      readonly platform: Platform;
      readonly function: typeof NO_NAME;
      readonly filename: "<withheld>";
      readonly in_app: false;
    };

const NO_NAME = "<withheld>";

type Platform = "node:javascript" | "web:javascript";

interface Scrubbed {
  readonly type: string;
  readonly frames: readonly Frame[];
}

export type Source = "main" | "renderer";

/** The error types a report may name: JavaScript's own. The app has no error classes of its own yet. */
const ERROR_TYPES: ReadonlySet<string> = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);
const FRAME = /^\s*at (?:.+? \()?(.+):(\d{1,7}):(\d{1,7})\)?$/;
const PLAIN_PATH = /^out\/[\w-]+(?:\/[\w.-]+)+$/;

/** A frame's file as a path inside the app (`out/…`), or null when it can't be one. */
const ownPath = (raw: string, appRoot: string): string | null => {
  const file = raw.replace(/[?#].*$/, "");
  const served = /^app:\/\/[^/]+\/(.+)$/.exec(file)?.[1];
  if (served !== undefined) return `out/dist/${served}`;
  let path = file;
  if (file.startsWith("file://")) {
    try {
      path = fileURLToPath(file);
    } catch {
      return null;
    }
  }
  return path.startsWith(`${appRoot}/`) ? path.slice(appRoot.length + 1) : null;
};

/**
 * An error as the report may carry it. The type survives only if it is one of JavaScript's own, and each stack line
 * survives only as a frame: the message, and every line that isn't a frame, is dropped. A frame keeps its file only
 * when that file exists in this app's own build under `appRoot`, so a path that merely looks like the app's can't
 * carry a name.
 */
const scrub = (type: string, stack: string, source: Source, appRoot: string): Scrubbed => {
  const platform: Platform = source === "main" ? "node:javascript" : "web:javascript";
  const frameOf = (file: string, lineno: string, colno: string): Frame => {
    const path = ownPath(file, appRoot);
    return path !== null &&
      PLAIN_PATH.test(path) &&
      !path.split("/").includes("..") &&
      existsSync(join(appRoot, path))
      ? {
          platform,
          function: NO_NAME,
          filename: path,
          lineno: Number(lineno),
          colno: Number(colno),
          in_app: true,
        }
      : { platform, function: NO_NAME, filename: "<withheld>", in_app: false };
  };
  return {
    type: ERROR_TYPES.has(type) ? type : "Error",
    frames: stack
      .split("\n")
      .flatMap((line) => {
        const [, file, lineno, colno] = FRAME.exec(line) ?? [];
        return file && lineno && colno ? [frameOf(file, lineno, colno)] : [];
      })
      .slice(0, MAX_FRAMES)
      .reverse(),
  };
};

/** The env var that turns reports off whatever the teacher chose. */
const isEnvOff = (value: string | undefined) => value?.trim().toLowerCase() === "false";

/** A launch sends at most this many, so an error in a render loop can't flood PostHog. */
const PER_LAUNCH = 25;

export interface TelemetryOptions {
  /** PostHog's project key, baked in at build time. None means a build that sends nothing. */
  readonly key: string;
  /** The folder holding this app's `out/`. Only a file that exists under it can name a frame. */
  readonly appRoot: string;
  readonly host: string;
  /** `CONSTELLATION_TELEMETRY_ENABLED`; `false` turns reports off. */
  readonly env: string | undefined;
  /** True when nothing may leave the app at all, as when verify runs it. */
  readonly offline: boolean;
  /** The teacher's choice, on until they turn it off. */
  readonly choice: { read(): boolean; write(enabled: boolean): void };
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly send: (url: string, body: string) => Promise<unknown>;
}

export const createTelemetry = (options: TelemetryOptions) => {
  const available = options.key !== "" && !isEnvOff(options.env) && !options.offline;
  // A fresh id each launch, so no report ties to an earlier one or to a person.
  const launch = crypto.randomUUID();
  let sent = 0;
  return {
    /** Whether the teacher has reports on, and whether this build and launch can send any. */
    status: () => ({ enabled: options.choice.read(), available }),
    choose: (enabled: boolean) => options.choice.write(enabled),
    /** Scrubs and sends one error. Never throws: a report that can't be sent is dropped. */
    report: async (type: string, stack: string, source: Source): Promise<void> => {
      if (!available || sent >= PER_LAUNCH || !options.choice.read()) return;
      sent += 1;
      const { type: kind, frames } = scrub(type, stack, source, options.appRoot);
      const body = {
        api_key: options.key,
        event: "$exception",
        distinct_id: launch,
        properties: {
          $exception_list: [
            {
              type: kind,
              value: "(message withheld)",
              mechanism: { handled: false, synthetic: false },
              stacktrace: { type: "raw", frames },
            },
          ],
          $process_person_profile: false,
          $geoip_disable: true,
          source,
          app_version: options.appVersion,
          os: options.os,
          os_version: options.osVersion,
        },
      };
      try {
        await options.send(`${options.host.replace(/\/+$/, "")}/i/v0/e/`, JSON.stringify(body));
      } catch {
        // Nowhere to report a failed report.
      }
    },
  };
};
