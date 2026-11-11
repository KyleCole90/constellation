import { describe, expect, it } from "vite-plus/test";

import { ApprovalWitness, fingerprintOf } from "~/shared/domain/approval";
import {
  applyPatch,
  classify,
  editedByYou,
  fieldsOf,
  finalGrade,
  fitContent,
  newChangeRecord,
  summarize,
  transition,
  type ChangeEvent,
  type ChangePatch,
  type ChangeRecord,
  unfilled,
  zeroPatch,
  type GradeContent,
  type RemoteState,
} from "~/shared/domain/change";
import type { LmsRef } from "~/shared/domain/ids";
import { SendPermit, mintSendPermit } from "~/shared/domain/permit";

import {
  AT,
  CRITERION,
  SUBMISSION,
  approved,
  clickWitness,
  conflicted,
  discarded,
  gradeContent,
  gradeRemote,
  held,
  newDraft,
  sending,
  sent,
  step,
} from "./fixtures/changes";

const EDIT: ChangeEvent = {
  type: "edit",
  by: "you",
  patch: { kind: "grade", comment: "Edited." },
  at: AT,
};

const events = (record: ChangeRecord): Readonly<Record<string, ChangeEvent>> => ({
  edit: EDIT,
  approve: { type: "approve", witness: clickWitness(record), at: AT },
  revoke: { type: "revoke", at: AT },
  "resolve-conflict": { type: "resolve-conflict", choices: {}, remote: gradeRemote(), at: AT },
  discard: { type: "discard", at: AT },
  "begin-send": { type: "begin-send", seen: {}, at: AT },
  "field-outcomes": {
    type: "field-outcomes",
    outcomes: { grade: { status: "landed", at: AT, via: "response" } },
    at: AT,
  },
  wait: { type: "wait", until: 1 },
  hold: { type: "hold", cause: { tag: "reconnect" }, at: AT },
  conflict: { type: "conflict", conflicts: [], at: AT },
  finish: { type: "finish", at: AT },
  interrupt: { type: "interrupt", at: AT },
});

const STATES: Readonly<
  Record<ChangeRecord["state"]["tag"], { build: () => ChangeRecord; allowed: readonly string[] }>
> = {
  draft: { build: () => newDraft(), allowed: ["edit", "approve", "discard"] },
  approved: {
    build: () => approved(),
    allowed: ["edit", "revoke", "discard", "begin-send", "hold", "conflict"],
  },
  sending: {
    build: () => sending(),
    allowed: ["field-outcomes", "wait", "hold", "conflict", "finish", "interrupt"],
  },
  held: {
    build: () => held(),
    allowed: ["edit", "revoke", "discard", "begin-send", "hold", "conflict"],
  },
  conflicted: { build: () => conflicted(), allowed: ["resolve-conflict", "discard"] },
  sent: { build: () => sent(), allowed: [] },
  discarded: { build: () => discarded(), allowed: [] },
};

describe("legal and illegal transitions", () => {
  for (const [tag, { build, allowed }] of Object.entries(STATES)) {
    for (const name of Object.keys(events(newDraft()))) {
      const legal = allowed.includes(name);
      it(`${name} from ${tag} is ${legal ? "accepted" : "rejected"}`, () => {
        const record = build();
        const event = events(record)[name] as ChangeEvent;
        const result = transition(record, event);
        expect(result.ok).toBe(legal);
        if (!result.ok) expect(result.error).toMatch(/^(not-|stale-|field-)/);
      });
    }
  }

  it("annotate never moves the state from anywhere", () => {
    for (const { build } of Object.values(STATES)) {
      const record = build();
      const next = step(record, {
        type: "annotate",
        rationale: { field: "x", why: "y", anchors: [] },
        at: AT,
      });
      expect(next.state).toEqual(record.state);
      expect(next.rationale).toHaveLength(1);
      expect(fingerprintOf(next)).toBe(fingerprintOf(record));
    }
  });

  it("no sequence of events reaches approved, sending, held, or sent without a genuine witness", () => {
    const seen = new Map<string, ChangeRecord>([["draft", newDraft()]]);
    const forged = { covers: () => true, via: "button" } as unknown as ApprovalWitness;
    const queue = [newDraft()];
    while (queue.length > 0) {
      const record = queue.shift() as ChangeRecord;
      const all = {
        ...events(record),
        approve: { type: "approve", witness: forged, at: AT } as ChangeEvent,
      };
      for (const event of Object.values(all)) {
        const next = transition(record, event);
        if (next.ok && !seen.has(next.value.state.tag)) {
          seen.set(next.value.state.tag, next.value);
          queue.push(next.value);
        }
      }
    }
    expect([...seen.keys()].sort()).toEqual(["discarded", "draft"]);
  });
});

