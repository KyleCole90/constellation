import { describe, expect, it } from "vite-plus/test";

import { undraftableReason, type SubmissionBody } from "~/shared/domain/lms";

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
  ])("drafts %s", (_name, body) => {
    expect(undraftableReason(body)).toBeNull();
  });

  it.each<[string, SubmissionBody, string]>([
    [
      "a link",
      { kind: "url", title: "", url: "https://example.com", files: [] },
      "can't open links",
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
