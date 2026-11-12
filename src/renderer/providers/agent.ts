import type { Agent, AgentScope } from "~/shared/agent/agent";
import type { Bridge } from "~/shared/ipc";

const UNREACHABLE =
  "The app couldn't reach Claude, so nothing was drafted. Ask again. Nothing was queued.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The model names the submission it just graded, because the change id is minted here when its propose lands. By the
 * time this annotate is read, the store has filed that propose, so the draft for the submission is in scope.
 */
const withChange = (raw: unknown, scope: AgentScope): unknown => {
  if (!isRecord(raw) || raw["type"] !== "annotate" || typeof raw["submission"] !== "string")
    return raw;
  const { submission, ...rest } = raw;
  const change = scope.changes.find(
    (c) => c.content.kind === "grade" && c.content.target === submission && c.state.tag === "draft",
  );
  return { ...rest, change: change?.id ?? submission };
};

/**
 * The desktop app's agent: Claude, run in main over `agent.run` with the key from main's vault. Everything it yields
 * still goes through `parseAgentEffect`, like the rules agent's output (docs/electron-spec.md, D26).
 */
export const createBridgeAgent = (bridge: Bridge): Agent => ({
  label: "Claude, with your Anthropic key",
  async *run({ request, thread, scope }) {
    // Plain data only: the live `changes` getter is read once, here.
    const plain: unknown = JSON.parse(JSON.stringify(scope));
    let answer;
    try {
      answer = await bridge.invoke("agent.run", {
        request,
        history: thread.history.map((line) => ({ ...line })),
        scope: plain,
      });
    } catch {
      yield { type: "decline", text: UNREACHABLE };
      return;
    }
    if (!answer.ok) {
      yield { type: "decline", text: answer.reason };
      return;
    }
    for (const effect of answer.effects) yield withChange(effect, scope);
    yield { type: "spend", ...answer.spend };
  },
});
