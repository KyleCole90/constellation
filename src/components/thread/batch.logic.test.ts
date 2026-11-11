import { describe, expect, it } from "vite-plus/test";

import type { ChangeContent, ChangeSummary, GradeContent } from "~/domain/change";
import type { ChangeId } from "~/domain/ids";

import {
  batchPhase,
  identicalDrafts,
  identicalNote,
  laneMessage,
  outcomeSummary,
  retryTargets,
} from "./batch.logic";

const summary = (patch: Partial<ChangeSummary>) =>
  ({
    tone: "approval",
    sentAt: null,
    canSend: false,
    banner: null,
    waitingOnReconnect: false,
    ...patch,
  }) as ChangeSummary;
const SENT = summary({ tone: "done", sentAt: "t" as never });
const STUCK = summary({ tone: "attention", canSend: true, banner: "partial" });
const WAITING = summary({
  tone: "attention",
  canSend: true,
  banner: "reconnect",
  waitingOnReconnect: true,
});
const WORKING = summary({ tone: "working" });
const READY = summary({ tone: "ready", canSend: true });

describe("batchPhase", () => {
  const idle = (summary: ChangeSummary) => ({ summary, busy: false });
  const busy = (summary: ChangeSummary) => ({ summary, busy: true });

  it("is review while nothing has been tried", () => {
    expect(batchPhase([idle(summary({})), idle(READY)])).toBe("review");
  });

  it("the first read before a send starts still counts as sending", () => {
    expect(batchPhase([busy(READY)])).toBe("sending");
  });

  it("any item in flight keeps it sending, whatever has already finished", () => {
    expect(batchPhase([idle(SENT), idle(WORKING)])).toBe("sending");
  });

  it("is outcome once something sent or got stuck", () => {
    expect(batchPhase([idle(SENT), idle(READY)])).toBe("outcome");
    expect(batchPhase([idle(STUCK)])).toBe("outcome");
  });

  it("is outcome once every item has sent, while the send call still syncs the schools", () => {
    expect(batchPhase([busy(SENT), busy(SENT)])).toBe("outcome");
    expect(batchPhase([busy(SENT), busy(STUCK)])).toBe("outcome");
  });
});

describe("outcomeSummary", () => {
  it("counts each result once, keeping reconnect apart from other trouble", () => {
    expect(outcomeSummary([SENT, SENT, SENT, STUCK, WAITING])).toBe(
      "3 sent, 1 needs attention, 1 waiting on reconnect",
    );
  });

  it("leaves out what didn't happen", () => {
    expect(outcomeSummary([SENT])).toBe("1 sent");
  });
});

describe("retryTargets", () => {
  it("leaves out a write that could post twice and one the LMS would refuse again", () => {
    const inDoubt = summary({ tone: "attention", canSend: true, banner: "in-doubt" });
    const rejected = summary({ tone: "attention", canSend: true, banner: "rejected" });
    expect(retryTargets(items([inDoubt, rejected, STUCK]))).toEqual(["c2"]);
  });

  const items = (list: readonly ChangeSummary[]) =>
    list.map((s, i) => ({ id: `c${i}` as ChangeId, summary: s }));

  it("takes held changes and those left approved, and skips the sent", () => {
    expect(retryTargets(items([SENT, STUCK, READY]))).toEqual(["c1", "c2"]);
  });

  it("skips a change still waiting on its token, since it could only fail the same way", () => {
    expect(retryTargets(items([WAITING]))).toEqual([]);
  });

  it("takes that same change once its school is back", () => {
    expect(retryTargets(items([{ ...WAITING, waitingOnReconnect: false }]))).toEqual(["c0"]);
  });
});

describe("laneMessage", () => {
  it("uses the school's short name and rounds up to whole seconds", () => {
    expect(laneMessage("Lakeshore Community College", 3100, 1000)).toBe(
      "Lakeshore asked us to slow down, resuming in 3s",
    );
  });

  it("never promises zero seconds", () => {
    expect(laneMessage("Riverbend State", 1000, 1000)).toContain("in 1s");
  });
});

