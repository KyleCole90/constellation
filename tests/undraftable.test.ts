import { describe, expect, it } from "vite-plus/test";

import {
  googleExportOf,
  linkReads,
  undraftableReason,
  type SubmissionBody,
} from "~/shared/domain/lms";

describe("which submissions Claude may draft", () => {
  const file = (name: string, mediaType: string, bytes = 4096) => ({
    id: name,
    name,
    mediaType,
    bytes,
  });

  it.each<[string, SubmissionBody]>([
    ["writing", { kind: "text", title: "", wordCount: 3, paragraphs: ["Three words here."] }],
    ["a discussion post", { kind: "discussion", title: "", wordCount: 2, paragraphs: ["Hi all."] }],
    [
      "a transcribed recording",
      { kind: "media", title: "", durationLabel: "3:00", transcript: ["Hello."] },
    ],
    ["a PDF", { kind: "upload", title: "", files: [file("essay.pdf", "application/pdf")] }],
    ["a picture", { kind: "upload", title: "", files: [file("notes.jpg", "image/jpeg")] }],
    [
      "a Word document, which main reads as text",
      {
        kind: "upload",
        title: "",
        files: [
          file(
            "rr5.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            30 * 1024 * 1024,
          ),
        ],
      },
    ],
    ["a text file", { kind: "upload", title: "", files: [file("rr5.txt", "text/plain")] }],
    ["an RTF file", { kind: "upload", title: "", files: [file("rr5.rtf", "text/rtf")] }],
    ["nothing, which is missing work", { kind: "none" }],
    [
      "a Google Doc link, which may be public",
      {
        kind: "url",
        title: "",
        url: "https://docs.google.com/document/d/abc_123-x/edit",
        files: [],
      },
    ],
    [
      "any link with a snapshot",
      {
        kind: "url",
        title: "",
        url: "https://padlet.com/me/board",
        files: [file("websnappr.png", "image/png")],
      },
    ],
  ])("drafts %s", (_name, body) => {
    expect(undraftableReason(body)).toBeNull();
  });

  it.each<[string, SubmissionBody, string]>([
    [
      "a link that isn't a Google file, with no snapshot",
      { kind: "url", title: "", url: "https://example.com", files: [] },
      "Canvas took no snapshot",
    ],
    [
      "a link whose snapshot is too big to send",
      {
        kind: "url",
        title: "",
        url: "https://example.com",
        files: [file("websnappr.png", "image/png", 6 * 1024 * 1024)],
      },
      "Canvas took no snapshot",
    ],
    ["work elsewhere", { kind: "elsewhere", title: "", what: "a quiz" }, "This is a quiz"],
    ["an upload with no file", { kind: "upload", title: "", files: [] }, "No file came"],
    [
      "a Pages document",
      {
        kind: "upload",
        title: "",
        files: [file("rr5.pages", "application/octet-stream")],
      },
      "Claude can't read rr5.pages (PAGES, 4 KB)",
    ],
    [
      "a picture over 5 MB",
      { kind: "upload", title: "", files: [file("scan.png", "image/png", 6 * 1024 * 1024)] },
      "larger than the 5 MB",
    ],
    [
      "files over 20 MB together",
      {
        kind: "upload",
        title: "",
        files: [
          file("a.pdf", "application/pdf", 12 * 1024 * 1024),
          file("b.pdf", "application/pdf", 12 * 1024 * 1024),
        ],
      },
      "larger than the 20 MB",
    ],
    [
      "a recording with no transcript",
      { kind: "media", title: "", durationLabel: "3:00", transcript: [] },
      "no transcript",
    ],
  ])("refuses %s, and says why", (_name, body, why) => {
    expect(undraftableReason(body)).toContain(why);
  });
});

describe("what Claude reads of a link (#71)", () => {
  it.each([
    [
      "https://docs.google.com/document/d/1AbC-d_9/edit?usp=sharing",
      "Google Doc",
      "https://docs.google.com/document/d/1AbC-d_9/export?format=pdf",
    ],
    [
      "http://docs.google.com/presentation/u/1/d/1AbC/view#slide=2",
      "Google Slides deck",
      "https://docs.google.com/presentation/d/1AbC/export/pdf",
    ],
    [
      "https://DOCS.google.com/spreadsheets/d/1AbC",
      "Google Sheet",
      "https://docs.google.com/spreadsheets/d/1AbC/export?format=pdf",
    ],
  ])("exports %s as a PDF from Google's own https host", (url, what, exported) => {
    expect(googleExportOf(url)).toEqual({ what, url: exported });
  });

  it.each([
    "https://docs.google.com.evil.example/document/d/1AbC/edit",
    "https://evil.example/?u=https://docs.google.com/document/d/1AbC",
    "https://docs.google.com/forms/d/1AbC/viewform",
    "https://drive.google.com/file/d/1AbC/view",
    "javascript:alert(1)//docs.google.com/document/d/1AbC",
    "file:///docs.google.com/document/d/1AbC",
  ])("exports nothing for %s", (url) => {
    expect(googleExportOf(url)).toBeNull();
  });

  it("tries the doc's export before the snapshot, which is only the first screen", () => {
    expect(
      linkReads({
        kind: "url",
        title: "",
        url: "https://docs.google.com/document/d/1AbC/edit",
        files: [{ id: "9", name: "websnappr.png", mediaType: "image/png", bytes: 90_000 }],
      }),
    ).toEqual(["export", "snapshot"]);
  });
});
