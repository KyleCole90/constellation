import type { FieldKey, LmsError } from "~/shared/domain/change";
import { isoTime, type LmsRef, type Result } from "~/shared/domain/ids";
import type { School } from "~/shared/domain/lms";
import { SendPermit } from "~/shared/domain/permit";
import type { Bridge } from "~/shared/ipc";
import { DEFAULT_NOISE, type FaultLab } from "~/shared/providers/fake-canvas/faults";
import type { LabCommand, LabSnapshot } from "~/shared/providers/fake-canvas/lab";
import type {
  FieldOutcomes,
  LmsProvider,
  ProviderDescriptor,
  Read,
  TermSetup,
} from "~/shared/providers/provider";

type Face = Pick<LmsProvider, "vendorLabel" | "capabilities" | "describeScope">;

const UNREACHABLE = {
  ok: false,
  error: { kind: "unavailable", status: null },
} as const satisfies Result<never, LmsError>;

/** A read that never throws: main unreachable, or an answer that doesn't parse, reads as the LMS being unavailable. */
const read = async <T>(call: () => Promise<Result<T, LmsError>>): Read<T> => {
  try {
    return await call();
  } catch {
    return UNREACHABLE;
  }
};

/**
 * A school's provider in the desktop app: every call goes to main, which runs the provider with the token from its
 * vault (docs/electron-spec.md, step 10). The renderer never holds the token, so the lease it is handed goes unused.
 * Same interface as the provider it stands for, so the store and the screens can't tell them apart.
 */
const createBridgeProvider = (
  bridge: Bridge,
  face: Face,
  school: School,
  now: () => number,
): Omit<LmsProvider, "termSetup"> => {
  const bySchool = { school };
  const byCourse = (course: LmsRef<"course">) => ({ school, course });
  /** An apply main never answered may still have landed, so every field it was asked to write is in doubt. */
  const unknown = (fields: readonly FieldKey[]): FieldOutcomes =>
    Object.fromEntries(
      fields.map((field) => [field, { status: "unknown", since: isoTime(now()) }]),
    );
  return {
    ...face,
    verify: () => read(() => bridge.invoke("lms.verify", bySchool)),
    courses: () => read(() => bridge.invoke("lms.courses", bySchool)),
    assignments: (course) => read(() => bridge.invoke("lms.assignments", byCourse(course))),
    students: (course) => read(() => bridge.invoke("lms.students", byCourse(course))),
    submissions: (course) => read(() => bridge.invoke("lms.submissions", byCourse(course))),
    conversations: () => read(() => bridge.invoke("lms.conversations", bySchool)),
    announcements: (course) => read(() => bridge.invoke("lms.announcements", byCourse(course))),
    observe: (content) => read(() => bridge.invoke("lms.observe", { school, content })),
    apply: async (permit) => {
      if (!SendPermit.isGenuine(permit)) return {};
      const { changeId, content, fields } = permit;
      return bridge
        .invoke("lms.apply", { school, permit: { changeId, content, fields } })
        .catch(() => unknown(fields));
    },
  };
};

const bridgeTermSetup = (bridge: Bridge, school: School): TermSetup => {
  const bySchool = { school };
  const byCourse = (course: LmsRef<"course">) => ({ school, course });
  return {
    newCourses: () => read(() => bridge.invoke("lms.newCourses", bySchool)),
    copySources: () => read(() => bridge.invoke("lms.copySources", bySchool)),
    courseContent: (course) => read(() => bridge.invoke("lms.courseContent", byCourse(course))),
    migrations: (course) => read(() => bridge.invoke("lms.migrations", byCourse(course))),
    samplePackages: () => read(() => bridge.invoke("lms.samplePackages", bySchool)),
  };
};

/** Real Canvas, which main runs, term setup included. */
export const bridgeCanvas = (
  bridge: Bridge,
  canvas: Omit<ProviderDescriptor, "create">,
  face: Face,
  now: () => number,
): ProviderDescriptor => ({
  ...canvas,
  create: ({ school }) => ({
    ...createBridgeProvider(bridge, face, school, now),
    termSetup: bridgeTermSetup(bridge, school),
  }),
});