describe("who started a change", () => {
  it("says the agent drafted it only when the agent did", () => {
    const draft = newDraft();
    expect(draft.activity[0]?.text).toBe("Drafted");
    expect(newChangeRecord({ ...draft, at: AT, by: "you" }).activity[0]?.text).toBe("Started");
  });

  it("says you edited an AI draft once you have", () => {
    expect(summarize(newDraft()).label).toBe("AI draft. Not sent");
    expect(summarize(step(newDraft(), { ...EDIT, by: "agent" })).label).toBe("AI draft. Not sent");
    expect(summarize(step(newDraft(), EDIT)).label).toBe("AI draft, edited by you. Not sent");
  });

  it("counts what you wrote as your edits, not approving or undoing an approval", () => {
    const draft = newDraft();
    const undone = step(step(draft, { type: "approve", witness: clickWitness(draft), at: AT }), {
      type: "revoke",
      at: AT,
    });
    expect(editedByYou(undone)).toBe(false);
    expect(editedByYou(step(undone, EDIT))).toBe(true);
    expect(editedByYou(step(approved(), EDIT))).toBe(true);
    expect(editedByYou(newChangeRecord({ ...draft, at: AT, by: "you" }))).toBe(true);
  });
});

describe("edits reset approval", () => {
  it("an edit by you from approved goes back to draft and says why", () => {
    const next = step(approved(), EDIT);
    expect(next.state).toEqual({ tag: "draft", approvalReset: "edited" });
    expect(summarize(next).label).toBe("Needs approval again");
  });

  it("an edit by the agent from approved records that the agent caused the reset", () => {
    const next = step(approved(), { ...EDIT, by: "agent" });
    expect(next.state).toEqual({ tag: "draft", approvalReset: "agent-edited" });
  });

  it("an edit changes the fingerprint", () => {
    expect(fingerprintOf(step(newDraft(), EDIT))).not.toBe(fingerprintOf(newDraft()));
  });
});

