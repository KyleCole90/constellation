import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import * as v from "valibot";

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isMissing = (error: unknown) =>
  error instanceof Error && Reflect.get(error, "code") === "ENOENT";

/**
 * One JSON file under `userData`, read and written whole. A missing file reads as `empty`. A file that doesn't parse
 * as `schema`, damaged or written by something else, also reads as `empty`, and is moved aside to `<file>.bad` rather
 * than deleted. A write lands whole or not at all, and only this user can read it.
 */
export const jsonFile = <T>(file: string, schema: v.GenericSchema<unknown, T>, empty: T) => ({
  read: (): T => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return empty;
      throw error;
    }
    const parsed = v.safeParse(schema, parseJson(text));
    if (parsed.success) return parsed.output;
    renameSync(file, `${file}.bad`);
    return empty;
  },
  write: (value: T) => {
    // A temp file left by a crash keeps its old mode, so it goes first and the new one is created 0600.
    rmSync(`${file}.tmp`, { force: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(`${file}.tmp`, file);
  },
});
