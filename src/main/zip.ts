import { inflateRawSync } from "node:zlib";

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
/** The end record is 22 bytes, after a comment of at most 65,535. */
const TAIL_BYTES = 22 + 0xffff;

/** A zip's bytes, read a slice at a time, so a large archive on disk is never read whole. */
export interface ZipSource {
  size: number;
  readAt: (position: number, length: number) => Promise<Buffer>;
}

export interface ZipEntry {
  name: string;
  method: number;
  size: number;
  offset: number;
}

export const bufferSource = (data: Uint8Array): ZipSource => {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    size: buffer.length,
    readAt: async (position, length) => buffer.subarray(position, position + length),
  };
};

/** The archive's table of contents. Throws on anything that isn't a plain zip. */
export const zipEntries = async (source: ZipSource): Promise<readonly ZipEntry[]> => {
  const tailStart = Math.max(0, source.size - TAIL_BYTES);
  const tail = await source.readAt(tailStart, source.size - tailStart);
  let end = tail.length - 22;
  while (end >= 0 && tail.readUInt32LE(end) !== END_OF_DIRECTORY) end -= 1;
  if (end < 0) throw new Error("no zip directory");
  const directory = await source.readAt(tail.readUInt32LE(end + 16), tail.readUInt32LE(end + 12));
  const entries: ZipEntry[] = [];
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

/** An entry's text, unpacked. Throws past `maxBytes` either side of inflating, so a zip bomb stops at the cap. */
export const zipEntryText = async (
  source: ZipSource,
  entry: ZipEntry,
  maxBytes: number,
): Promise<string> => {
  if (entry.size > maxBytes) throw new Error("entry too large");
  const local = await source.readAt(entry.offset, 30);
  if (local.readUInt32LE(0) !== LOCAL_ENTRY) throw new Error("bad zip entry");
  const data = await source.readAt(
    entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
    entry.size,
  );
  if (entry.method === 0) return data.toString("utf8");
  if (entry.method === 8)
    return inflateRawSync(data, { maxOutputLength: maxBytes }).toString("utf8");
  throw new Error("unsupported zip compression");
};
