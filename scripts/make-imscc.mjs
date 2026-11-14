// Writes the sample .imscc packages the fake LMS offers. Each is a real zip holding an imsmanifest.xml, so a
// person can open one and see what a Common Cartridge looks like. Content is invented, and the names must
// match samplePackages() in src/shared/providers/fake-canvas/seed-term.ts. Run: node scripts/make-imscc.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "imscc");

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const encoder = new TextEncoder();

/** A deflated zip, as Canvas writes its exports. Small enough to read here. */
const zip = (entries) => {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, text } of entries) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    const header = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(8),
      ...u16(0),
      ...u16(0x21),
      ...u32(crc),
      ...u32(data.length),
      ...u32(raw.length),
      ...u16(nameBytes.length),
      ...u16(0),
    ];
    local.push(Uint8Array.from(header), nameBytes, data);
    central.push(
      Uint8Array.from([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(8),
        ...u16(0),
        ...u16(0x21),
        ...u32(crc),
        ...u32(data.length),
        ...u32(raw.length),
        ...u16(nameBytes.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      nameBytes,
    );
    offset += header.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);
  const parts = [...local, ...central, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const manifest = (title, resources) => `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${title.replace(/\W+/g, "_")}" xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1" xmlns:lom="http://ltsc.ieee.org/xsd/imsccv1p1/LOM/resource">
  <metadata>
    <schema>IMS Common Cartridge</schema>
    <schemaversion>1.1.0</schemaversion>
    <lom:lom><lom:general><lom:title><lom:string>${title}</lom:string></lom:title></lom:general></lom:lom>
  </metadata>
  <organizations>
    <organization identifier="org_1" structure="rooted-hierarchy">
      <item identifier="root">${resources.map((r, i) => `<item identifier="item_${i + 1}" identifierref="${r.id}"><title>${r.title}</title></item>`).join("")}</item>
    </organization>
  </organizations>
  <resources>
    ${resources.map((r) => `<resource identifier="${r.id}" type="${r.type}" href="${r.href}"><file href="${r.href}"/></resource>`).join("\n    ")}
  </resources>
</manifest>
`;

/** Canvas's own course settings file. Its dates are in the course's time zone, with no offset. */
const courseSettings = (title, { start, conclude }) => `<?xml version="1.0" encoding="UTF-8"?>
<course identifier="settings" xmlns="http://canvas.instructure.com/xsd/cccv1p0">
  <title>${title}</title>
  <start_at>${start}T08:00:00</start_at>
  ${conclude ? `<conclude_at>${conclude}T23:59:00</conclude_at>` : "<conclude_at/>"}
</course>
`;

const assignmentSettings = (title, due) => `<?xml version="1.0" encoding="UTF-8"?>
<assignment identifier="${title.replace(/\W+/g, "_")}" xmlns="http://canvas.instructure.com/xsd/cccv1p0">
  <title>${title}</title>
  <due_at>${due}T23:59:00</due_at>
</assignment>
`;

const page = (title, body) =>
  `<html><head><title>${title}</title></head><body>${body}</body></html>`;

const PACKAGES = [
  {
    name: "comm110-lakeshore-fall2026-export.imscc",
    title: "COMM 110 Public Speaking, Fall 2026",
    pages: [
      [
        "syllabus",
        "Syllabus",
        "<p>Welcome to COMM 110, Fall 2026. Speeches are delivered in class on Tuesdays and Thursdays.</p>",
      ],
      ["course-policies", "Course Policies", "<p>Attendance is required on speech days.</p>"],
    ],
    settings: { start: "2026-08-24", conclude: "2026-12-11" },
    assignments: [
      ["Informative Speech", "2026-09-15"],
      ["Persuasive Speech", "2026-10-22"],
    ],
  },
  {
    name: "eng210-northgate-spring2026-export.imscc",
    title: "ENG 210 Intro to Literature, Spring 2026 (Northgate College)",
    pages: [
      [
        "syllabus",
        "Syllabus",
        "<p>Welcome to ENG 210, Spring 2026. Questions go to kyle@northgate.edu.</p>",
      ],
      [
        "reading-schedule",
        "Reading Schedule",
        "<p>Week 1: short fiction. Week 2: lyric poetry.</p>",
      ],
    ],
  },
  {
    name: "damaged-export.imscc",
    title: "Damaged export",
    pages: [["syllabus", "Syllabus", "<p>This package is missing most of its files.</p>"]],
    // A real export often leaves the end out, so the teacher types only that.
    settings: { start: "2026-01-20", conclude: null },
    missing: true,
  },
];

mkdirSync(OUT, { recursive: true });
for (const pkg of PACKAGES) {
  const resources = pkg.pages.map(([slug, title]) => ({
    id: `res_${slug}`,
    title,
    type: "webcontent",
    href: `wiki_content/${slug}.html`,
  }));
  if (pkg.missing)
    resources.push({
      id: "res_missing",
      title: "Course Files",
      type: "webcontent",
      href: "web_resources/readings.pdf",
    });
  const entries = [
    { name: "imsmanifest.xml", text: manifest(pkg.title, resources) },
    ...pkg.pages.map(([slug, title, body]) => ({
      name: `wiki_content/${slug}.html`,
      text: page(title, body),
    })),
    ...(pkg.settings
      ? [
          {
            name: "course_settings/course_settings.xml",
            text: courseSettings(pkg.title, pkg.settings),
          },
        ]
      : []),
    ...(pkg.assignments ?? []).map(([title, due], index) => ({
      name: `assignment_${index + 1}/assignment_settings.xml`,
      text: assignmentSettings(title, due),
    })),
  ];
  writeFileSync(join(OUT, pkg.name), zip(entries));
  console.log(`wrote ${pkg.name}`);
}
