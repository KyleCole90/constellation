import type { Agent, AgentScope } from "~/shared/agent/agent";
import { createRuleAgent } from "~/shared/agent/rules";
import { serve, type Handlers } from "~/shared/ipc";

export type AgentRun = Parameters<Handlers["agent.run"]>[0];

export const rulesMain = (
  options: {
    spend?: { tokens: number; usd: number };
    before?: (run: AgentRun) => Awaited<ReturnType<Handlers["agent.run"]>> | null;
  } = {},
) => {
  const rules = createRuleAgent();
  let currentScope: AgentScope | null = null;
  const run: Handlers["agent.run"] = async (input) => {
    const early = options.before?.(input);
    if (early) return early;
    const scope = currentScope;
    if (!scope)
      throw new Error("rulesMain: wrap the agent with rulesMain().agent() before running");
    const effects: unknown[] = [];
    const turn = {
      request: input.request,
      thread: { history: input.history },
      scope,
    };
    for await (const effect of rules.run(turn, new AbortController().signal)) effects.push(effect);
    return { ok: true, effects, spend: options.spend ?? { tokens: 0, usd: 0 } };
  };
  return {
    handle: (raw: unknown) => serve("agent.run", run, raw),
    agent: (inner: Agent): Agent => ({
      async *run(input, signal) {
        const previous = currentScope;
        currentScope = input.scope;
        try {
          yield* inner.run(input, signal);
        } finally {
          currentScope = previous;
        }
      },
    }),
  };
};
