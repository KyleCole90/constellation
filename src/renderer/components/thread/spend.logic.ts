import type { Thread } from "~/renderer/stores/types";

const tokenWords = (tokens: number): string =>
  tokens < 1000 ? `${tokens} tokens` : `${(tokens / 1000).toFixed(1)}k tokens`;
const dollars = (usd: number): string => (usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`);

/** The thread header's usage line. Claude Code runs report no dollars: they count against the teacher's plan, not a bill. */
export const spendWords = ({ tokens, usd }: NonNullable<Thread["spend"]>): string =>
  usd > 0 ? `${tokenWords(tokens)} · ${dollars(usd)}` : tokenWords(tokens);
