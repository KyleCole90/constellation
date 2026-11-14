import type { Result } from "../shared/domain/ids";

import { bufferSource, zipEntries, zipEntryText, type ZipSource } from "./zip";

const MB = 1024 * 1024;
/** `word/document.xml` is markup around the words, so a long paper's is a few MB. Past this it's not a paper. */
const MAX_XML_BYTES = 20 * MB;
/** About 70,000 words, far past any paper, and well inside what one request to Claude can hold. */
const MAX_CHARS = 400_000;

const UNREADABLE = "Couldn't read this file.";
const EMPTY = "This file has no text in it.";
const TOO_LONG = "This file is longer than the app reads.";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const cp1252 = new TextDecoder("windows-1252");

/** A paragraph that starts with a typed bullet, as TextEdit writes a list item: "\t•\tFewer car crashes". */
const BULLET = /^[\t ]*[•◦▪‣·*-][\t ]+/;

/** Paragraphs as Markdown: headings get `#`, list items `- `, and empty paragraphs go. */
const markdownOf = (
  paragraphs: readonly { text: string; heading?: number; listed?: boolean }[],
): string =>
  paragraphs
    .flatMap(({ text, heading, listed }) => {
      if (text.trim() === "") return [];
      if (heading) return [`${"#".repeat(heading)} ${text.trim()}`];
      if (listed || BULLET.test(text)) return [`- ${text.replace(BULLET, "").trim()}`];
      return [text];
    })
    .join("\n\n");

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const decodeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (!name.startsWith("#")) return XML_ENTITIES[name] ?? whole;
    const code =
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

/** "heading 2", or the style id "Heading2", is level 2; a title is 1 and a subtitle 2. */
const levelNamed = (name: string): number | undefined => {
  const heading = /^heading\s*([1-6])$/i.exec(name)?.[1];
  if (heading) return Number(heading);
  if (/^title$/i.test(name)) return 1;
  if (/^subtitle$/i.test(name)) return 2;
  return undefined;
};

/** Word's outline levels count from 0; 9 is body text. */
/**
 * The inside of each `<tag ...>…</tag>`, found in one pass. A regex that looks ahead for the closing tag goes
 * quadratic on a file full of tags that never close.
 */
const elements = (xml: string, tag: string): { open: string; body: string }[] =>
  xml
    .split(`</${tag}>`)
    .slice(0, -1)
    .flatMap((chunk) => {
      const start = Math.max(chunk.lastIndexOf(`<${tag}>`), chunk.lastIndexOf(`<${tag} `));
      const end = start < 0 ? -1 : chunk.indexOf(">", start);
      return end < 0 ? [] : [{ open: chunk.slice(start, end), body: chunk.slice(end + 1) }];
    });

const outlineLevel = (xml: string): number | undefined => {
  const level = /<w:outlineLvl w:val="(\d)"/.exec(xml)?.[1];
  return level !== undefined && Number(level) < 6 ? Number(level) + 1 : undefined;
};

const headingStyles = (styles: string): Map<string, number> => {
  const levels = new Map<string, number>();
  for (const { open, body } of elements(styles, "w:style")) {
    const id = /w:styleId="([^"]{0,200})"/.exec(open)?.[1];
    const name = /<w:name w:val="([^"]{0,200})"/.exec(body)?.[1];
    const level = (name === undefined ? undefined : levelNamed(name)) ?? outlineLevel(body);
    if (id !== undefined && level !== undefined) levels.set(id, level);
  }
  return levels;
};

/** Only the words a reader sees: `w:t` runs, not deletions (`w:delText`) or field codes (`w:instrText`). */
const runsOf = (paragraph: string): string => {
  let text = "";
  for (const [token, words] of paragraph.matchAll(
    /<w:t(?:\s[^>]{0,200})?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]{0,200}\/>/g,
  )) {
    if (words !== undefined) text += decodeXml(words);
    else text += token === "<w:tab/>" ? "\t" : "\n";
  }
  return text;
};

/** Reads two entries as text and nothing else, so macros, embedded objects and outside links never run or load. */
const docxText = async (source: ZipSource): Promise<string | null> => {
  const entries = await zipEntries(source);
  const document = entries.find((entry) => entry.name === "word/document.xml");
  if (!document) return null;
  const xml = await zipEntryText(source, document, MAX_XML_BYTES);
  const stylesEntry = entries.find((entry) => entry.name === "word/styles.xml");
  const styles = headingStyles(
    stylesEntry ? await zipEntryText(source, stylesEntry, MAX_XML_BYTES) : "",
  );
  const paragraphs = elements(xml, "w:p").map(({ body }) => {
    const style = /<w:pStyle w:val="([^"]{0,200})"/.exec(body)?.[1];
    const heading =
      (style === undefined ? undefined : (styles.get(style) ?? levelNamed(style))) ??
      outlineLevel(body);
    return {
      text: runsOf(body),
      ...(heading === undefined ? {} : { heading }),
      listed: /<w:numPr\b/.test(body),
    };
  });
  return markdownOf(paragraphs);
};

