import * as v from "valibot";

import type { LmsError } from "../shared/domain/change";
import type { Result, SchoolId } from "../shared/domain/ids";
import type { School } from "../shared/domain/lms";
import { SendPermit } from "../shared/domain/permit";
import type { Handlers } from "../shared/ipc";
import { labSnapshot, type LabCommand } from "../shared/providers/fake-canvas/lab";
import { createFakeCanvasDescriptor } from "../shared/providers/fake-canvas/provider";
import { FakeCanvasServer, type StorageLike } from "../shared/providers/fake-canvas/server";
import type {
  CredentialLease,
  LmsProvider,
  TermSetup,
  VaultKey,
} from "../shared/providers/provider";

import { jsonFile } from "./json-file";

/**
 * A `StorageLike` in one JSON file under `userData` (docs/electron-spec.md, D8). Main is its only writer, so it reads
 * the file once and answers from memory after that.
 */
export const createFileStorage = (file: string): StorageLike => {
  const disk = jsonFile<Readonly<Record<string, string>>>(
    file,
    v.record(v.string(), v.string()),
    {},
  );
  let items = disk.read();
  const save = (next: Readonly<Record<string, string>>) => {
    disk.write(next);
    items = next;
  };
  return {
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => save({ ...items, [key]: value }),
    removeItem: (key) => {
      const { [key]: _removed, ...rest } = items;
      save(rest);
    },
  };
};

/** The fake LMS as the desktop app runs it: on real time, storing to `storage`. */
export const fakeServer = (storage: StorageLike) => (now: () => number) =>
  new FakeCanvasServer({
    storage,
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: () => Math.random(),
  });

type LmsChannel = Extract<keyof Handlers, `lms.${string}`>;

const NO_TERM_SETUP = {
  ok: false,
  error: { kind: "unsupported", capability: "term setup" },
} as const satisfies Result<never, LmsError>;

/**
 * Main's half of every `lms.*` channel: one provider per school, holding a lease on main's vault, so a token never
 * crosses to the renderer. The fake LMS runs here, the way a real one will (docs/electron-spec.md, step 10).
 */
export const lmsHandlers = (options: {
  makeServer(now: () => number): FakeCanvasServer;
  realNow(): number;
  leaseFor(key: VaultKey): CredentialLease;
  /** A packaged app refuses the channels only verify reads. */
  packaged: boolean;
}): Pick<Handlers, LmsChannel> => {
  let offset = 0;
  const now = () => options.realNow() + offset;
  /** Counts every move of the lab, across reloads, for `lms.labNext` to wait on. */
  let version = 0;
  const waiting = new Set<() => void>();
  const moved = () => {
    version += 1;
    for (const wake of waiting) wake();
    waiting.clear();
  };
  const start = () => {
    const server = options.makeServer(now);
    server.subscribe(moved);
    return {
      server,
      descriptor: createFakeCanvasDescriptor(server, now),
      providers: new Map<SchoolId, LmsProvider>(),
    };
  };
  let fake = start();

  const provider = (school: School): LmsProvider => {
    const existing = fake.providers.get(school.id);
    if (existing) return existing;
    const created = fake.descriptor.create({ school, lease: options.leaseFor(school.id) });
    fake.providers.set(school.id, created);
    return created;
  };
  const term = async <T>(
    school: School,
    read: (setup: TermSetup) => Promise<Result<T, LmsError>>,
  ): Promise<Result<T, LmsError>> => {
    const setup = provider(school).termSetup;
    return setup ? read(setup) : NO_TERM_SETUP;
  };
  const unpackaged = <T>(answer: () => T) => {
    if (options.packaged) throw new Error("A packaged app doesn't answer verify's reads.");
    return answer();
  };

  const run = (command: LabCommand): void => {
    switch (command.do) {
      case "setNoise":
        return fake.server.setNoise(command.patch);
      case "resetNoise":
        return fake.server.resetNoise();
      case "expireToken":
        return fake.server.expireToken(command.school);
      case "changeGradeOutOfBand":
        return fake.server.changeGradeOutOfBand(command.submission, command.newGrade, command.by);
      case "studentResubmits":
        return fake.server.studentResubmits(command.submission);
      case "failNextWrite":
        return fake.server.failNextWrite(command.field, command.error);
      case "loseNextResponse":
        return fake.server.loseNextResponse(command.applied);
      case "lateLanding":
        return fake.server.lateLanding(command.delayMs);
      case "throttleNext":
        return fake.server.throttleNext(command.retryAfterMs, command.on);
      case "holdReads":
        return fake.server.holdReads(command.held);
      case "holdWrites":
        return fake.server.holdWrites(command.held);
      case "failNextMigration":
        return fake.server.failNextMigration(command.stage, command.message);
      case "enrollStudents":
        return fake.server.enrollStudents(command.course, command.count);
      case "setDemoScript":
        return fake.server.setDemoScript(command.enabled);
      case "reset":
        return fake.server.reset();
      case "reload":
        fake = start();
        return moved();
      case "clock":
        offset = command.offsetMs;
        return;
    }
  };

  return {
    "lms.verify": ({ school }) => provider(school).verify(),
    "lms.courses": ({ school }) => provider(school).courses(),
    "lms.assignments": ({ school, course }) => provider(school).assignments(course),
    "lms.students": ({ school, course }) => provider(school).students(course),
    "lms.submissions": ({ school, course }) => provider(school).submissions(course),
    "lms.conversations": ({ school }) => provider(school).conversations(),
    "lms.announcements": ({ school, course }) => provider(school).announcements(course),
    "lms.observe": ({ school, content }) => provider(school).observe(content),
    "lms.apply": ({ school, permit }) =>
      provider(school).apply(SendPermit.relayed(permit.changeId, permit.content, permit.fields)),
    "lms.newCourses": ({ school }) => term(school, (setup) => setup.newCourses()),
    "lms.copySources": ({ school }) => term(school, (setup) => setup.copySources()),
    "lms.courseContent": ({ school, course }) =>
      term(school, (setup) => setup.courseContent(course)),
    "lms.migrations": ({ school, course }) => term(school, (setup) => setup.migrations(course)),
    "lms.samplePackages": ({ school }) => term(school, (setup) => setup.samplePackages()),
    "lms.lab": async (command) => run(command),
    "lms.labNext": async ({ after }) => {
      if (after === version) await new Promise<void>((wake) => waiting.add(wake));
      return { version, lab: labSnapshot(fake.server) };
    },
    "lms.stored": () => unpackaged(() => fake.server.stored()),
    "lms.findSubmission": async ({ student, assignment }) =>
      unpackaged(() => fake.server.findSubmission(student, assignment)),
  };
};
