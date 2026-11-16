/**
 * Usage events and crash reports to PostHog, sent from main only.
 * A usage event is one of the fixed shapes in `src/shared/analytics.ts`: fixed words and counts, never free text. A
 * crash report carries an error's type, its stack frames (file, line, column), the app version and the OS. It never
 * carries message text: every value counts as student data, so anything the scrubber can't prove is ours is dropped.
 *
 * Delivery is one POST to PostHog's batch endpoint, not posthog-node, so nothing but these events can ride along: no
 * person profile, no GeoIP, no autocapture, no breadcrumbs.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

import { AnalyticsEventSchema, type AnalyticsEvent } from "../shared/analytics";
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

/** The env var that turns sending off whatever the teacher chose. */
const isEnvOff = (value: string | undefined) => value?.trim().toLowerCase() === "false";

/** A launch sends at most this many crash reports, so an error in a render loop can't flood PostHog. */
const PER_LAUNCH = 25;
/** Events held while PostHog can't be reached. Past this, new ones are dropped. */
const QUEUE_CAP = 200;
/** A queue this long is sent without waiting for the timer. */
const BATCH_SIZE = 20;

/** `telemetry.json`: the teacher's choice, and the random id every event names in place of a person. */
export const TelemetrySavedSchema = v.strictObject({
  enabled: v.boolean(),
  installId: v.optional(v.pipe(v.string(), v.uuid())),
});
type Saved = v.InferOutput<typeof TelemetrySavedSchema>;

interface Captured {
  readonly uuid: string;
  readonly event: string;
  readonly timestamp: string;
  readonly distinct_id: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface TelemetryOptions {
  /** PostHog's project key, baked in at build time. None means a build that sends nothing. */
  readonly key: string;
  readonly host: string;
  /** The folder holding this app's `out/`. Only a file that exists under it can name a frame. */
  readonly appRoot: string;
  /** `CONSTELLATION_TELEMETRY_ENABLED`; `false` turns sending off. */
  readonly env: string | undefined;
  /** True when nothing may leave the app at all, as in every unpackaged run but verify's sink. */
  readonly offline: boolean;
  /** `telemetry.json`, on until the teacher turns it off. */
  readonly saved: { read(): Saved; write(saved: Saved): void };
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion: string;
  /** How often the queue is sent. */
  readonly flushMs: number;
  /** POSTs a body and answers its HTTP status. */
  readonly send: (url: string, body: string) => Promise<number>;
}

export const createTelemetry = (options: TelemetryOptions) => {
  const available = options.key !== "" && !options.offline && !isEnvOff(options.env);
  const batchUrl = `${options.host.replace(/\/+$/, "")}/batch/`;
  let saved = options.saved.read();
  let queue: readonly Captured[] = [];
  let inFlight: Promise<void> | null = null;
  let reports = 0;
  const sending = () => available && saved.enabled;

  /** Written on the first event, so a launch that never sends leaves no id behind. */
  const installId = (): string => {
    if (saved.installId) return saved.installId;
    const id = crypto.randomUUID();
    saved = { ...saved, installId: id };
    options.saved.write(saved);
    return id;
  };

  const enqueue = (event: string, properties: Readonly<Record<string, unknown>>) => {
    if (!sending() || queue.length >= QUEUE_CAP) return;
    queue = [
      ...queue,
      {
        uuid: crypto.randomUUID(),
        event,
        timestamp: new Date().toISOString(),
        distinct_id: installId(),
        properties: {
          ...properties,
          $lib: "constellation-desktop",
          $lib_version: options.appVersion,
          $process_person_profile: false,
          $geoip_disable: true,
        },
      },
    ];
    if (queue.length >= BATCH_SIZE) void flush();
  };

  /** Sends the queue in one POST, one at a time. A batch PostHog may take later goes back to the front. */
  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (!sending()) queue = [];
    if (queue.length === 0) return Promise.resolve();
    const batch = queue;
    queue = [];
    inFlight = (async () => {
      const status = await options
        .send(batchUrl, JSON.stringify({ api_key: options.key, batch }))
        .catch(() => null);
      if ((status === null || status === 429 || status >= 500) && sending())
        queue = [...batch, ...queue].slice(0, QUEUE_CAP);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const timer = setInterval(() => void flush(), options.flushMs);
  timer.unref();

  return {
    /** Whether the teacher has sending on, and whether this launch can send anything. */
    status: () => ({ enabled: saved.enabled, available }),
    /** Turning it off drops whatever is queued, so nothing more leaves. */
    choose: (enabled: boolean) => {
      saved = { ...saved, enabled };
      options.saved.write(saved);
      if (!enabled) queue = [];
    },
    /** Queues one usage event. Its properties are what the schema lets through, so nothing unparsed rides along. */
    track: (event: AnalyticsEvent) => {
      const parsed = v.safeParse(AnalyticsEventSchema, event);
      if (!parsed.success) return;
      const { event: name, ...properties } = parsed.output;
      enqueue(name, properties);
    },
    /** Scrubs one error and sends it at once. Never throws: a report that can't be sent is dropped. */
    report: async (type: string, stack: string, source: Source): Promise<void> => {
      if (!sending() || reports >= PER_LAUNCH) return;
      reports += 1;
      const { type: kind, frames } = scrub(type, stack, source, options.appRoot);
      enqueue("$exception", {
        $exception_list: [
          {
            type: kind,
            value: "(message withheld)",
            mechanism: { handled: false, synthetic: false },
            stacktrace: { type: "raw", frames },
          },
        ],
        source,
        app_version: options.appVersion,
        os: options.os,
        os_version: options.osVersion,
      });
      await flush();
    },
    flush,
    stop: () => clearInterval(timer),
  };
};
