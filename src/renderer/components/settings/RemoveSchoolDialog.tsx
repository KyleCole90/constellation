import { VAULT_PLACE } from "~/renderer/desktop";
import type { School } from "~/shared/domain/lms";

import { ConfirmDialog } from "./ConfirmDialog";

export function RemoveSchoolDialog({
  school,
  open,
  onOpenChange,
  onConfirm,
}: {
  school: School;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove ${school.name}?`}
      confirmLabel="Remove"
      onConfirm={onConfirm}
    >
      <p>
        This forgets the token in {VAULT_PLACE} and the course data read from {school.host}.
      </p>
      <p>Nothing is deleted from the LMS. Add the school again at any time.</p>
    </ConfirmDialog>
  );
}
