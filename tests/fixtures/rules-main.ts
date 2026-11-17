import type { AgentScope } from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import { serve, type Handlers } from "~/shared/ipc";

export type AgentRun = Parameters<Handlers["agent.run"]>[0];

/**
 * Main's schema leaves the scope unknown, because main only writes it into the prompt. In process it is the renderer's
 * own object, so the rules agent standing in for Claude can read it.
 */
export const scopeOf = (run: AgentRun): AgentScope => run.scope as AgentScope;

/**
 * Main's `agent.run`, with the rules agent drafting in Claude's place. Each call goes through main's own input schema
 * first, so a payload main would reject fails here too. `before` may answer instead, as a plan limit does.
 */
export const rulesMain = (
  options: {
    spend?: { tokens: number; usd: number };
    before?: (run: AgentRun) => Awaited<ReturnType<Handlers["agent.run"]>> | null;
  } = {},
) => {
  const rules = createRuleAgent();
  const run: Handlers["agent.run"] = async (input) => {
    const early = options.before?.(input);
    if (early) return early;
    const effects: unknown[] = [];
    const turn = {
      request: input.request,
      thread: { history: input.history },
      scope: scopeOf(input),
    };
    for await (const effect of rules.run(turn, new AbortController().signal)) effects.push(effect);
    return { ok: true, effects, spend: options.spend ?? { tokens: 0, usd: 0 } };
  };
  return (raw: unknown) => serve("agent.run", run, raw);
};
