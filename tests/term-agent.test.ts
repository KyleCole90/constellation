import { describe, expect, it } from "vite-plus/test";

import {
  SCAN_COURSE_REQUEST,
  parseAgentEffect,
  runAgent,
  type Agent,
  type AgentEffect,
  type AgentInput,
  type AgentScope,
  type AgentViolation,
} from "~/agent/agent";
import { createRuleAgent } from "~/agent/rules";
import type { ChangeContent } from "~/domain/change";

import { LCC } from "./fixtures/rig";
import { makeTermRig, planFor, termOf } from "./fixtures/term";

const collect = async (agent: Agent, input: AgentInput) => {
  const effects: AgentEffect[] = [];
  const refused: AgentViolation[] = [];
  await runAgent(
    agent,
    input,
    {
      effect: (effect) => void effects.push(effect),
      refuse: (violation) => void refused.push(violation),
    },
    new AbortController().signal,
  );
  return { effects, refused };
};

const yields = (...raw: readonly unknown[]): Agent => ({
  label: "test double",
  async *run() {
    yield* raw;
  },
});

/** A setup thread's scope: the source course's content and what the rules found in it. */
const setupScope = async () => {
  const rig = await makeTermRig();
  const shell = await rig.shellNamed(LCC, "ENG 101");
  const source = await rig.sourceNamed(LCC, "ENG 101", "Fall 2026");
  const plan = planFor(termOf(source), shell);
  const { content, findings } = await rig.scan(LCC, source.ref, plan);
  const courses = await rig.provider(LCC).courses();
  if (!courses.ok) throw new Error("no courses");
  const scope: AgentScope = {
    focus: null,
    changes: [],
    submissions: [],
    assignments: [],
    conversations: [],
    courses: courses.value,
    scan: { content, findings, plan },
  };
  return { rig, scope, content, findings };
};

describe("what an agent cannot do in a setup thread", () => {
  it("cannot propose a copy or a setting as a change", async () => {
    const { scope } = await setupScope();
    const course = scope.courses[0];
    if (!course) throw new Error("no course");
    const copy = {
      kind: "course-copy",
      target: "lcc:migrations:51302",
      into: { code: "ENG 101", title: "x" },
      source: { kind: "course", ref: course.ref, label: "x", termName: "Fall 2026" },
    };
    const setting = {
      kind: "item-set",
      target: scope.scan?.content.items[0]?.ref,
      where: "Syllabus",
      intent: { set: "item-published" },
    };
    for (const content of [copy, setting]) {
      const result = parseAgentEffect(
        { type: "propose", school: course.school, course: course.ref, subject: "x", content },
        scope,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("malformed");
    }
  });

  it("cannot patch a copy's dates or a setting's value", async () => {
    const { rig, scope } = await setupScope();
    const shell = await rig.shellNamed(LCC, "ENG 101");
    const source = await rig.sourceNamed(LCC, "ENG 101", "Fall 2026");
    const { copyContent } = await import("./fixtures/term");
    const copy = await rig.draft(LCC, copyContent(shell, source));
    const result = parseAgentEffect(
      { type: "edit", change: copy.id, patch: { kind: "course-copy", shift: {} }, why: "y" },
      { ...scope, changes: [copy] },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "malformed", detail: "patch for course-copy" },
    });
  });

  it("cannot set a risk on anything it says", async () => {
    const { scope, content, findings } = await setupScope();
    const finding = findings.find((entry) => entry.type === "old-term-name" && entry.item !== null);
    const item = content.items.find((entry) => entry.ref === finding?.item);
    if (!finding || !item) throw new Error("expected a finding on an item");
    const result = parseAgentEffect(
      {
        type: "finding",
        findingType: finding.type,
        item: item.ref,
        quote: finding.quote,
        why: "Still the old term.",
        after: "Spring 2027",
        risk: "students:0|items:0",
      },
      scope,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        type: "finding",
        findingType: "old-term-name",
        item: item.ref,
        quote: finding.quote,
        why: "Still the old term.",
        after: "Spring 2027",
      },
    });
  });

  it("has its finding refused when the quote is not in the item", async () => {
    const { scope, content } = await setupScope();
    const item = content.items[0];
    if (!item) throw new Error("no item");
    expect(
      parseAgentEffect(
        {
          type: "finding",
          findingType: "old-term-name",
          item: item.ref,
          quote: "words that are not there",
          why: "x",
          after: null,
        },
        scope,
      ),
    ).toEqual({ ok: false, error: { kind: "quote-not-found", quote: "words that are not there" } });
  });

  it("has a finding refused outside a setup thread, or with an unknown type, or on an item it was not shown", async () => {
    const { scope, content } = await setupScope();
    const item = content.items[0];
    if (!item) throw new Error("no item");
    const { scan: _scan, ...plain } = scope;
    expect(
      parseAgentEffect(
        {
          type: "finding",
          findingType: "old-term-name",
          item: item.ref,
          quote: item.body.slice(0, 10),
          why: "x",
          after: null,
        },
        plain,
      ).ok,
    ).toBe(false);
    expect(
      parseAgentEffect(
        {
          type: "finding",
          findingType: "made-up",
          item: item.ref,
          quote: item.body.slice(0, 10),
          why: "x",
          after: null,
        },
        scope,
      ),
    ).toEqual({ ok: false, error: { kind: "malformed", detail: "finding type made-up" } });
    expect(
      parseAgentEffect(
        {
          type: "finding",
          findingType: "old-term-name",
          item: "lcc:item:1:page:1",
          quote: "x",
          why: "x",
          after: null,
        },
        scope,
      ),
    ).toEqual({ ok: false, error: { kind: "out-of-scope", target: "lcc:item:1:page:1" } });
  });

  it.each(["publish", "approve", "copy", "send"])(
    "has a %s effect refused as unknown",
    async (type) => {
      const { scope } = await setupScope();
      const { effects, refused } = await collect(yields({ type, course: "lcc:course:51302" }), {
        request: "x",
        thread: { history: [] },
        scope,
      });
      expect(effects).toEqual([]);
      expect(refused).toEqual([{ kind: "unknown-effect", seen: type }]);
    },
  );

  it("declines a request to approve, copy, or publish and points at the buttons", async () => {
    const { scope } = await setupScope();
    for (const request of [
      "publish the course",
      "approve all the fixes",
      "start the copy now",
      "send it",
    ]) {
      const { effects } = await collect(createRuleAgent(), {
        request,
        thread: { history: [] },
        scope,
      });
      expect(effects).toHaveLength(1);
      expect(effects[0]?.type).toBe("decline");
      if (effects[0]?.type === "decline") expect(effects[0].text).toContain("buttons");
    }
  });
});

