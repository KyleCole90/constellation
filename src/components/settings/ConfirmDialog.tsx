import { useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    await onConfirm();
    setBusy(false);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription render={<div />} className="flex flex-col gap-2">
          {children}
        </DialogDescription>
        <div className="flex justify-end gap-btn-gap">
          <DialogClose render={<Button variant="ghost-muted" size="lg" />}>Cancel</DialogClose>
          <Button
            variant="destructive-outline"
            size="lg"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
