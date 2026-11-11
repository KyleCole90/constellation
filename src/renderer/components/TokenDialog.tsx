import { useState } from "react";

import type { SchoolId } from "~/shared/domain/ids";
import { useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { TokenForm } from "./TokenForm";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "./ui/dialog";

const WORDS = {
  connected: {
    title: (name: string) => `Replace the token for ${name}`,
    words:
      "The new token takes over once the school accepts it. If it doesn't, the current one stays. Tokens go in the vault and are never shown again.",
    submit: "Replace token",
  },
  expired: {
    title: (name: string) => `Reconnect ${name}`,
    words:
      "Your unsent work and approvals stay as they are, and reconnecting sends nothing by itself. The token goes in the vault and is never shown again.",
    submit: "Connect",
  },
  disconnected: {
    title: (name: string) => `Connect ${name}`,
    words:
      "Your unsent work and approvals stay as they are. The token goes in the vault and is never shown again.",
    submit: "Connect",
  },
} as const;

/** Mounted only while open, so its words stay put when connecting flips the school's status underneath it. */
function TokenDialogBody({ school, onDone }: { school: SchoolId; onDone: () => void }) {
  const name = useWorkspace(
    (state) => state.schools.find((s) => s.id === school)?.name ?? "this school",
  );
  const [words] = useState(
    () => WORDS[workspaceStore().getState().connections[school]?.status ?? "disconnected"],
  );
  return (
    <>
      <DialogTitle>{words.title(name)}</DialogTitle>
      <DialogDescription>{words.words}</DialogDescription>
      <TokenForm school={school} submitLabel={words.submit} onConnected={onDone} />
    </>
  );
}

export function TokenDialog({
  school,
  open,
  onOpenChange,
}: {
  school: SchoolId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <TokenDialogBody school={school} onDone={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}