describe("the approval witness", () => {
  const rejected = (witness: unknown, record: ChangeRecord = newDraft()) =>
    transition(record, { type: "approve", witness: witness as ApprovalWitness, at: AT });

  it("a plain object with a lying covers method is rejected", () => {
    expect(rejected({ covers: () => true, via: "button" })).toEqual({
      ok: false,
      error: "stale-approval",
    });
  });

  it("a JSON copy of a real witness is rejected", () => {
    expect(rejected(JSON.parse(JSON.stringify(clickWitness(newDraft()))))).toEqual({
      ok: false,
      error: "stale-approval",
    });
  });

  it("an object built from the witness prototype is rejected", () => {
    expect(rejected(Object.create(ApprovalWitness.prototype))).toEqual({
      ok: false,
      error: "stale-approval",
    });
  });

  it("an untrusted click mints nothing", () => {
    const record = newDraft();
    expect(
      ApprovalWitness.fromClick({ isTrusted: false, type: "click" }, [
        { changeId: record.id, fingerprint: fingerprintOf(record) },
      ]),
    ).toBeNull();
  });

  it("Enter or Space on the focused button counts, because it is still a person pressing that button", () => {
    const record = newDraft();
    expect(
      ApprovalWitness.fromClick({ isTrusted: true, type: "click", detail: 0 } as never, [
        { changeId: record.id, fingerprint: fingerprintOf(record) },
      ]),
    ).not.toBeNull();
  });

  it("a trusted event that is not a click mints nothing", () => {
    const record = newDraft();
    expect(
      ApprovalWitness.fromClick({ isTrusted: true, type: "keydown" }, [
        { changeId: record.id, fingerprint: fingerprintOf(record) },
      ]),
    ).toBeNull();
  });

  it("a click over nothing mints nothing", () => {
    expect(ApprovalWitness.fromClick({ isTrusted: true, type: "click" }, [])).toBeNull();
  });

  it("a witness with the wrong fingerprint is rejected", () => {
    const record = newDraft();
    const witness = ApprovalWitness.fromClick({ isTrusted: true, type: "click" }, [
      { changeId: record.id, fingerprint: "other" as never },
    ]);
    expect(rejected(witness)).toEqual({ ok: false, error: "stale-approval" });
  });

  it("a witness for another change is rejected", () => {
    expect(rejected(clickWitness(newDraft("ch-2")))).toEqual({
      ok: false,
      error: "stale-approval",
    });
  });

  it("a click on text that was edited before the click landed is rejected as stale", () => {
    const record = newDraft();
    const stale = clickWitness(record);
    expect(rejected(stale, step(record, EDIT))).toEqual({ ok: false, error: "stale-approval" });
  });

  describe("the ⌘↵ chord", () => {
    const CHORD = {
      isTrusted: true,
      type: "keydown",
      key: "Enter",
      repeat: false,
      metaKey: true,
      ctrlKey: false,
    };
    const handDraft = (patch: Partial<GradeContent> = {}): ChangeRecord =>
      newChangeRecord({
        id: "ch-hand" as never,
        school: newDraft().school,
        course: newDraft().course,
        subject: "Maya, Essay 2",
        content: gradeContent(patch),
        basis: newDraft().basis,
        at: AT,
        by: "you",
      });
    const chord = (record: ChangeRecord, press: Partial<typeof CHORD> = {}) =>
      ApprovalWitness.fromChord(
        { ...CHORD, ...press },
        { changeId: record.id, fingerprint: fingerprintOf(record) },
      );

    it("approves a grade only you have edited", () => {
      const record = handDraft();
      const result = transition(record, { type: "approve", witness: chord(record)!, at: AT });
      expect(
        result.ok && result.value.state.tag === "approved" && result.value.state.approval.via,
      ).toBe("chord");
    });

    it("stops a zero or an empty comment at the preview, but not an excuse", () => {
      const stopped = [
        handDraft({ rubric: [{ criterion: CRITERION, name: "Thesis", points: 0, outOf: 25 }] }),
        handDraft({ override: 0 }),
        handDraft({ comment: null }),
        handDraft({ comment: "  " }),
      ];
      for (const record of stopped)
        expect(rejected(chord(record), record)).toEqual({ ok: false, error: "needs-review" });
      const excused = handDraft({ excused: true, rubric: null, points: null, comment: null });
      const result = transition(excused, { type: "approve", witness: chord(excused)!, at: AT });
      expect(result.ok).toBe(true);
    });

    it("never approves an AI draft, even one you edited after", () => {
      const record = step(newDraft(), EDIT);
      expect(rejected(chord(record), record)).toEqual({ ok: false, error: "needs-review" });
    });

    it("never approves a grade the agent edited after you started it", () => {
      const record = step(handDraft(), {
        type: "edit",
        by: "agent",
        patch: { kind: "grade", comment: "From the agent." },
        at: AT,
      });
      expect(rejected(chord(record), record)).toEqual({ ok: false, error: "needs-review" });
    });

    it("never approves a grade the agent explained", () => {
      const record = step(handDraft(), {
        type: "annotate",
        rationale: { field: "comment", why: "Why.", anchors: [] },
        at: AT,
      });
      expect(rejected(chord(record), record)).toEqual({ ok: false, error: "needs-review" });
    });

    it("mints nothing from a script, a held key, another key, or a bare Enter", () => {
      const record = handDraft();
      expect(chord(record, { isTrusted: false })).toBeNull();
      expect(chord(record, { repeat: true })).toBeNull();
      expect(chord(record, { key: "a" })).toBeNull();
      expect(chord(record, { metaKey: false })).toBeNull();
      expect(chord(record, { metaKey: false, ctrlKey: true })).not.toBeNull();
    });
  });

  it("a genuine witness covering two changes approves each, marked as a batch", () => {
    const a = newDraft("ch-a");
    const b = newDraft("ch-b");
    const witness = ApprovalWitness.fromClick(
      { isTrusted: true, type: "click" },
      [a, b].map((record) => ({ changeId: record.id, fingerprint: fingerprintOf(record) })),
    );
    for (const record of [a, b]) {
      const next = step(record, { type: "approve", witness: witness as ApprovalWitness, at: AT });
      expect(next.state.tag === "approved" && next.state.approval.via).toBe("batch-button");
    }
  });
});

