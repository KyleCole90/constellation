/**
 * Crash reports to PostHog, sent from main only (docs/electron-spec.md, D20, D23, D24). A report carries an error's
 * type, its stack frames (file, line, column, function), the app version and the OS. It never carries message text:
 * every value counts as student data, so anything the scrubber can't prove is ours is dropped.
 *
 * This is one POST to PostHog's capture endpoint, not posthog-node, so nothing but the scrubbed report can ride along:
 * no person profile, no GeoIP, no autocapture, no breadcrumbs.
 */

/** One stack frame, oldest first, as PostHog's raw stack trace takes it. */
interface Frame {
  readonly platform: "node:javascript" | "web:javascript";
  readonly filename: string;
  readonly function: string;
  readonly lineno: number;
  readonly colno: number;
  readonly in_app: boolean;
}

interface Scrubbed {
  readonly type: string;
  readonly frames: readonly Frame[];
}

export type Source = "main" | "renderer";

const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/;
/** What V8 prints for a function: `fn`, `Class.method`, `new Class`, `async fn`, `<anonymous>`, `fn [as alias]`. */
const FUNCTION =
  /^(?:new |async )?(?:<anonymous>|[A-Za-z_$][\w$]*(?:\.(?:<anonymous>|[A-Za-z_$][\w$]*))*)(?: \[as [A-Za-z_$][\w$]*\])?$/;
const FRAME = /^\s*at (?:(.+?) \()?(.+):(\d+):(\d+)\)?$/;
/** Where our own code lives: the built app (from any install path), `app://`, or the dev server. */
const OUR_FILE =
  /(?:^app:\/\/[^/]+\/|^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/|\/(?=out\/(?:main|preload|dist)\/))(.+)$/;
const PLAIN_PATH = /^[\w.-]+(?:\/[\w.-]+)*$/;
const WITHHELD = "<withheld>";

const fileOf = (raw: string): { filename: string; in_app: boolean } => {
  const path = raw.replace(/[?#].*$/, "");
  if (/^node:[\w/:-]+$/.test(path)) return { filename: path, in_app: false };
  const ours = OUR_FILE.exec(path)?.[1];
  return ours !== undefined && PLAIN_PATH.test(ours) && !ours.split("/").includes("..")
    ? { filename: ours, in_app: true }
    : { filename: WITHHELD, in_app: false };
};

/**
 * An error as the report may carry it. The type survives only as a plain identifier, and each stack line survives
 * only as a frame: the message, and every line that isn't a frame, is dropped. A file outside the app, like
 * `/Users/<name>/…`, becomes `<withheld>`, and so does a function name that isn't an identifier.
 */
const scrub = (type: string, stack: string, source: Source): Scrubbed => ({
  type: IDENTIFIER.test(type) ? type : "Error",
  frames: stack
    .split("\n")
    .flatMap((line) => {
      const match = FRAME.exec(line);
      if (!match) return [];
      const [, fn = "<anonymous>", file = "", lineno = "0", colno = "0"] = match;
      return [
        {
          platform: source === "main" ? "node:javascript" : "web:javascript",
          ...fileOf(file),
          function: FUNCTION.test(fn) ? fn : WITHHELD,
          lineno: Number(lineno),
          colno: Number(colno),
        } satisfies Frame,
      ];
    })
    .slice(0, 50)
    .reverse(),
});

/** The env var that turns reports off whatever the teacher chose. */
const isEnvOff = (value: string | undefined) => value?.trim().toLowerCase() === "false";

/** A launch sends at most this many, so an error in a render loop can't flood PostHog. */
const PER_LAUNCH = 25;

export interface TelemetryOptions {
  /** PostHog's project key, baked in at build time. None means a build that sends nothing. */
  readonly key: string;
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
      const { type: kind, frames } = scrub(type, stack, source);
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
