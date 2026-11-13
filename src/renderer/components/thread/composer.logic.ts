import type { ChangeContent } from "~/shared/domain/change";
import type { ThreadKind } from "~/renderer/stores/types";

export interface ComposerHints {
  placeholder: string;
  examples: readonly string[];
}

/** What the agent can actually do from here, so an example never promises something it would refuse. */
export const composerHints = (input: {
  kind: ThreadKind;
  content: ChangeContent | null;
  canEdit: boolean;
  setupStep?: string | undefined;
  conversation?: "unanswered" | "answered" | undefined;
  /** A submission is on screen with no draft open, as after a draft that failed. */
  submission?: boolean;
}): ComposerHints => {
  const { kind, content, canEdit, setupStep, conversation, submission } = input;
  if (kind === "north-star" || kind === "north-star-chat")
    return { placeholder: "Ask what's due, find something, or start work", examples: [] };
  if (kind === "setup")
    return {
      placeholder:
        setupStep === "review"
          ? "Ask about a finding, or open a fix and ask to reword it"
          : "Ask about this course setup",
      examples: [],
    };
  if (content && !canEdit)
    return { placeholder: "This one is closed for edits. Ask about something else.", examples: [] };
  if (content?.kind === "grade")
    return {
      placeholder: "Correct the draft: a score, a sentence, the tone",
      examples: ["Drop the last sentence", "Make it warmer"],
    };
  if (content?.kind === "reply" || content?.kind === "message")
    return {
      placeholder: `Correct the ${content.kind}`,
      examples: ["Make it shorter", "Make it warmer"],
    };
  if (content?.kind === "announcement")
    return {
      placeholder: "Correct the announcement",
      examples: ["Make it shorter", "Drop the last sentence"],
    };
  if (kind === "queue" || kind === "grading")
    return submission
      ? { placeholder: "Ask me to draft this one", examples: [] }
      : { placeholder: "Open a submission and I'll draft it", examples: [] };
  if (kind === "messages")
    return {
      placeholder:
        conversation === "unanswered"
          ? "Draft a reply, then correct it here"
          : conversation === "answered"
            ? "You answered this one. Open another message to reply"
            : "Open a message and I'll draft a reply",
      examples: [],
    };
  if (kind === "announcement")
    return { placeholder: "Start the draft, then correct it here", examples: [] };
  return { placeholder: "Open something to draft, then correct it here", examples: [] };
};