describe("the send permit", () => {
  it("is refused for every state other than sending", () => {
    for (const build of [
      () => newDraft(),
      () => approved(),
      () => held(),
      () => conflicted(),
      () => sent(),
      () => discarded(),
    ]) {
      expect(mintSendPermit(build(), ["grade"])).toBeNull();
    }
  });

  it("is refused when the content no longer matches the approval", () => {
    const record = sending();
    expect(
      mintSendPermit(
        {
          ...record,
          content: {
            ...record.content,
            comment: "Swapped after approval.",
          } as ChangeRecord["content"],
        },
        ["grade"],
      ),
    ).toBeNull();
  });

  it("is genuine when minted from a matching sending change, and a copy of it is not", () => {
    const permit = mintSendPermit(sending(), ["grade"]);
    expect(SendPermit.isGenuine(permit)).toBe(true);
    expect(SendPermit.isGenuine({ ...permit })).toBe(false);
  });

  it("begin-send is refused when the content moved under an approval", () => {
    const record = approved();
    const tampered = {
      ...record,
      content: { ...record.content, comment: "Swapped." } as ChangeRecord["content"],
    };
    expect(transition(tampered, { type: "begin-send", seen: {}, at: AT })).toEqual({
      ok: false,
      error: "stale-approval",
    });
  });

  it("begin-send from a draft says it is not approved", () => {
    expect(transition(newDraft(), { type: "begin-send", seen: {}, at: AT })).toEqual({
      ok: false,
      error: "not-approved",
    });
  });
});

describe("partial runs and landed fields", () => {
  const LANDED_GRADE: ChangeEvent = {
    type: "field-outcomes",
    outcomes: {
      grade: { status: "landed", at: AT, via: "response" },
      comment: { status: "landed", at: AT, via: "response" },
    },
    at: AT,
  };
  const partlySent = () => held(step(sending(), LANDED_GRADE));

  it("editing a landed comment is rejected, because it cannot be unsent", () => {
    expect(transition(partlySent(), EDIT)).toEqual({ ok: false, error: "field-already-landed" });
  });

  it("editing a landed grade is allowed and makes the landed value the baseline", () => {
    const record = partlySent();
    const next = step(record, {
      type: "edit",
      by: "you",
      patch: { kind: "grade", rubricPoints: { "lcc:criterion:2:thesis": 20 } },
      at: AT,
    });
    expect(next.state.tag).toBe("draft");
    expect(next.landed).toEqual(["comment"]);
    expect(next.basis.remote.kind === "grade" && next.basis.remote.grade).toBe(18);
  });

  it("an edit is refused while a field might still land", () => {
    const record = step(sending(), {
      type: "field-outcomes",
      outcomes: { comment: { status: "unknown", since: AT } },
      at: AT,
    });
    const rest = held(record);
    expect(transition(rest, EDIT)).toEqual({ ok: false, error: "not-editable" });
    expect(transition(rest, { type: "revoke", at: AT })).toEqual({
      ok: false,
      error: "not-editable",
    });
  });

  it("a retry keeps landed outcomes and the first run's seen ids", () => {
    const first = step(
      step(approved(), { type: "begin-send", seen: { comment: ["c1"] }, at: AT }),
      LANDED_GRADE,
    );
    const retried = step(held(first), { type: "begin-send", seen: { comment: ["later"] }, at: AT });
    expect(retried.state.tag === "sending" && retried.state.run.attempt).toBe(2);
    expect(retried.seen).toEqual({ comment: ["c1"] });
    expect(retried.state.tag === "sending" && retried.state.run.fields.grade?.status).toBe(
      "landed",
    );
  });

  it("resolving a conflict always needs a fresh approval and takes the fresh read as its basis", () => {
    const next = step(conflicted(), {
      type: "resolve-conflict",
      choices: { grade: "keep-mine" },
      remote: gradeRemote({ grade: 65 }),
      at: AT,
    });
    expect(next.state).toEqual({ tag: "draft", approvalReset: "rebased" });
    expect(next.basis.remote.kind === "grade" && next.basis.remote.grade).toBe(65);
  });

  it("resolving with it-landed on the only field discards the change", () => {
    const only = approved(
      newDraft("ch-1", { ...newDraft().content, comment: null, rubric: null, points: 50 } as never),
    );
    const clash = step(sending(only), {
      type: "conflict",
      conflicts: [
        { field: "grade", reason: "changed-by-other", basis: null, theirs: "50", mine: "50" },
      ],
      at: AT,
    });
    expect(
      step(clash, {
        type: "resolve-conflict",
        choices: { grade: "it-landed" },
        remote: gradeRemote(),
        at: AT,
      }).state.tag,
    ).toBe("discarded");
  });
});