const grade = (scores: readonly number[], comment: string | null): GradeContent =>
  ({
    kind: "grade",
    points: null,
    outOf: 100,
    rubric: scores.map((points, i) => ({ criterion: `c${i}`, name: `C${i}`, points, outOf: 30 })),
    late: null,
    comment,
    attachment: null,
  }) as unknown as GradeContent;
const draft = (student: string, content: ChangeContent) => ({ student, content });
const students = (groups: readonly (readonly { student: string }[])[]) =>
  groups.map((group) => group.map((d) => d.student));

describe("identicalDrafts", () => {
  it("groups drafts whose scores match and whose feedback differs only by the student's name", () => {
    const groups = students(
      identicalDrafts([
        draft("Aaliyah Brooks", grade([22, 20, 26, 16], "Aaliyah, your thesis is clear.")),
        draft("Mateo Quiroga", grade([25, 20, 26, 16], "Mateo, your thesis is clear.")),
        draft("Hannah Stroud", grade([22, 20, 26, 16], "Hannah, your thesis is clear.")),
      ]),
    );
    expect(groups).toEqual([["Aaliyah Brooks", "Hannah Stroud"]]);
  });

  it("does not match a draft whose total the teacher overrode", () => {
    expect(
      students(
        identicalDrafts([
          draft("Aaliyah Brooks", { ...grade([22, 20], "Aaliyah, good."), override: 45 }),
          draft("Hannah Stroud", grade([22, 20], "Hannah, good.")),
        ]),
      ),
    ).toEqual([]);
  });

  it("still matches when one student is late, because the penalty comes from the submission, not the draft", () => {
    const late = {
      ...grade([22, 20], "Aaliyah, good."),
      late: { days: 2, pointsPerDay: 2.5, waived: false },
    };
    expect(
      students(
        identicalDrafts([
          draft("Aaliyah Brooks", late),
          draft("Hannah Stroud", grade([22, 20], "Hannah, good.")),
        ]),
      ),
    ).toEqual([["Aaliyah Brooks", "Hannah Stroud"]]);
  });

  it("masks names with accented letters", () => {
    expect(
      students(
        identicalDrafts([
          draft("José Álvarez", grade([20], "José, your thesis is clear.")),
          draft("Zoë Chen", grade([20], "Zoë, your thesis is clear.")),
        ]),
      ),
    ).toEqual([["José Álvarez", "Zoë Chen"]]);
  });

  it("leaves a surname that is also an ordinary word alone", () => {
    expect(
      students(
        identicalDrafts([
          draft("Nia Strong", grade([20], "Strong evidence, Nia.")),
          draft("Leo Park", grade([20], "Strong evidence, Leo.")),
        ]),
      ),
    ).toEqual([["Nia Strong", "Leo Park"]]);
  });

  it("keeps drafts on different assignments apart even when scores and feedback match", () => {
    const other = { ...grade([20], "Aaliyah, good."), outOf: 50 };
    expect(
      students(
        identicalDrafts([
          draft("Aaliyah Brooks", grade([20], "Aaliyah, good.")),
          draft("Aaliyah Brooks", other),
        ]),
      ),
    ).toEqual([]);
  });

  it("does not flag matching scores when the feedback differs", () => {
    expect(
      students(
        identicalDrafts([
          draft("Aaliyah Brooks", grade([30, 30], "Aaliyah, strong close reading.")),
          draft("Hannah Stroud", grade([30, 30], "Hannah, tighten the second paragraph.")),
        ]),
      ),
    ).toEqual([]);
  });

  it("needs feedback to call two drafts the same, since a bare score often repeats", () => {
    expect(
      identicalDrafts([draft("A B", grade([30, 30], null)), draft("C D", grade([30, 30], " "))]),
    ).toEqual([]);
  });

  it("ignores changes that are not grades", () => {
    const reply = { kind: "reply", target: "x", body: "Thanks!" } as unknown as ChangeContent;
    expect(identicalDrafts([draft("A B", reply), draft("C D", reply)])).toEqual([]);
  });
});

describe("identicalNote", () => {
  it("names each group in one sentence", () => {
    expect(identicalNote(["Aaliyah Brooks", "Hannah Stroud"])).toBe(
      "Aaliyah Brooks and Hannah Stroud have identical drafts",
    );
    expect(identicalNote(["A", "B", "C"])).toBe("A, B and C have identical drafts");
  });
});
