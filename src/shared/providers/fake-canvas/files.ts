import type { FileContent } from "~/shared/domain/lms";

const ascii = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

const pdfOf = (lines: readonly string[]): Uint8Array<ArrayBuffer> => {
  const escaped = lines.map((line) => line.replace(/[\\()]/g, (char) => `\\${char}`));
  const stream = `BT /F1 13 Tf 72 720 Td 18 TL ${escaped.map((line) => `(${line}) '`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const at = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return ascii(out);
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const chunk = (type: string, data: Uint8Array<ArrayBuffer>): number[] => {
  const body = new Uint8Array([...ascii(type), ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
};

/** A grayscale PNG of `width` by `height`, each pixel from `shade`, in stored (uncompressed) deflate blocks. */
const pngOf = (width: number, height: number, shade: (x: number, y: number) => number) => {
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(shade(x, y));
  }
  const zlib = [0x78, 0x01];
  for (let at = 0; at < raw.length; at += 65_535) {
    const block = raw.slice(at, at + 65_535);
    const last = at + 65_535 >= raw.length ? 1 : 0;
    zlib.push(
      last,
      block.length & 0xff,
      block.length >>> 8,
      ~block.length & 0xff,
      (~block.length >>> 8) & 0xff,
    );
    zlib.push(...block);
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  zlib.push(...u32(((b << 16) | a) >>> 0));
  const header = new Uint8Array([...u32(width), ...u32(height), 8, 0, 0, 0, 0]);
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", header),
    ...chunk("IDAT", new Uint8Array(zlib)),
    ...chunk("IEND", new Uint8Array()),
  ]);
};

const u16le = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const u32le = (n: number) => [...u16le(n & 0xffff), ...u16le(n >>> 16)];

/** A zip of stored (uncompressed) ASCII entries, which is all a test document needs. */
const zipOf = (entries: Readonly<Record<string, string>>): Uint8Array<ArrayBuffer> => {
  const local: number[] = [];
  const directory: number[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const path = ascii(name);
    const data = ascii(text);
    const sum = crc32(data);
    const sizes = [...u32le(sum), ...u32le(data.length), ...u32le(data.length)];
    const offset = local.length;
    local.push(...u32le(0x04034b50), 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...sizes);
    local.push(...u16le(path.length), 0, 0, ...path, ...data);
    directory.push(...u32le(0x02014b50), 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...sizes);
    directory.push(...u16le(path.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    directory.push(...u32le(offset), ...path);
  }
  const count = u16le(Object.keys(entries).length);
  return new Uint8Array([
    ...local,
    ...directory,
    ...u32le(0x06054b50),
    0,
    0,
    0,
    0,
    ...count,
    ...count,
    ...u32le(directory.length),
    ...u32le(local.length),
    0,
    0,
  ]);
};

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A Word document as Word writes one: a Heading 1 paragraph styled through `word/styles.xml`, then body text. */
const docxOf = (heading: string, paragraphs: readonly string[]): Uint8Array<ArrayBuffer> => {
  const paragraph = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  return zipOf({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${paragraph(heading, "Heading1")}${paragraphs.map((text) => paragraph(text)).join("")}</w:body></w:document>`,
  });
};

const notebook = (x: number, y: number): number => {
  if (x === 40) return 150;
  if (y % 24 === 0) return 190;
  const writing = y > 30 && y < 150 && x > 52 && x < 520 && (x * 7 + y * 3) % 11 < 3 && y % 24 > 6;
  return writing ? 60 : 245;
};

const webSnapshot = (x: number, y: number): number => {
  if (y < 36) return 70;
  if (y > 60 && y < 84 && x > 40 && x < 360) return 40;
  return y > 110 && y % 20 < 8 && x > 40 && x < 560 - ((y * 13) % 140) ? 120 : 250;
};

const FILES: Readonly<Record<string, () => Uint8Array<ArrayBuffer>>> = {
  "rr5-ortiz-pdf": () =>
    pdfOf([
      "Maya Ortiz - Reading Response 5",
      "",
      "The article argues that handwriting notes helps memory more than typing.",
      "I tested this during the week by writing my biology notes by hand.",
      "On Friday's quiz I remembered the diagrams better, but not the vocabulary.",
      "So I agree with the author about pictures and processes, and less about terms.",
    ]),
  "rr5-reyes-png": () => pngOf(560, 200, notebook),
  "rr5-raman-snapshot": () => pngOf(600, 260, webSnapshot),
  "rr5-wilk-docx": () =>
    docxOf("Notes by Hand", [
      "The article claims that students who take notes by hand remember more than students who type. I was skeptical, because I type faster than I write and I thought more notes would mean more learning.",
      "This week I wrote my history notes by hand. I wrote less, but I had to decide what mattered before I wrote it down, and that choice is what I remembered on Thursday's quiz.",
      "I agree with the author's main point, but I think the reason is choosing, not the pen. Typing slowly and summarizing would probably work too.",
    ]),
  "rr5-feld-txt": () =>
    ascii(
      "Reading Response 5\n\nThe article says handwriting helps memory because it forces you to slow down. I think that's true for me in math, where copying a worked example by hand makes me notice each step.\n\nIn English class it's different. When I type I can keep up with the discussion, and I'd rather have the whole conversation than a few lines.\n\nSo my answer is that it depends on the subject.\n",
    ),
  "rr5-morita-docx": () => ascii("PK\u0003\u0004 this upload was cut off partway through"),
};

export const fixtureFile = (id: string, mediaType: string): FileContent | null => {
  const draw = FILES[id];
  return draw ? { mediaType, data: draw() } : null;
};

/** The Google files the fake web shares publicly, by the export address the app asks for. Any other doc is private. */
const PUBLIC_EXPORTS: Readonly<Record<string, () => Uint8Array<ArrayBuffer>>> = {
  "https://docs.google.com/document/d/rr5-cardenas-public/export?format=pdf": () =>
    pdfOf([
      "Luis Cardenas - Reading Response 5",
      "",
      "The author claims that handwritten notes beat typed ones for memory.",
      "I kept two notebooks for a week, one typed and one by hand.",
      "The handwritten one was shorter, so I had to choose what mattered.",
      "That choosing is what I remembered, which is the article's point.",
    ]),
};

export const fixtureExport = (url: string): FileContent | null => {
  const draw = PUBLIC_EXPORTS[url];
  return draw ? { mediaType: "application/pdf", data: draw() } : null;
};

export const fixtureBytes = (id: string): number | null => FILES[id]?.().byteLength ?? null;