describe("the canned scan", () => {
  it("reads the course, speaks to findings with quotes that exist, and ends with counts", async () => {
    const { scope, findings } = await setupScope();
    const { effects, refused } = await collect(createRuleAgent(), {
      request: SCAN_COURSE_REQUEST,
      thread: { history: [] },
      scope,
    });
    expect(refused).toEqual([]);
    const work = effects.filter((effect) => effect.type === "work");
    expect(work.map((effect) => (effect.type === "work" ? effect.line : ""))).toContain(
      "Read the syllabus",
    );
    const spoken = effects.filter(
      (effect): effect is Extract<AgentEffect, { type: "finding" }> => effect.type === "finding",
    );
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken.map((effect) => effect.findingType)).toContain("foreign-contact");
    expect(spoken.map((effect) => effect.findingType)).toContain("missing-statement");
    const statement = spoken.find((effect) => effect.findingType === "missing-statement");
    expect(statement?.after).toContain("Accessibility statement");
    const office = spoken.find(
      (effect) => effect.findingType === "foreign-contact" && effect.after === null,
    );
    expect(office?.why).toContain("another school");
    const last = effects.at(-1);
    expect(last?.type).toBe("say");
    if (last?.type === "say") expect(last.text).toContain(`${findings.length} things`);
  });

  it("every type the stream names is one the rules know", async () => {
    const { scope } = await setupScope();
    const { effects } = await collect(createRuleAgent(), {
      request: SCAN_COURSE_REQUEST,
      thread: { history: [] },
      scope,
    });
    const kinds = new Set(
      effects.flatMap((effect) => (effect.type === "finding" ? [effect.findingType] : [])),
    );
    for (const kind of kinds)
      expect(scope.scan?.findings.some((finding) => finding.type === kind)).toBe(true);
  });

  it("never yields a propose, so no change kind reaches the parser from here", async () => {
    const { scope } = await setupScope();
    const { effects } = await collect(createRuleAgent(), {
      request: SCAN_COURSE_REQUEST,
      thread: { history: [] },
      scope,
    });
    const proposed: ChangeContent[] = effects.flatMap((effect) =>
      effect.type === "propose" ? [effect.content] : [],
    );
    expect(proposed).toEqual([]);
  });
});
