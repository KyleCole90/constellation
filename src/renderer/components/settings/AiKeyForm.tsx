import type { ReactNode } from "react";

import { isBlankSecret, Secret } from "~/shared/providers/provider";
import { workspaceStore } from "~/renderer/stores/workspace";

import { SecretForm } from "./SecretForm";

const demoKey = () => new Secret(`demo-key-${crypto.randomUUID()}`);

const saveKey = async (secret: Secret): Promise<string | null> => {
  if (isBlankSecret(secret)) return "Paste a key first.";
  try {
    await workspaceStore().getState().addAiKey(secret);
    return null;
  } catch {
    return "The key could not be stored, so nothing was saved.";
  }
};

export function AiKeyForm({
  submitLabel,
  onSaved,
  aside,
  layout,
}: {
  submitLabel: string;
  onSaved?: () => void;
  aside?: ReactNode;
  layout?: "stacked" | "inline";
}) {
  return (
    <SecretForm
      fieldLabel="Anthropic API key"
      {...(layout ? { layout } : {})}
      submitLabel={submitLabel}
      busyLabel="Saving"
      secondary={{ label: "Use a demo key", make: demoKey }}
      aside={aside}
      onSubmit={async (secret) => {
        const problem = await saveKey(secret);
        if (!problem) onSaved?.();
        return problem;
      }}
    />
  );
}