/** Groups whose words aren't the document's: tables of fonts and colors, metadata, pictures, headers and footers. */
const RTF_SKIPPED = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "header",
  "headerl",
  "headerr",
  "headerf",
  "footer",
  "footerl",
  "footerr",
  "footerf",
  "listtable",
  "listoverridetable",
  "themedata",
  "colorschememapping",
  "datastore",
  "latentstyles",
  "rsidtbl",
  "fldinst",
  "xmlnstbl",
]);

const RTF_SYMBOLS: Readonly<Record<string, string>> = {
  tab: "\t",
  cell: "\t",
  line: "\n",
  emdash: "—",
  endash: "–",
  bullet: "•",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
};
const RTF_BREAKS = new Set(["par", "sect", "page", "row"]);

const rtfText = (rtf: string): string | null => {
  if (!rtf.startsWith("{\\rtf")) return null;
  const paragraphs: string[] = [];
  let current = "";
  let group = { skip: false, uc: 1 };
  const outer: (typeof group)[] = [];
  let at = 0;
  const add = (text: string) => {
    if (!group.skip) current += text;
  };
  const brk = () => {
    if (group.skip) return;
    paragraphs.push(current);
    current = "";
  };
  /** Steps past one control word, symbol or character, as `\ucN` counts what to skip after a `\u`. */
  const skipOne = () => {
    if (rtf[at] !== "\\") {
      at += 1;
      return;
    }
    if (rtf[at + 1] === "'") {
      at += 4;
      return;
    }
    const word = /^\\[a-z]+-?\d* ?/i.exec(rtf.slice(at, at + 40));
    at += word ? word[0].length : 2;
  };
  while (at < rtf.length) {
    const char = rtf[at] ?? "";
    if (char === "{") {
      outer.push(group);
      group = { skip: group.skip, uc: group.uc };
      at += 1;
    } else if (char === "}") {
      group = outer.pop() ?? group;
      at += 1;
    } else if (char === "\r" || char === "\n") {
      at += 1;
    } else if (char !== "\\") {
      add(char);
      at += 1;
    } else {
      const next = rtf[at + 1] ?? "";
      const word = /^([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(at + 1, at + 64));
      if (word) {
        at += 1 + word[0].length;
        const [, name = "", digits] = word;
        const value = digits === undefined ? undefined : Number(digits);
        if (RTF_SKIPPED.has(name)) group.skip = true;
        else if (RTF_BREAKS.has(name)) brk();
        else if (name === "uc" && value !== undefined) group.uc = value;
        else if (name === "u" && value !== undefined) {
          add(String.fromCharCode(value < 0 ? value + 65_536 : value));
          for (let left = group.uc; left > 0 && at < rtf.length; left--) {
            if (rtf[at] === "{" || rtf[at] === "}") break;
            skipOne();
          }
        } else if (name === "bin" && value !== undefined) at += Math.max(0, value);
        else {
          const symbol = RTF_SYMBOLS[name];
          if (symbol !== undefined) add(symbol);
        }
      } else if (next === "'") {
        add(cp1252.decode(Uint8Array.of(parseInt(rtf.slice(at + 2, at + 4), 16) || 0x3f)));
        at += 4;
      } else {
        at += 2;
        if (next === "\\" || next === "{" || next === "}") add(next);
        else if (next === "~") add(" ");
        else if (next === "_") add("-");
        else if (next === "\n" || next === "\r") brk();
        else if (next === "*") group.skip = true;
      }
    }
  }
  paragraphs.push(current);
  return markdownOf(paragraphs.map((text) => ({ text })));
};

/** UTF-8 first, or UTF-16 by its byte order mark; text that is neither is read as Windows' Western encoding. */
const plainText = (data: Uint8Array): string | null => {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  if (data.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return cp1252.decode(data);
  }
};

const textOf = async (mediaType: string, data: Uint8Array): Promise<string | null> => {
  switch (mediaType) {
    case DOCX:
      return docxText(bufferSource(data));
    case "application/rtf":
    case "text/rtf":
      return rtfText(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1"));
    case "text/plain":
    case "text/markdown":
    case "text/x-markdown":
      return plainText(data);
    default:
      return null;
  }
};

/**
 * The words in a Word, RTF, text or Markdown file, as Markdown: paragraphs apart by a blank line, headings with `#`,
 * list items with `- `. The error is a sentence for the teacher.
 */
export const documentText = async (
  mediaType: string,
  data: Uint8Array,
): Promise<Result<string, string>> => {
  let text: string | null;
  try {
    text = await textOf(mediaType, data);
  } catch {
    text = null;
  }
  if (text === null) return { ok: false, error: UNREADABLE };
  const tidy = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (tidy === "") return { ok: false, error: EMPTY };
  if (tidy.length > MAX_CHARS) return { ok: false, error: TOO_LONG };
  return { ok: true, value: tidy };
};
