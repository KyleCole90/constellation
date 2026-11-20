import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

import { AnalyticsEventSchema, type AnalyticsEvent } from "../shared/analytics";
import { MAX_FRAMES, type ErrorReport } from "../shared/ipc";

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

const isEnvOff = (value: string | undefined) => value?.trim().toLowerCase() === "false";

const PER_LAUNCH = 25;
const QUEUE_CAP = 200;
const BATCH_SIZE = 20;

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
  readonly key: string;
  readonly host: string;
  readonly appRoot: string;
  readonly env: string | undefined;
  readonly offline: boolean;
  readonly saved: { read(): Saved; write(saved: Saved): void };
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly flushMs: number;
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
    status: () => ({ enabled: saved.enabled, available }),
    choose: (enabled: boolean) => {
      saved = { ...saved, enabled };
      options.saved.write(saved);
      if (!enabled) queue = [];
    },
    track: (event: AnalyticsEvent) => {
      const parsed = v.safeParse(AnalyticsEventSchema, event);
      if (!parsed.success) return;
      const { event: name, ...properties } = parsed.output;
      enqueue(name, properties);
    },
    report: async ({ type, stack }: ErrorReport, source: Source): Promise<void> => {
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
