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
import { createFakeCanvasDescriptor, FAKE_SCHOOLS } from "../shared/providers/fake-canvas/provider";
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

const FILE_CACHE_BYTES = 64 * 1024 * 1024;

type LmsChannel = Extract<keyof Handlers, `lms.${string}`>;

/** How recently the teacher must have pressed something for a send to count as theirs: long enough for the read before it. */
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

/** Canvas's own default cap on an import, so a bigger file is refused before anything is sent. */
const MAX_PACKAGE_BYTES = 500 * 1024 * 1024;
const refusal = (reason: string) => ({ ok: false, error: { kind: "rejected", reason } }) as const;

/** The file at `path` if it can be a course package: an `.imscc` file, not empty and not over the cap. */
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
  /**
   * When the teacher last clicked in the window or pressed Return or Space there, in `realNow` time, as the OS
   * delivered it. Page script can't produce that input, so the renderer can't fake a press.
   */
  pressedAt(): number;
  /** Main's native file picker for an `.imscc` file: its path, or null when the teacher cancels. */
  choosePackage(): Promise<string | null>;
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

  /**
   * The packages the teacher chose in main's picker, by school and file name, for as long as main runs. The renderer
   * only ever names one, so it can't send a file the teacher didn't choose. A later pick of the same name replaces it.
   */
  const picked = new Map<string, string>();
  const packageFile = async (school: SchoolId, name: string): Promise<Blob | null> => {
    const path = picked.get(`${school}\n${name}`);
    // Checked again, since the file may have changed on disk since it was chosen.
    if (path === undefined || !(await packageAt(path)).ok) return null;
    return openAsBlob(path).catch(() => null);
  };
  const canvas = new Map<SchoolId, LmsProvider>();
  /** The renderer is untrusted, so a Canvas school counts only as main itself would mint it from its host. */
  const canvasProvider = (school: School): LmsProvider => {
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
      packageFile: (name) => packageFile(minted.id, name),
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
   * The content each change was sent with, by school and change id, for as long as main runs. A first send of any
   * content needs the teacher's press moments before, and a retry or resume of the same content doesn't. A field that
   * adds an entry (a comment, a message, a post) goes out once per press: once sent, sending it again needs a new press,
   * so even a renderer that replays the request can't post twice without the teacher pressing Send again.
   */
  const pressed = new Map<string, { content: ChangeContent; sent: Set<FieldKey> }>();
  /**
   * The renderer is untrusted, so its permit is only a request. Main writes to a real school only right after the
   * teacher pressed something, and only the fields that content sends.
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
    // Counted as sent before the request leaves, so a second request racing this one needs a new press.
    const appends = fields.filter(appendsEntry);
    for (const field of appends) press.sent.add(field);
    const outcomes = await provider.apply(SendPermit.relayed(changeId, content, fields));
    for (const field of appends) if (outcomes[field]?.status === "failed") press.sent.delete(field);
    return outcomes;
  };
  /** A file's id names one upload, which Canvas never changes, so a file main can't read stays refused. */
  const files = new Map<string, Result<FileContent, LmsError>>();
  /** Word, RTF and text files reach the renderer and Claude as their words, in Markdown (#68). */
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
      case "clearDueDates":
        return fake.server.clearDueDates(command.course);
      case "createShell":
        return fake.server.createShell(command.school, command.code, command.title);
      case "hideTermDates":
        return fake.server.hideTermDates(command.hidden);
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
    "lms.file": ({ school, submission, file }) => readFile(school, submission, file),
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
    "lms.pickPackage": async ({ school }) => {
      // Throws unless main itself would mint this school from its host. A demo school's import reads only the name.
      if (school.provider === "canvas") canvasProvider(school);
      const path = await options.choosePackage();
      if (path === null) return { ok: true, value: null };
      const file = await packageAt(path);
      if (!file.ok) return file;
      if (school.provider === "canvas") picked.set(`${school.id}\n${file.value.name}`, path);
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
