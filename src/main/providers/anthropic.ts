import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { Handlers } from "../../shared/ipc";
import { revealSecret, type CredentialLease } from "../../shared/providers/provider";

import {
  DECLINED,
  MODEL,
  OFFLINE,
  SYSTEM,
  TOOLS,
  blocksOf,
  effectOf,
  failed,
  prompt,
  unreadable,
  type Answer,
  type Input,
} from "../agent";

import type { Fetch } from "./canvas";

/** Dollars per million tokens, input then output. A fallback the table doesn't name is priced at its highest rate, so a thread never shows less than it cost. */
const PRICES: Readonly<Record<string, readonly [number, number]>> = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
};
const HIGHEST = [5, 25] as const;

const NO_KEY = failed("No Anthropic key is saved. Add one in Settings to turn on AI drafts.");
const KEY_REFUSED = failed(
  "Anthropic didn't accept the saved key. Replace it in Settings, then ask again.",
);
const RATE_LIMITED = failed(
  "Anthropic is limiting requests on this key right now. Wait a minute, then ask again.",
);
const REFUSED_REQUEST = failed(
  "Anthropic refused the request. If you set a spend limit in Anthropic's console, it may have been reached.",
);
const ANTHROPIC_DOWN = failed("Anthropic had a problem answering. Ask again in a moment.");

/** Raw effects for the renderer's parser. */
const effectsOf = (content: readonly BetaContentBlock[]): unknown[] =>
  content.flatMap((block): unknown[] => {
    if (block.type === "tool_use") return effectOf(block.name, block.input);
    if (block.type === "text" && block.text.trim() !== "")
      return [{ type: "say", text: block.text }];
    return [];
  });

/** Every attempt is billed, including one a fallback model finished, so each is priced at its own model's rate. */
export const spendOf = (message: BetaMessage): { tokens: number; usd: number } => {
  const attempts = message.usage.iterations ?? [{ ...message.usage, model: message.model }];
  let tokens = 0;
  let usd = 0;
  for (const attempt of attempts) {
    if (!("input_tokens" in attempt)) continue;
    const model = "model" in attempt && attempt.model ? attempt.model : message.model;
    const [inRate, outRate] = PRICES[model] ?? HIGHEST;
    const written = attempt.cache_creation_input_tokens ?? 0;
    const read = attempt.cache_read_input_tokens ?? 0;
    tokens += attempt.input_tokens + written + read + attempt.output_tokens;
    // Cache writes at the 1-hour rate (2x input) and reads at the full input rate: both at or above what Anthropic bills, so
    // the thread never shows less than it cost. The app sets no cache, so these are 0 unless that changes.
    usd +=
      ((attempt.input_tokens + 2 * written + read) * inRate + attempt.output_tokens * outRate) /
      1_000_000;
  }
  return { tokens, usd };
};

const reasonFor = (error: unknown): Answer => {
  if (error instanceof Anthropic.APIConnectionError) return OFFLINE;
  if (error instanceof Anthropic.AuthenticationError) return KEY_REFUSED;
  if (error instanceof Anthropic.PermissionDeniedError) return KEY_REFUSED;
  if (error instanceof Anthropic.RateLimitError) return RATE_LIMITED;
  if (error instanceof Anthropic.BadRequestError) return REFUSED_REQUEST;
  return ANTHROPIC_DOWN;
};

const ask = async (client: Anthropic, input: Input): Promise<Answer> => {
  let message: BetaMessage;
  try {
    message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16_000,
      output_config: { effort: "medium" },
      // A policy decline is retried on the model Anthropic picks for it, inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      tools: [...TOOLS],
      messages: [
        { role: "user", content: input.files.length === 0 ? prompt(input) : blocksOf(input) },
      ],
    });
  } catch (error) {
    return reasonFor(error);
  }
  const spend = spendOf(message);
  // A refusal can stop partway through, so nothing it wrote is kept.
  if (message.stop_reason === "refusal")
    return { ok: true, effects: [{ type: "decline", text: DECLINED }], spend };
  return { ok: true, effects: effectsOf(message.content), spend };
};

/**
 * `agent.run` in main: Claude with the key from main's vault (docs/electron-spec.md, AI). The key is read for each run
 * and never kept, logged or sent anywhere but Anthropic. What comes back is raw: the renderer's `parseAgentEffect`
 * decides what of it counts, and nothing it yields can approve or send.
 */
export const anthropicAgent =
  (options: { lease: CredentialLease; fetch: Fetch }): Handlers["agent.run"] =>
  (input) =>
    options.lease.use(async (credential) => {
      if (credential?.kind !== "bearer") return NO_KEY;
      const unread = unreadable(input);
      if (unread) return unread;
      const client = revealSecret(
        credential.token,
        (apiKey) =>
          new Anthropic({
            apiKey,
            fetch: (url, init) =>
              options.fetch(
                typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
                init ?? {},
              ),
            logLevel: "off",
          }),
      );
      return ask(client, input);
    });
