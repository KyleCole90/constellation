import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import * as v from "valibot";

import {
  appendsEntry,
  fieldsOf,
  type ChangeContent,
  type FieldKey,
  type LmsError,
} from "../shared/domain/change";
import type { PickedPackage } from "../shared/domain/content";
import type { ChangeId, LmsRef, Result, SchoolId } from "../shared/domain/ids";
import { mainReadsAsText, type FileContent, type School } from "../shared/domain/lms";
import { SendPermit } from "../shared/domain/permit";
import type { Handlers } from "../shared/ipc";
import { labSnapshot, type LabCommand } from "../shared/providers/fake-canvas/lab";
import {
  FAKE_REAL_SCHOOL,
  FAKE_SCHOOLS,
  createFakeCanvasDescriptor,
  fakeSchoolAt,
} from "../shared/providers/fake-canvas/provider";
import { FakeCanvasServer, type StorageLike } from "../shared/providers/fake-canvas/server";
import type {
  CredentialLease,
  FieldOutcomes,
  LmsProvider,
  TermSetup,
  VaultKey,
} from "../shared/providers/provider";

import { packageTerm } from "./cartridge";
import { documentText } from "./document-text";
import { jsonFile } from "./json-file";
import { canvasSchoolAt, createCanvasProvider, type Fetch } from "./providers/canvas";

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

export const fakeServer = (storage: StorageLike) => (now: () => number) =>
  new FakeCanvasServer({
    storage,
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: () => Math.random(),
  });

const LAB_WAIT_MS = 25_000;

const FILE_CACHE_BYTES = 64 * 1024 * 1024;

type LmsChannel = Extract<keyof Handlers, `lms.${string}`>;

export const SEND_PRESS_MS = 10_000;

const NOT_PRESSED: LmsError = {
  kind: "rejected",
  reason: "Not sent, because it didn't come from your press of Send. Send it again.",
};
const NOT_THIS_CHANGE: LmsError = {
  kind: "rejected",
  reason: "Not sent. The send named a field this change doesn't write.",
};
const failedAll = (fields: readonly FieldKey[], error: LmsError): FieldOutcomes =>
  Object.fromEntries(fields.map((field) => [field, { status: "failed", error }]));

const MAX_PACKAGE_BYTES = 500 * 1024 * 1024;
const refusal = (reason: string) => ({ ok: false, error: { kind: "rejected", reason } }) as const;

const packageAt = async (
  path: string,
): Promise<Result<{ name: string; size: number }, LmsError>> => {
  const name = basename(path);
  if (!name.toLowerCase().endsWith(".imscc"))
    return refusal("That file isn't a course export. Choose a file that ends in .imscc.");
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return refusal(`${name} is empty or isn't a file.`);
    if (info.size > MAX_PACKAGE_BYTES)
      return refusal(`${name} is larger than the 500 MB Canvas imports.`);
    return { ok: true, value: { name, size: info.size } };
  } catch {
    return refusal(`The app couldn't read ${name}.`);
  }
};

const NO_TERM_SETUP = {
  ok: false,
  error: { kind: "unsupported", capability: "term setup" },
} as const satisfies Result<never, LmsError>;

export const knownSchoolId = (kind: "fake" | "canvas", id: SchoolId): boolean =>
  kind === "fake"
    ? id === FAKE_REAL_SCHOOL.id || FAKE_SCHOOLS.some((school) => school.id === id)
    : canvasSchoolAt(id)?.id === id;

