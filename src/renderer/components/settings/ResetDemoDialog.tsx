import { useNavigate } from "@tanstack/react-router";

import { workspaceStore } from "~/renderer/stores/workspace";

import { ConfirmDialog } from "./ConfirmDialog";

export function ResetDemoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reset demo data?"
      confirmLabel="Reset demo data"
      onConfirm={async () => {
        await workspaceStore().getState().resetDemoData();
        await navigate({ to: "/welcome", replace: true });
      }}
    >
      <p>This wipes everything in this browser and starts over at the welcome screen:</p>
      <ul className="flex list-disc flex-col gap-0.5 pl-4">
        <li>Every change, draft, and approval</li>
        <li>Every thread and its messages</li>
        <li>Your saved school tokens and AI key</li>
        <li>The fake LMS, including its grades and the writes log</li>
      </ul>
      <p>It can't be undone. Nothing here is a real school, so nothing real changes.</p>
    </ConfirmDialog>
  );
}
