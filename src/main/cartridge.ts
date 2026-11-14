import { open, type FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

import type { IsoDate } from "../shared/domain/ids";
import type { PackageTerm } from "../shared/domain/content";
import { isoDate, meetingDaysOf, type DueDay } from "../shared/domain/term";

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
/** The end record is 22 bytes, after a comment of at most 65,535. */
const TAIL_BYTES = 22 + 0xffff;
/** Settings files are a few KB. A bigger one isn't what this reads. */
const MAX_ENTRY_BYTES = 1024 * 1024;
const COURSE_SETTINGS = "course_settings/course_settings.xml";

interface Entry {
  name: string;
  method: number;
  size: number;
  offset: number;
}

const bytesAt = async (file: FileHandle, position: number, length: number): Promise<Buffer> => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
};

/** The archive's table of contents. Throws on anything that isn't a plain zip, which the caller treats as no settings. */
const entriesOf = async (file: FileHandle): Promise<readonly Entry[]> => {
  const { size } = await file.stat();
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = await bytesAt(file, tailStart, size - tailStart);
  let end = tail.length - 22;
  while (end >= 0 && tail.readUInt32LE(end) !== END_OF_DIRECTORY) end -= 1;
  if (end < 0) throw new Error("no zip directory");
  const directory = await bytesAt(file, tail.readUInt32LE(end + 16), tail.readUInt32LE(end + 12));
  const entries: Entry[] = [];
  for (let at = 0; at + 46 <= directory.length;) {
    if (directory.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error("bad zip directory");
    const nameLength = directory.readUInt16LE(at + 28);
    entries.push({
      method: directory.readUInt16LE(at + 10),
      size: directory.readUInt32LE(at + 20),
      offset: directory.readUInt32LE(at + 42),
      name: directory.toString("utf8", at + 46, at + 46 + nameLength),
    });
    at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
  }
  return entries;
};

const textOf = async (file: FileHandle, entry: Entry): Promise<string> => {
  if (entry.size > MAX_ENTRY_BYTES) throw new Error("entry too large");
  const local = await bytesAt(file, entry.offset, 30);
  if (local.readUInt32LE(0) !== LOCAL_ENTRY) throw new Error("bad zip entry");
  const data = await bytesAt(
    file,
    entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
    entry.size,
  );
  if (entry.method === 0) return data.toString("utf8");
  if (entry.method === 8)
    return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString("utf8");
  throw new Error("unsupported zip compression");
};

/** The day in a Canvas export's `<tag>2026-01-12T08:00:00</tag>`, written in the course's own time zone. */
const dayIn = (xml: string, tag: string): IsoDate | null =>
  isoDate(new RegExp(`<${tag}>(\\d{4}-\\d{2}-\\d{2})`).exec(xml)?.[1] ?? "");

/** An assignment's `<title>`, with the entities Canvas writes for markup characters read back. */
const titleIn = (xml: string): string =>
  (/<title>([^<]*)<\/title>/.exec(xml)?.[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/**
 * What a Canvas export says about the term it came from: the course's start and end from its settings, and its
 * assignments' due days, which give the meeting days. Null when the package says none of it, or can't be read.
 */
export const packageTerm = async (path: string): Promise<PackageTerm | null> => {
  let file: FileHandle | null = null;
  try {
    file = await open(path, "r");
    const entries = await entriesOf(file);
    const settings = entries.find((entry) => entry.name === COURSE_SETTINGS);
    const xml = settings ? await textOf(file, settings) : "";
    const dated: DueDay[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith("/assignment_settings.xml")) continue;
      const assignment = await textOf(file, entry);
      const due = dayIn(assignment, "due_at");
      if (due) dated.push({ title: titleIn(assignment), due });
    }
    const term: PackageTerm = {
      name: null,
      start: dayIn(xml, "start_at") ?? "",
      end: dayIn(xml, "conclude_at") ?? "",
      days: meetingDaysOf(dated.map(({ due }) => due)),
      dated: dated.sort((a, b) => a.due.localeCompare(b.due)),
    };
    return term.start || term.end || term.days.length > 0 ? term : null;
  } catch {
    return null;
  } finally {
    await file?.close();
  }
};