describe("classify", () => {
  const reply = {
    kind: "reply",
    target: "lcc:conversation:1",
    body: "Yes, Friday works.",
  } as const;
  const thread = (
    count: number,
    extra: readonly { id: string; mine: boolean; text: string }[] = [],
  ): RemoteState => ({
    kind: "reply",
    targetVersion: `messages:${count}`,
    messages: [{ id: "m1", mine: false, text: "Can I have until Friday?" }, ...extra],
  });
  const basis = { readAt: AT, remote: thread(1) };
  const SEEN = { message: ["m1"] };
  const decide = (remote: RemoteState) => classify(reply as never, basis, remote, SEEN).message;

  it("an append field writes when nothing moved", () => {
    expect(decide(thread(1))).toEqual({ do: "write" });
  });

  it("an append field stops when the student wrote again, even though this write would not collide", () => {
    expect(
      decide(thread(2, [{ id: "m2", mine: false, text: "Actually, never mind." }])),
    ).toMatchObject({ do: "conflict", conflict: { reason: "target-changed" } });
  });

  it("my own entry that the first send did not see reads as already there, ignoring whitespace", () => {
    expect(decide(thread(2, [{ id: "m2", mine: true, text: "Yes,  Friday\nworks. " }]))).toEqual({
      do: "already-there",
    });
  });

  it("my own entry with different text may be this write after normalizing, so it never auto-posts", () => {
    expect(
      decide(thread(2, [{ id: "m2", mine: true, text: "Yes, Friday is fine." }])),
    ).toMatchObject({ do: "conflict", conflict: { reason: "possible-own-write" } });
  });

  it("an entry of mine that was already there when the send began is not this write", () => {
    const remote: RemoteState = {
      kind: "reply",
      targetVersion: "messages:1",
      messages: [{ id: "m1", mine: true, text: reply.body }],
    };
    expect(classify(reply as never, { readAt: AT, remote }, remote, SEEN).message).toEqual({
      do: "write",
    });
  });

  it("a set field that already holds the desired value reads as already there, even if the attempt moved", () => {
    const content = {
      kind: "grade",
      target: SUBMISSION,
      points: 80,
      outOf: 100,
      rubric: null,
      late: null,
      comment: null,
      attachment: null,
      override: null,
      excused: false,
    } as const;
    expect(
      classify(
        content,
        { readAt: AT, remote: gradeRemote() },
        gradeRemote({ grade: 80, targetVersion: "attempt:2" }),
        {},
      ).grade,
    ).toEqual({ do: "already-there" });
  });

  it("a set field changed by someone else is a conflict naming all three values", () => {
    const content = {
      kind: "grade",
      target: SUBMISSION,
      points: 80,
      outOf: 100,
      rubric: null,
      late: null,
      comment: null,
      attachment: null,
      override: null,
      excused: false,
    } as const;
    expect(
      classify(
        content,
        { readAt: AT, remote: gradeRemote({ grade: 58 }) },
        gradeRemote({ grade: 65 }),
        {},
      ).grade,
    ).toEqual({
      do: "conflict",
      conflict: {
        field: "grade",
        reason: "changed-by-other",
        basis: "58",
        theirs: "65",
        mine: "80",
      },
    });
  });
});

describe("resolving a conflict by keeping their grade", () => {
  it("drops the rubric too, because rubric scores would set the grade right back", () => {
    const next = step(conflicted(), {
      type: "resolve-conflict",
      choices: { grade: "use-theirs" },
      remote: gradeRemote({ grade: 65 }),
      at: AT,
    });
    expect(next.content.kind === "grade" && next.content.rubric).toBeNull();
    expect(fieldsOf(next.content)).not.toContain("rubric");
    expect(next.landed).toContain("grade");
  });
});

