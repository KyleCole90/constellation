import { describe, expect, it } from "vite-plus/test";

import { ANNOUNCEMENT_DRAFTS, REPLY_DRAFTS, REPLY_SOURCES } from "~/agent/rules/drafts";
import { SEED } from "~/providers/fake-canvas/seed";

const course = (code: string) => {
  const found = SEED.courses.find((candidate) => candidate.code === code);
  if (!found) throw new Error(`No ${code}.`);
  return found;
};
const posted = (code: string) =>
  course(code)
    .announcements.map((post) => post.body)
    .join(" ");
const dueWords = (code: string, id: string): string => {
  const due = course(code).assignments.find((assignment) => assignment.id === id)?.due;
  if (!due) throw new Error(`No ${id}.`);
  const when = new Date(due);
  const day = when.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  return `${day} at ${when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "")}`;
};
const EZRA = "Can't make the Monday screening";
const AMARA = "Is the sequence analysis graded yet?";

describe("what a seeded draft says has a source in the seed", () => {
  it("screening notes fall due after the screening, and both HUM 150 drafts give that date", () => {
    expect(
      course("HUM 150")
        .assignments.find((assignment) => assignment.id === "h150-notes")
        ?.due.localeCompare("2026-11-02T18:00"),
    ).toBe(1);
    const due = dueWords("HUM 150", "h150-notes");
    expect(due).toBe("Wednesday, Nov 4 at 11:59 PM");
    expect(REPLY_DRAFTS[EZRA]).toContain(due);
    expect(ANNOUNCEMENT_DRAFTS["HUM 150"]?.body).toContain(due);
  });

  it("the room change a whole class is told comes from a note the class hasn't seen, and the draft names that note", () => {
    const draft = ANNOUNCEMENT_DRAFTS["HUM 150"];
    const note = course("HUM 150").messages.find((message) => message.from === "Facilities");
    expect(draft?.body).toContain("Nov 2 moves to Hale Auditorium at 6 PM");
    expect(note?.body).toContain("Nov 2 moves to Hale Auditorium at 6 PM");
    expect(posted("HUM 150")).not.toContain("Hale Auditorium");
    expect(draft?.from).toBe("the note from Facilities about Hale Auditorium");
    expect(note?.answer?.text).toContain("tell the class");
    expect(draft?.say).toContain("you told Facilities you'd send");
  });

  it("Ezra's reply answers his question from a post the teacher already made, and says which", () => {
    expect(REPLY_DRAFTS[EZRA]).toContain("library's streaming page");
    expect(REPLY_DRAFTS[EZRA]).not.toMatch(/look into|write back|Monday/);
    expect(posted("HUM 150")).toContain("library's streaming page");
    expect(REPLY_SOURCES[EZRA]).toContain("your post on missed screenings");
  });

  it("Amara's reply says what the seed says about her grade, and promises no date", () => {
    const hum = course("HUM 150");
    const student = hum.students.indexOf("Amara Diallo");
    expect(
      hum.assignments.find((assignment) => assignment.id === "h150-seq")?.statuses[student],
    ).toBe("G");
    expect(REPLY_DRAFTS[AMARA]).toContain("already graded");
    expect(REPLY_DRAFTS[AMARA]).toContain(dueWords("HUM 150", "h150-resp3").split(" at ")[1]);
  });

  it("policy a reply states is in a post from that course", () => {
    expect(posted("ENG 101")).toContain("lowest two scores drop");
    expect(REPLY_DRAFTS["Can I redo Reading Response 5?"]).toContain("lowest two scores drop");
    expect(posted("COMM 110")).toContain("at least three people");
    expect(REPLY_DRAFTS["Audience requirement"]).toContain("at least three people");
    expect(posted("COMM 110")).toContain("paste the link as a text entry");
    expect(REPLY_DRAFTS["My video won't upload"]).toContain("paste the link as a text entry");
  });

  it("no announcement promises office hours or a grading date the seed doesn't hold", () => {
    for (const draft of Object.values(ANNOUNCEMENT_DRAFTS))
      expect(draft.body).not.toMatch(/office hours|grades will post|feedback will|Room \d/i);
  });

  it("the post a thread calls your last post stays the newest one", () => {
    for (const { announcements } of SEED.courses) {
      const [newest, ...rest] = announcements;
      for (const older of rest) expect(older.at < (newest?.at ?? "")).toBe(true);
    }
  });
});
