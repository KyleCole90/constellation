import { open, type FileHandle } from "node:fs/promises";

import type { IsoDate } from "../shared/domain/ids";
import type { PackageTerm } from "../shared/domain/content";
import { isoDate, meetingDaysOf, type DueDay } from "../shared/domain/term";

import { zipEntries, zipEntryText, type ZipSource } from "./zip";

const MAX_ENTRY_BYTES = 1024 * 1024;
const COURSE_SETTINGS = "course_settings/course_settings.xml";

const dayIn = (xml: string, tag: string): IsoDate | null =>
  isoDate(new RegExp(`<${tag}>(\\d{4}-\\d{2}-\\d{2})`).exec(xml)?.[1] ?? "");

const titleIn = (xml: string): string =>
  (/<title>([^<]*)<\/title>/.exec(xml)?.[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

export const packageTerm = async (path: string): Promise<PackageTerm | null> => {
  let file: FileHandle | null = null;
  try {
    const handle = await open(path, "r");
    file = handle;
    const source: ZipSource = {
      size: (await handle.stat()).size,
      readAt: async (position, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead);
      },
    };
    const entries = await zipEntries(source);
    const settings = entries.find((entry) => entry.name === COURSE_SETTINGS);
    const xml = settings ? await zipEntryText(source, settings, MAX_ENTRY_BYTES) : "";
    const dated: DueDay[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith("/assignment_settings.xml")) continue;
      const assignment = await zipEntryText(source, entry, MAX_ENTRY_BYTES);
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
