// Renders bench/pages into the files bench/files commits (#85): `x.pdf.html` printed to a Letter PDF, `x.png.html` as a
// full-page picture 1200 px wide, `x.shot.html` as the first 1280x800 screen a link's snapshot shows, `x.md` copied, and
// `x.docx.md` as a Word file. Rerun after editing a page: `node scripts/make-bench-fixtures.mjs`.
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { chromium } from "playwright";

const ROOT = join(import.meta.dirname, "..", "bench");
const PAGES = join(ROOT, "pages");
const FILES = join(ROOT, "files");
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Headings, paragraphs and `- ` lists: all a bench page uses, and all the app's Word reader needs to see. */
const documentXml = (markdown) => {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .flatMap((block) => block.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      const item = /^-\s+(.*)$/.exec(line);
      const [props, text] = heading
        ? [`<w:pPr><w:pStyle w:val="Heading${heading[1].length}"/></w:pPr>`, heading[2]]
        : item
          ? [`<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>`, item[1]]
          : ["", line];
      return `<w:p>${props}<w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;
    });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}</w:body></w:document>`;
};

/** A stored (uncompressed) zip: enough for a docx, with no dependency. */
const zip = (entries) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
};

const docx = (markdown) =>
  zip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ],
    ["word/document.xml", documentXml(markdown)],
  ]);

await mkdir(FILES, { recursive: true });
const names = (await readdir(PAGES)).sort();
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage();
  for (const name of names) {
    const source = join(PAGES, name);
    const [, base, kind] = /^(.*?)\.(pdf\.html|png\.html|shot\.html|docx\.md|md)$/.exec(name) ?? [];
    if (!kind) throw new Error(`${name}: not a page kind this script renders`);
    if (kind === "md") await copyFile(source, join(FILES, `${base}.md`));
    else if (kind === "docx.md")
      await writeFile(join(FILES, `${base}.docx`), docx(await readFile(source, "utf8")));
    else {
      const shot = kind === "shot.html";
      await page.setViewportSize(
        shot ? { width: 1280, height: 800 } : { width: 1200, height: 800 },
      );
      await page.goto(`file://${source}`);
      if (kind === "pdf.html")
        await page.pdf({ path: join(FILES, `${base}.pdf`), preferCSSPageSize: true });
      else await page.screenshot({ path: join(FILES, `${base}.png`), fullPage: !shot });
    }
    console.log(`${name} → bench/files`);
  }
} finally {
  await browser.close();
}
