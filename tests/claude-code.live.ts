import { describe, expect, it } from "vite-plus/test";

import { claudeCodeAgent } from "~/main/providers/claude-code";

/*
 * `CLAUDE_CODE_LIVE=1 npm run contract:live -- tests/claude-code.live.ts`: one tiny draft through the real, signed-in
 * `claude` on this Mac, with the same flags and checks as the app. It spends plan usage, so it runs only when asked,
 * never in `npm test` or CI. Run it before raising CLAUDE_CODE_MINIMUM (src/shared/claude-code.ts).
 */
const LIVE = Boolean(process.env["CLAUDE_CODE_LIVE"]) && !process.env["CI"];

describe.skipIf(!LIVE)("the real Claude Code", () => {
  const agent = claudeCodeAgent();

  it("is installed, current and signed in", async () => {
    expect(await agent.status()).toMatchObject({
      installed: true,
      tooOld: false,
      signedIn: true,
    });
  });

  it("starts with only StructuredOutput and answers with effects the parser reads, on the plan", async () => {
    const answer = await agent.run({
      request: "Say hello to the teacher in one short sentence.",
      history: [],
      files: [],
      scope: {
        focus: null,
        changes: [],
        submissions: [],
        assignments: [],
        conversations: [],
        courses: [],
      },
    });
    expect(answer).toMatchObject({
      ok: true,
      effects: expect.arrayContaining([expect.objectContaining({ type: "say" })]),
      spend: { usd: 0 },
    });
    expect(answer.ok && answer.spend.tokens).toBeGreaterThan(0);
  }, 300_000);
});
