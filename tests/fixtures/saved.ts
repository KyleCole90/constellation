import * as v from "valibot";

import { LMS_STORAGE_KEY, parseStoredLms } from "~/shared/providers/fake-canvas/server";
import { WORKSPACE_STORAGE_KEY } from "~/renderer/stores/storage-key";
import { parsePersisted } from "~/renderer/stores/workspace";

type Readable = Pick<Storage, "getItem">;

const read = (storage: Readable, key: string): string => {
  const raw = storage.getItem(key);
  if (raw === null) throw new Error(`Nothing is saved under ${key}.`);
  return raw;
};

/** The saved workspace, read back by the app's own load. A save the app would reset fails the test. */
export const savedWorkspace = (storage: Readable) => {
  const saved = parsePersisted(read(storage, WORKSPACE_STORAGE_KEY));
  if (!saved) throw new Error("The app would reset this saved workspace.");
  return saved.state;
};

/** The fake LMS's save, read back by its own load. */
export const savedLms = (storage: Readable) => {
  const saved = parseStoredLms(JSON.parse(read(storage, LMS_STORAGE_KEY)));
  if (!saved) throw new Error("The fake LMS would start fresh instead of loading this save.");
  return saved;
};

const JsonObject = v.record(v.string(), v.unknown());

/** The same JSON object, typed field by field, so a test can break a save in place below what the app checks. */
export const jsonObject = (value: unknown): Record<string, unknown> => {
  if (!v.is(JsonObject, value)) throw new Error("Expected a JSON object.");
  return value;
};

/** A save as plain JSON objects, for a test that breaks it on purpose. */
export const rawSave = (storage: Readable, key = WORKSPACE_STORAGE_KEY) =>
  v.parse(v.looseObject({ state: JsonObject }), JSON.parse(read(storage, key)));

/** The fake LMS's save as a plain JSON object, for a test that breaks it on purpose. */
export const rawLms = (storage: Readable): Record<string, unknown> =>
  jsonObject(JSON.parse(read(storage, LMS_STORAGE_KEY)));