describe("fitContent", () => {
  it("takes out what the school's LMS can't accept and keeps the score", () => {
    const content = gradeContent({ attachment: { name: "marked.pdf", sizeBytes: 10 } as never });
    const fitted = fitContent(content, { rubricWrite: false, attachments: false });
    expect(fieldsOf(fitted)).toEqual(["grade", "comment"]);
    expect(fitted.kind === "grade" && finalGrade(fitted)).toBe(finalGrade(content));
  });

  it("leaves content alone when the LMS takes everything", () => {
    const content = gradeContent();
    expect(fitContent(content, { rubricWrite: true, attachments: true })).toEqual(content);
  });
});

describe("missing work: excuse and zero", () => {
  const EVIDENCE = "lcc:criterion:2:evidence" as LmsRef<"criterion">;
  const excused = gradeContent({ points: null, rubric: null, comment: null, excused: true });
  const excuse = (basis: RemoteState, remote: RemoteState) =>
    classify(excused, { readAt: AT, remote: basis }, remote, {}).excuse;

  it("an excuse writes only the excuse, and needs no score", () => {
    expect(fieldsOf(excused)).toEqual(["excuse"]);
    expect(unfilled(excused)).toEqual([]);
    expect(excuse(gradeRemote(), gradeRemote())).toEqual({ do: "write" });
  });

  it("a basis saved before excuses existed still writes the excuse", () => {
    const { excused: _, ...saved } = gradeRemote() as Extract<RemoteState, { kind: "grade" }>;
    expect(excuse(saved as RemoteState, gradeRemote())).toEqual({ do: "write" });
  });

  it("an excuse already in the LMS reads as already there", () => {
    expect(excuse(gradeRemote(), gradeRemote({ excused: true }))).toEqual({ do: "already-there" });
  });

  it("a grade someone entered since the read is a conflict, not overwritten by the excuse", () => {
    expect(excuse(gradeRemote(), gradeRemote({ grade: 70 }))).toEqual({
      do: "conflict",
      conflict: {
        field: "excuse",
        reason: "changed-by-other",
        basis: null,
        theirs: "70",
        mine: "Excused",
      },
    });
  });

  it("a grade does not silently overwrite an excuse someone entered since the read", () => {
    const content = gradeContent({ points: 0, rubric: null });
    expect(
      classify(content, { readAt: AT, remote: gradeRemote() }, gradeRemote({ excused: true }), {})
        .grade,
    ).toMatchObject({ do: "conflict", conflict: { theirs: "Excused" } });
  });

  it("excusing clears every score, and any score afterwards un-excuses", () => {
    const scored = gradeContent({ comment: "Was absent." });
    const next = applyPatch(scored, { kind: "grade", excused: true }) as GradeContent;
    expect(next.excused).toBe(true);
    expect(next.rubric?.every((r) => r.points === null)).toBe(true);
    expect(fieldsOf(next)).toEqual(["excuse", "comment"]);
    const rescored = applyPatch(next, {
      kind: "grade",
      rubricPoints: { [CRITERION]: 5 },
    }) as GradeContent;
    expect(rescored.excused).toBe(false);
    expect(fieldsOf(rescored)).toContain("grade");
    const commented = applyPatch(next, { kind: "grade", comment: "Doctor's note." });
    expect(commented).toMatchObject({ excused: true });
  });

  describe("the agent's zero comment", () => {
    const ZERO_NOTE = "Maya, I don't have your Essay 2 yet, so I've recorded a zero.";
    const drafted = () => newDraft("ch-1", gradeContent({ comment: ZERO_NOTE }));
    const edit = (record: ChangeRecord, patch: ChangePatch, by: "you" | "agent" = "you") =>
      step(record, { type: "edit", by, patch, at: AT });
    const comment = (record: ChangeRecord) =>
      record.content.kind === "grade" ? record.content.comment : undefined;

    it("an excuse drops the comment the agent wrote", () => {
      expect(comment(edit(drafted(), { kind: "grade", excused: true }))).toBeNull();
    });

    it("an excuse keeps a comment the teacher edited", () => {
      const yours = edit(drafted(), { kind: "grade", comment: "Doctor's note on file." });
      expect(comment(edit(yours, { kind: "grade", excused: true }))).toBe("Doctor's note on file.");
    });

    it("an excuse keeps a comment the teacher typed on a draft they started", () => {
      const started = newChangeRecord({
        ...drafted(),
        content: gradeContent({ comment: "See me." }),
        at: AT,
        by: "you",
      });
      expect(comment(edit(started, { kind: "grade", excused: true }))).toBe("See me.");
    });

    it("an excuse drops a comment the agent rewrote", () => {
      const rewritten = edit(
        drafted(),
        { kind: "grade", comment: "Maya, still missing." },
        "agent",
      );
      expect(comment(edit(rewritten, { kind: "grade", excused: true }))).toBeNull();
    });
  });

  it.each([
    [
      "a rubric",
      gradeContent({
        rubric: [
          { criterion: CRITERION, name: "Thesis", points: null, outOf: 25 },
          { criterion: EVIDENCE, name: "Evidence", points: null, outOf: 25 },
        ],
      }),
    ],
    ["no rubric", gradeContent({ rubric: null, points: null })],
  ])("Zero on %s fills every score with 0", (_name, content) => {
    const zeroed = applyPatch(content, zeroPatch(content)) as GradeContent;
    expect(unfilled(zeroed)).toEqual([]);
    expect(finalGrade(zeroed)).toBe(0);
  });
});

