import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { LmsRef } from "~/shared/domain/ids";
import { workspaceStore } from "~/renderer/stores/workspace";

import { Button } from "../ui/button";
import { Refusal } from "./parts";

/** Drafts the change and goes to its thread, which shows the preview and the approval. It writes nothing itself. */
export function SaveTemplateButton({
  course,
  size = "sm",
  variant = "outline",
}: {
  course: LmsRef<"course">;
  size?: "sm" | "lg";
  variant?: "default" | "outline";
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    const result = await workspaceStore().getState().proposeTemplate(course);
    setBusy(false);
    setRefused(result.ok ? null : result.error);
    if (result.ok)
      void navigate({ to: "/threads/$threadId", params: { threadId: result.value.thread } });
  };
  return (
    <div className="flex items-center gap-2">
      <Refusal text={refused} />
      <Button
        variant={variant}
        size={size}
        disabled={busy}
        data-testid="save-template"
        onClick={() => void save()}
      >
        Save as template for next term
      </Button>
    </div>
  );
}
