import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import { documentText } from "~/main/document-text";
import { fixtureFile } from "~/shared/providers/fake-canvas/files";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url)));

/** A zip of deflated entries. The CRC is left at zero, since the reader never checks it. */
const deflatedZip = (entries: Readonly<Record<string, Buffer>>): Uint8Array => {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const packed = deflateRawSync(data);
    const path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, path, packed);
    directory.push(entry, path);
    offset += 30 + path.length + packed.length;
  }
  const listing = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, listing, end]));
};

const textOf = async (mediaType: string, data: Uint8Array) => {
  const read = await documentText(mediaType, data);
  if (!read.ok) throw new Error(read.error);
  return read.value;
};

const ESSAY = [
  "Why Sleep Matters",
  "Teenagers need more sleep than most schools allow. In this essay I argue that later start times help students learn.",
  "The evidence",
  "Studies of districts that moved the bell later found fewer tardies & better grades.",
  "- Fewer car crashes",
  "- Better moods",
  "Café owners near schools noticed too.",
].join("\n\n");

describe("reading a document's words", () => {
  it("reads a Word file TextEdit wrote as its paragraphs and list, in order", async () => {
    expect(await textOf(DOCX, fixture("essay.docx"))).toBe(ESSAY);
  });

  it("reads Word's heading styles as Markdown headings", async () => {
    const file = fixtureFile("rr5-wilk-docx", DOCX);
    if (!file) throw new Error("no fixture");
    const text = await textOf(DOCX, file.data);
    expect(text.split("\n\n")[0]).toBe("# Notes by Hand");
    expect(text.split("\n\n")[1]).toMatch(/^The article claims/);
  });

  it("reads headings by outline level, and skips deleted text and field codes", async () => {
    const document = Buffer.from(
      '<w:document><w:body><w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Method</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:del><w:r><w:delText>gone </w:delText></w:r></w:del>' +
        '<w:r><w:instrText> HYPERLINK "https://example.com" </w:instrText></w:r><w:r><w:t>&#8220;words&#x201D;</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>An item</w:t></w:r></w:p></w:body></w:document>',
    );
    expect(await textOf(DOCX, deflatedZip({ "word/document.xml": document }))).toBe(
      "## Method\n\nKept “words”\n\n- An item",
    );
  });

  it("reads an RTF file as its paragraphs, without control words", async () => {
    expect(await textOf("application/rtf", fixture("essay.rtf"))).toBe(ESSAY);
  });

  it.each<[string, Uint8Array]>([
    ["UTF-8", new Uint8Array(Buffer.from("﻿First line\r\n\r\n\r\n\r\nCafé"))],
    ["UTF-16", new Uint8Array(Buffer.from("﻿First line\n\nCafé", "utf16le"))],
    ["Windows-1252", new Uint8Array([...Buffer.from("First line\n\nCaf"), 0xe9])],
  ])("reads %s text", async (_name, data) => {
    expect(await textOf("text/plain", data)).toBe("First line\n\nCafé");
  });

  it("passes Markdown through as it is", async () => {
    const markdown = "# Title\n\nSome *emphasis*.\n\n- one";
    expect(await textOf("text/markdown", new Uint8Array(Buffer.from(markdown)))).toBe(markdown);
  });

  it.each<[string, string, Uint8Array, string]>([
    [
      "a damaged Word file",
      DOCX,
      new Uint8Array(Buffer.from("PK\u0003\u0004 cut off")),
      "Couldn't read this file.",
    ],
    [
      "a zip with no Word document in it",
      DOCX,
      deflatedZip({ "notes.txt": Buffer.from("hello") }),
      "Couldn't read this file.",
    ],
    [
      "a Word document that inflates past the cap",
      DOCX,
      deflatedZip({ "word/document.xml": Buffer.alloc(21 * 1024 * 1024, 0x20) }),
      "Couldn't read this file.",
    ],
    [
      "a binary file named as text",
      "text/plain",
      new Uint8Array([0x89, 0x50, 0x00, 0x01]),
      "Couldn't read this file.",
    ],
    [
      "something that isn't RTF",
      "application/rtf",
      new Uint8Array(Buffer.from("hello")),
      "Couldn't read this file.",
    ],
    ["an empty file", "text/plain", new Uint8Array(), "This file has no text in it."],
    [
      "a Word document with no words",
      DOCX,
      deflatedZip({ "word/document.xml": Buffer.from("<w:body><w:p/></w:body>") }),
      "This file has no text in it.",
    ],
    [
      "a file longer than the app reads",
      "text/plain",
      new Uint8Array(Buffer.alloc(400_001, "a")),
      "This file is longer than the app reads.",
    ],
  ])("refuses %s, and says why", async (_name, mediaType, data, reason) => {
    expect(await documentText(mediaType, data)).toEqual({ ok: false, error: reason });
  });
});
