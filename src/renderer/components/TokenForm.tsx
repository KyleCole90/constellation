import { LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { SchoolId } from "~/shared/domain/ids";
import { isDemoSchool } from "~/shared/domain/lms";
import { Secret } from "~/shared/providers/provider";
import { useWorkspace, workspaceStore, type ConnectStage } from "~/renderer/stores/workspace";

import { STAGE_WORDS } from "./settings/connection.logic";
import { SecretForm } from "./settings/SecretForm";

const demoToken = () => new Secret(`demo-${crypto.randomUUID()}`);

/** Rendered from the school's enrollment, so it has no vendor branch. Onboarding, Settings, and the preview panel's banner all enter a token here. */
export function TokenForm({
  school,
  submitLabel,
  onConnected,
  aside,
}: {
  school: SchoolId;
  submitLabel: string;
  onConnected?: () => void;
  aside?: ReactNode;
}) {
  const enrollment = useWorkspace((state) => state.enrollmentFor(school));
  const demo = useWorkspace((state) =>
    state.schools.some((candidate) => candidate.id === school && isDemoSchool(candidate)),
  );
  const [stage, setStage] = useState<ConnectStage | null>(null);

  if (!enrollment) return null;
  if (enrollment.kind !== "paste-token")
    return (
      <p className="text-meta text-muted-foreground">
        This school signs in on its own page, which isn't available in this build.
      </p>
    );

  const connect = async (secret: Secret): Promise<string | null> => {
    const result = await workspaceStore().getState().connect(school, secret, setStage);
    setStage(null);
    if (!result.ok) return result.error;
    onConnected?.();
    return null;
  };

  return (
    <SecretForm
      fieldLabel={enrollment.fieldLabel}
      submitLabel={submitLabel}
      busyLabel="Connecting"
      onSubmit={connect}
      {...(demo && { secondary: { label: "Use a demo token", make: demoToken } })}
      aside={aside}
      progress={
        <p
          role="status"
          data-testid="connect-stage"
          className="flex items-center gap-1.5 text-meta text-muted-foreground"
        >
          <LoaderCircle className="size-3 animate-spin" />
          {stage ? STAGE_WORDS[stage] : "Starting"}
        </p>
      }
    >
      <TokenSteps steps={enrollment.steps} />
    </SecretForm>
  );
}

/** How to get a token, numbered. The Reconnect dialog and the setup rows show the same steps. */
export function TokenSteps({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-4 text-meta text-muted-foreground">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}