export const lmsHandlers = (options: {
  lms:
    | { kind: "fake"; makeServer(now: () => number): FakeCanvasServer }
    | { kind: "canvas"; fetch: Fetch };
  realNow(): number;
  leaseFor(key: VaultKey): CredentialLease;
  pressedAt(): number;
  choosePackage(): Promise<string | null>;
}): Pick<Handlers, LmsChannel> => {
  let offset = 0;
  const now = () => options.realNow() + offset;
  let version = 0;
  const waiting = new Set<() => void>();
  const moved = () => {
    version += 1;
    for (const wake of waiting) wake();
    waiting.clear();
  };
  const start = (makeServer: (now: () => number) => FakeCanvasServer) => {
    const server = makeServer(now);
    server.subscribe(moved);
    return {
      makeServer,
      server,
      descriptor: createFakeCanvasDescriptor(server, now),
      providers: new Map<SchoolId, LmsProvider>(),
    };
  };
  const world = options.lms;
  let live = world.kind === "fake" ? start(world.makeServer) : null;
  const theFake = () => {
    if (!live) throw new Error("This app has no demo schools.");
    return live;
  };

  const picked = new Map<string, string>();
  const packageFile = async (school: SchoolId, name: string): Promise<Blob | null> => {
    const path = picked.get(`${school}\n${name}`);
    if (path === undefined || !(await packageAt(path)).ok) return null;
    return openAsBlob(path).catch(() => null);
  };
  const canvas = new Map<SchoolId, LmsProvider>();
  const mintedCanvasSchool = (school: School): { school: School; fetch: Fetch } => {
    if (world.kind !== "canvas")
      throw new Error("That isn't a Canvas school this app connects to.");
    const minted = canvasSchoolAt(school.host);
    if (minted?.id !== school.id)
      throw new Error("That isn't a Canvas school this app connects to.");
    return { school: minted, fetch: world.fetch };
  };
  const canvasProvider = (school: School): LmsProvider => {
    const { school: minted, fetch } = mintedCanvasSchool(school);
    const existing = canvas.get(minted.id);
    if (existing) return existing;
    const created = createCanvasProvider({
      school: minted,
      lease: options.leaseFor(minted.id),
      fetch,
      now,
      packageFile: (name) => packageFile(minted.id, name),
    });
    canvas.set(minted.id, created);
    return created;
  };
  const provider = (school: School): LmsProvider => {
    if (world.kind === "fake") return fakeProvider(school);
    switch (school.provider) {
      case "canvas":
        return canvasProvider(school);
      case "fake-canvas":
        return fakeProvider(school);
    }
  };
  const fakeProvider = (asked: School): LmsProvider => {
    const fake = theFake();
    const school = fakeSchoolAt(asked.host);
    if (!school || school.id !== asked.id || school.provider !== asked.provider)
      throw new Error("That isn't one of the demo schools.");
    const existing = fake.providers.get(school.id);
    if (existing) return existing;
    const created = fake.descriptor.create({ school, lease: options.leaseFor(school.id) });
    fake.providers.set(school.id, created);
    return created;
  };
  const pressed = new Map<string, { content: ChangeContent; sent: Set<FieldKey> }>();
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
    let press = pressed.get(key);
    if (
      !press ||
      !isDeepStrictEqual(press.content, content) ||
      fields.some((field) => press?.sent.has(field))
    ) {
      if (options.realNow() - options.pressedAt() > SEND_PRESS_MS)
        return failedAll(fields, NOT_PRESSED);
      press = { content, sent: new Set() };
      pressed.set(key, press);
    }
    const appends = fields.filter(appendsEntry);
    for (const field of appends) press.sent.add(field);
    const outcomes = await provider.apply(SendPermit.relayed(changeId, content, fields));
    for (const field of appends) if (outcomes[field]?.status === "failed") press.sent.delete(field);
    return outcomes;
  };
  const files = new Map<string, Result<FileContent, LmsError>>();
  const asText = async (content: FileContent): Promise<Result<FileContent, LmsError>> => {
    if (!mainReadsAsText(content.mediaType)) return { ok: true, value: content };
    const text = await documentText(content.mediaType, content.data);
    return text.ok
      ? {
          ok: true,
          value: { mediaType: "text/markdown", data: new TextEncoder().encode(text.value) },
        }
      : { ok: false, error: { kind: "rejected", reason: text.error } };
  };
  const readFile = async (
    school: School,
    submission: LmsRef<"submission">,
    id: string,
  ): Promise<Result<FileContent, LmsError>> => {
    const key = `${school.id}\n${school.provider}\n${submission}\n${id}`;
    const kept = files.get(key);
    if (kept) return kept;
    const read = await provider(school).file(submission, id);
    if (!read.ok) return read;
    const shown = await asText(read.value);
    files.set(key, shown);
    let total = 0;
    for (const value of files.values()) total += value.ok ? value.value.data.byteLength : 0;
    for (const [old, value] of files) {
      if (total <= FILE_CACHE_BYTES) break;
      files.delete(old);
      total -= value.ok ? value.value.data.byteLength : 0;
    }
    return shown;
  };
  const term = async <T>(
    school: School,
    read: (setup: TermSetup) => Promise<Result<T, LmsError>>,
  ): Promise<Result<T, LmsError>> => {
    const setup = provider(school).termSetup;
    return setup ? read(setup) : NO_TERM_SETUP;
  };
  const run = (command: LabCommand): void => {
    const fake = theFake();
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
      case "clearDueDates":
        return fake.server.clearDueDates(command.course);
      case "addAssignments":
        return fake.server.addAssignments(command.course, command.titles);
      case "createShell":
        return fake.server.createShell(command.school, command.code, command.title);
      case "hideTermDates":
        return fake.server.hideTermDates(command.hidden);
      case "setDemoScript":
        return fake.server.setDemoScript(command.enabled);
      case "reset":
        return fake.server.reset();
      case "reload":
        live = start(fake.makeServer);
        return moved();
      case "clock":
        offset = command.offsetMs;
        return;
    }
  };

  return {
    "lms.schoolAt": async ({ host }) =>
      world.kind === "canvas" ? canvasSchoolAt(host) : fakeSchoolAt(host),
    "lms.verify": ({ school }) => provider(school).verify(),
    "lms.courses": ({ school }) => provider(school).courses(),
    "lms.assignments": ({ school, course }) => provider(school).assignments(course),
    "lms.students": ({ school, course }) => provider(school).students(course),
    "lms.submissions": ({ school, course }) => provider(school).submissions(course),
    "lms.file": ({ school, submission, file }) => readFile(school, submission, file),
    "lms.linkExport": ({ school, submission }) => provider(school).linkExport(submission),
    "lms.conversations": ({ school }) => provider(school).conversations(),
    "lms.announcements": ({ school, course }) => provider(school).announcements(course),
    "lms.observe": ({ school, content }) => provider(school).observe(content),
    "lms.apply": ({ school, permit: { changeId, content, fields } }) => {
      if (world.kind === "fake")
        return fakeProvider(school).apply(SendPermit.relayed(changeId, content, fields));
      switch (school.provider) {
        case "canvas":
          return applyCanvas(school, changeId, content, fields);
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
    "lms.pickPackage": async ({ school }) => {
      const target =
        world.kind === "canvas" && school.provider === "canvas"
          ? mintedCanvasSchool(school).school
          : null;
      const path = await options.choosePackage();
      if (path === null) return { ok: true, value: null };
      const file = await packageAt(path);
      if (!file.ok) return file;
      if (target) picked.set(`${target.id}\n${file.value.name}`, path);
      return {
        ok: true,
        value: {
          name: file.value.name,
          kb: Math.ceil(file.value.size / 1024),
          hint: await packageTerm(path),
        } satisfies PickedPackage,
      };
    },
    "lms.lab": async (command) => run(command),
    "lms.labNext": async ({ after }) => {
      theFake();
      if (after === version)
        await new Promise<void>((wake) => {
          waiting.add(wake);
          setTimeout(() => {
            waiting.delete(wake);
            wake();
          }, LAB_WAIT_MS);
        });
      return { version, lab: labSnapshot(theFake().server) };
    },
    "lms.stored": () => theFake().server.stored(),
    "lms.findSubmission": async ({ student, assignment }) =>
      theFake().server.findSubmission(student, assignment),
  };
};
