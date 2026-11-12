import { isDeepStrictEqual } from "node:util";

import * as v from "valibot";

import {
  FIELD_LABEL,
  fieldsOf,
  fieldText,
  type ChangeContent,
  type FieldKey,
  type LmsError,
} from "../shared/domain/change";
import type { ChangeId, Result, SchoolId } from "../shared/domain/ids";
import type { School } from "../shared/domain/lms";
import { SendPermit } from "../shared/domain/permit";
import type { Handlers } from "../shared/ipc";
import { labSnapshot, type LabCommand } from "../shared/providers/fake-canvas/lab";
import { createFakeCanvasDescriptor, FAKE_SCHOOLS } from "../shared/providers/fake-canvas/provider";
import { FakeCanvasServer, type StorageLike } from "../shared/providers/fake-canvas/server";
import type {
  CredentialLease,
  FieldOutcomes,
  LmsProvider,
  TermSetup,
  VaultKey,
} from "../shared/providers/provider";

import { jsonFile } from "./json-file";
import {
  canvasSchoolAt,
  createCanvasProvider,
  type CanvasProvider,
  type Fetch,
} from "./providers/canvas";

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

const LAB_WAIT_MS = 25_000;

type LmsChannel = Extract<keyof Handlers, `lms.${string}`>;

/** What main asks the teacher before it writes to a real school: where, to whom, and every field the change sends. */
export interface SendConfirmation {
  host: string;
  target: string;
  lines: readonly string[];
}

const NOT_CONFIRMED: LmsError = {
  kind: "rejected",
  reason: "Not sent. You chose not to send it when the app asked you to confirm.",
};
const NOT_THIS_CHANGE: LmsError = {
  kind: "rejected",
  reason: "Not sent. The send named a field this change doesn't write.",
};
const failedAll = (fields: readonly FieldKey[], error: LmsError): FieldOutcomes =>
  Object.fromEntries(fields.map((field) => [field, { status: "failed", error }]));

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
  /** Real Canvas's network. Null leaves only the fake's schools, as verify runs the app, so nothing reaches a real host. */
  fetch: Fetch | null;
  /** Asks the teacher in a native dialog, which the renderer can't click or read. True means send. */
  confirmSend(ask: SendConfirmation): Promise<boolean>;
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

  const canvas = new Map<SchoolId, CanvasProvider>();
  /** The renderer is untrusted, so a Canvas school counts only as main itself would mint it from its host. */
  const canvasProvider = (school: School): CanvasProvider => {
    const minted = canvasSchoolAt(school.host);
    if (!options.fetch || minted?.id !== school.id)
      throw new Error("That isn't a Canvas school this app connects to.");
    const existing = canvas.get(minted.id);
    if (existing) return existing;
    const created = createCanvasProvider({
      school: minted,
      lease: options.leaseFor(minted.id),
      fetch: options.fetch,
      now,
    });
    canvas.set(minted.id, created);
    return created;
  };
  const provider = (school: School): LmsProvider => {
    switch (school.provider) {
      case "canvas":
        return canvasProvider(school);
      case "fake-canvas":
        return fakeProvider(school);
    }
  };
  /** Main's own record of a demo school, so a renderer can't point the fake at a real school's token. */
  const fakeProvider = (asked: School): LmsProvider => {
    const school = FAKE_SCHOOLS.find((entry) => entry.id === asked.id && entry.host === asked.host);
    if (!school) throw new Error("That isn't one of the demo schools.");
    const existing = fake.providers.get(school.id);
    if (existing) return existing;
    const created = fake.descriptor.create({ school, lease: options.leaseFor(school.id) });
    fake.providers.set(school.id, created);
    return created;
  };
  /**
   * The content the teacher confirmed for each change, by school and change id, for as long as main runs. A retry or a
   * resume of the same content sends without asking again; any other content asks first.
   */
  const confirmed = new Map<string, ChangeContent>();
  /**
   * The renderer is untrusted, so its permit is only a request. Main writes to a real school only what the teacher
   * confirmed in main's own dialog, and only the fields that content sends.
   */
  const applyCanvas = async (
    school: School,
    changeId: ChangeId,
    content: ChangeContent,
    fields: readonly FieldKey[],
  ): Promise<FieldOutcomes> => {
    const sends = fieldsOf(content);
    if (fields.length === 0) return {};
    if (fields.some((field) => !sends.includes(field))) return failedAll(fields, NOT_THIS_CHANGE);
    const provider = canvasProvider(school);
    const key = `${school.id}\n${changeId}`;
    if (!isDeepStrictEqual(confirmed.get(key), content)) {
      const target = await provider.targetOf(content);
      if (!target.ok) return failedAll(fields, target.error);
      const yes = await options.confirmSend({
        host: school.host,
        target: target.value,
        lines: sends.map((field) => `${FIELD_LABEL[field]}: ${fieldText(content, field)}`),
      });
      if (!yes) return failedAll(fields, NOT_CONFIRMED);
      confirmed.set(key, content);
    }
    return provider.apply(SendPermit.relayed(changeId, content, fields));
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
    "lms.schoolAt": async ({ host }) =>
      FAKE_SCHOOLS.find((school) => school.host === host) ??
      (options.fetch ? canvasSchoolAt(host) : null),
    "lms.verify": ({ school }) => provider(school).verify(),
    "lms.courses": ({ school }) => provider(school).courses(),
    "lms.assignments": ({ school, course }) => provider(school).assignments(course),
    "lms.students": ({ school, course }) => provider(school).students(course),
    "lms.submissions": ({ school, course }) => provider(school).submissions(course),
    "lms.conversations": ({ school }) => provider(school).conversations(),
    "lms.announcements": ({ school, course }) => provider(school).announcements(course),
    "lms.observe": ({ school, content }) => provider(school).observe(content),
    "lms.apply": ({ school, permit: { changeId, content, fields } }) => {
      switch (school.provider) {
        case "canvas":
          return applyCanvas(school, changeId, content, fields);
        // The demo's LMS is a file the renderer can already rewrite through the failure lab, so nothing is guarded here.
        case "fake-canvas":
          return fakeProvider(school).apply(SendPermit.relayed(changeId, content, fields));
      }
    },
    "lms.newCourses": ({ school }) => term(school, (setup) => setup.newCourses()),
    "lms.copySources": ({ school }) => term(school, (setup) => setup.copySources()),
    "lms.courseContent": ({ school, course }) =>
      term(school, (setup) => setup.courseContent(course)),
    "lms.migrations": ({ school, course }) => term(school, (setup) => setup.migrations(course)),
    "lms.samplePackages": ({ school }) => term(school, (setup) => setup.samplePackages()),
    "lms.lab": async (command) => run(command),
    "lms.labNext": async ({ after }) => {
      // Bounded, so a waiter left by a closed or reloaded window doesn't sit forever; the renderer simply asks again.
      if (after === version)
        await new Promise<void>((wake) => {
          waiting.add(wake);
          setTimeout(() => {
            waiting.delete(wake);
            wake();
          }, LAB_WAIT_MS);
        });
      return { version, lab: labSnapshot(fake.server) };
    },
    "lms.stored": () => unpackaged(() => fake.server.stored()),
    "lms.findSubmission": async ({ student, assignment }) =>
      unpackaged(() => fake.server.findSubmission(student, assignment)),
  };
};