/** What the lab shows until main's first answer arrives. */
const CALM: LabSnapshot = {
  noise: DEFAULT_NOISE,
  defaultNoise: DEFAULT_NOISE,
  demoScript: { enabled: false, fired: [] },
  armed: { failedFields: [], lostResponses: 0, throttles: 0 },
  writes: [],
};

/** Verify names a submission through this. Over IPC it can only answer later, so it isn't on FaultLab. */
export type BridgeLab = FaultLab & {
  findSubmission(student: string, assignmentShort: string): Promise<LmsRef<"submission"> | null>;
};

/**
 * The desktop app's fake LMS: a provider descriptor and a failure lab, both over the bridge to the fake in main.
 * The lab keeps main's latest state, because the Settings screen reads it synchronously.
 */
export const bridgeFakeLms = (
  bridge: Bridge,
  fake: Omit<ProviderDescriptor, "create">,
  face: Face,
  now: () => number,
): { descriptor: ProviderDescriptor; lab: BridgeLab; reset(): void } => {
  let sentOffset: number | null = null;
  const send = (command: LabCommand) => void bridge.invoke("lms.lab", command);
  /**
   * Main's fake keeps the app's demo clock. Sent ahead of each call whenever it moved, which is on a reset; a
   * millisecond of drift between the two clock reads isn't a move.
   */
  const syncClock = () => {
    const offsetMs = now() - Date.now();
    if (sentOffset !== null && Math.abs(offsetMs - sentOffset) <= 1) return;
    sentOffset = offsetMs;
    send({ do: "clock", offsetMs });
  };
  const command = (next: LabCommand) => {
    syncClock();
    send(next);
  };

  let snapshot = CALM;
  let version = 0;
  const listeners = new Set<() => void>();
  const take = (next: LabSnapshot) => {
    snapshot = next;
    version += 1;
    for (const listener of listeners) listener();
  };
  /** Main answers once the lab moves past what the renderer has, so the Settings screen follows it. */
  const follow = (after: number | null): void =>
    void bridge.invoke("lms.labNext", { after }).then(
      (next) => {
        take(next.lab);
        follow(next.version);
      },
      // One failed ask mustn't freeze the lab for the session; ask again shortly.
      () => setTimeout(() => follow(after), 1000),
    );
  // A fresh renderer gets a fresh fake, as a page reload does in the web demo.
  command({ do: "reload" });
  follow(null);

  const clocked: Bridge = {
    invoke: (channel, input) => {
      syncClock();
      return bridge.invoke(channel, input);
    },
  };

  const lab: BridgeLab = {
    noise: () => snapshot.noise,
    setNoise: (patch) => command({ do: "setNoise", patch }),
    defaultNoise: () => snapshot.defaultNoise,
    resetNoise: () => command({ do: "resetNoise" }),
    expireToken: (school) => command({ do: "expireToken", school }),
    changeGradeOutOfBand: (submission, newGrade, by) =>
      command({ do: "changeGradeOutOfBand", submission, newGrade, by }),
    studentResubmits: (submission) => command({ do: "studentResubmits", submission }),
    failNextWrite: (field, error) => command({ do: "failNextWrite", field, error }),
    loseNextResponse: (applied = true) => command({ do: "loseNextResponse", applied }),
    lateLanding: (delayMs) => command({ do: "lateLanding", delayMs }),
    throttleNext: (retryAfterMs, on = "any") => command({ do: "throttleNext", retryAfterMs, on }),
    holdReads: (held) => command({ do: "holdReads", held }),
    holdWrites: (held) => command({ do: "holdWrites", held }),
    failNextMigration: (stage, message) => command({ do: "failNextMigration", stage, message }),
    enrollStudents: (course, count) => command({ do: "enrollStudents", course, count }),
    demoScript: () => snapshot.demoScript,
    setDemoScript: (enabled) => command({ do: "setDemoScript", enabled }),
    armed: () => snapshot.armed,
    writes: () => snapshot.writes,
    stored: () => bridge.invoke("lms.stored", undefined),
    findSubmission: (student, assignment) =>
      bridge.invoke("lms.findSubmission", { student, assignment }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    version: () => version,
  };

  return {
    descriptor: {
      ...fake,
      create: ({ school }) => ({
        ...createBridgeProvider(clocked, face, school, now),
        termSetup: bridgeTermSetup(clocked, school),
      }),
    },
    lab,
    reset: () => command({ do: "reset" }),
  };
};
