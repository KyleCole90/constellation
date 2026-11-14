import type { ReactNode } from "react";

import { isBlankSecret, Secret, type SecretRefusal } from "~/shared/providers/provider";
import { REAL_AI } from "~/renderer/desktop";
import { workspaceStore } from "~/renderer/stores/workspace";

import { SecretForm } from "./SecretForm";

const demoKey = () => new Secret(`demo-key-${crypto.randomUUID()}`);

const saveKey = async (secret: Secret): Promise<SecretRefusal | null> => {
  if (isBlankSecret(secret)) return { message: "Paste a key first.", wrongSecret: true };
  try {
    await workspaceStore().getState().addAiKey(secret);
    return null;
  } catch {
    return { message: "The key could not be stored, so nothing was saved.", wrongSecret: false };
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
      // A demo key drafts only with the rules agent; Anthropic would refuse it.
      {...(REAL_AI ? {} : { secondary: { label: "Use a demo key", make: demoKey } })}
      aside={aside}
      onSubmit={async (secret) => {
        const problem = await saveKey(secret);
        if (!problem) onSaved?.();
        return problem;
      }}
    />
  );
}