describe("late waiver and total override", () => {
  const late = gradeContent({ late: { days: 3, pointsPerDay: 2, waived: false } });
  const grade = (content: GradeContent, remote: RemoteState) =>
    classify(content, { readAt: AT, remote: gradeRemote() }, remote, {}).grade;
  const edited = (content: GradeContent, patch: ChangePatch) =>
    applyPatch(content, patch) as GradeContent;

  it("a waiver sends the scores without the penalty, through the grade field", () => {
    expect(finalGrade(late)).toBe(12);
    const waived = edited(late, { kind: "grade", lateWaived: true });
    expect(finalGrade(waived)).toBe(18);
    expect(fieldsOf(waived)).toEqual(["grade", "rubric", "comment"]);
    expect(finalGrade(edited(waived, { kind: "grade", lateWaived: false }))).toBe(12);
  });

  it("an override sends the teacher's total, and needs no unscored criterion", () => {
    const partial = gradeContent({
      rubric: [{ criterion: CRITERION, name: "Thesis", points: null, outOf: 25 }],
    });
    const overridden = edited(partial, { kind: "grade", override: 20 });
    expect(finalGrade(overridden)).toBe(20);
    expect(unfilled(overridden)).toEqual([]);
    expect(fieldsOf(overridden)).toEqual(["grade", "comment"]);
  });

  it("an override replaces the late penalty too", () => {
    expect(finalGrade(edited(late, { kind: "grade", override: 25 }))).toBe(25);
  });

  it("a draft saved before overrides existed reads as no override", () => {
    const { override: _, ...saved } = late;
    expect(finalGrade(saved as GradeContent)).toBe(12);
  });

  it.each([
    ["a waived total already in the LMS", { lateWaived: true }, 18, { do: "already-there" }],
    ["an override already in the LMS", { override: 20 }, 20, { do: "already-there" }],
    [
      "a grade someone entered since the read",
      { override: 20 },
      15,
      { do: "conflict", conflict: { field: "grade", theirs: "15", mine: "20" } },
    ],
  ] as const)("%s classifies like any grade", (_name, patch, theirs, decision) => {
    const content = edited(late, { kind: "grade", ...patch });
    expect(grade(content, gradeRemote({ grade: theirs }))).toMatchObject(decision);
  });

  it("a rescore or an excuse clears the override, and an override un-excuses", () => {
    const overridden = edited(late, { kind: "grade", override: 20 });
    expect(edited(overridden, { kind: "grade", rubricPoints: { [CRITERION]: 10 } }).override).toBe(
      null,
    );
    expect(edited(overridden, { kind: "grade", excused: true }).override).toBe(null);
    const excused = edited(late, { kind: "grade", excused: true });
    expect(edited(excused, { kind: "grade", override: 0 })).toMatchObject({
      excused: false,
      override: 0,
    });
  });

  it.each([
    ["waiving", { kind: "grade", lateWaived: true }],
    ["overriding", { kind: "grade", override: 20 }],
  ] as const)("%s an approved grade needs approval again", (_name, patch) => {
    const record = approved(newDraft("ch-1", late));
    const next = step(record, { type: "edit", by: "you", patch, at: AT });
    expect(next.state).toEqual({ tag: "draft", approvalReset: "edited" });
    expect(fingerprintOf(next)).not.toBe(fingerprintOf(record));
  });
});
