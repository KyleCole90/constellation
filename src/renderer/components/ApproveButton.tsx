import { useState, type MouseEvent, type ReactNode } from "react";

import { ApprovalWitness, fingerprintOf, type ApprovalTarget } from "~/shared/domain/approval";
import { riskOf, type ChangeRecord } from "~/shared/domain/change";
import { isoTime } from "~/shared/domain/ids";
import { workspaceStore } from "~/renderer/stores/workspace";

import { riskPrompt, type RiskPrompt } from "./approve.logic";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from "./ui/dialog";

/**
 * The only place a witness is minted, by this button or by `approveByChord`. It fingerprints the records it was rendered with, so a draft that moved
 * after this render makes the click stale. A scripted click isn't trusted, so it mints nothing.
 * A risky change (a copy into a course with people or content) opens a dialog first, and the dialog's confirm button
 * is the trusted click that mints, carrying the risk the person typed the course code to face. A batch never includes one.
 */
const approveAll = (targets: readonly ChangeRecord[], witness: ApprovalWitness): boolean => {
  const { dispatchUser, now } = workspaceStore().getState();
  const at = isoTime(now());
  return targets
    .map((record) => dispatchUser(record.id, { type: "approve", witness, at }))
    .every((result) => result.ok);
};

/** ⌘↵ on a grade only you have edited. Pass the record as it is after the typed comment committed, which is what the card shows. */
export const approveByChord = (press: KeyboardEvent, record: ChangeRecord): boolean => {
  const witness = ApprovalWitness.fromChord(press, {
    changeId: record.id,
    fingerprint: fingerprintOf(record),
  });
  return witness !== null && approveAll([record], witness);
};

export function ApproveButton({
  targets,
  label,
  testId,
  size = "md",
  kbd,
  onApproved,
}: {
  targets: readonly ChangeRecord[];
  label: string;
  testId?: string;
  size?: "sm" | "md" | "lg";
  kbd?: ReactNode;
  onApproved?: () => void;
}) {
  const [stale, setStale] = useState(false);
  const [prompt, setPrompt] = useState<RiskPrompt | null>(null);
  const [typed, setTyped] = useState("");
  const risky = targets.filter((record) => riskOf(record) !== null);
  const guarded = targets.length === 1 && risky.length === 1 ? targets[0] : null;

  const mint = (
    event: MouseEvent<HTMLButtonElement>,
    approvalTargets: readonly ApprovalTarget[],
  ) => {
    const witness = ApprovalWitness.fromClick(event.nativeEvent, approvalTargets);
    if (!witness) return;
    const approved = approveAll(targets, witness);
    setStale(!approved);
    if (approved) onApproved?.();
  };

  const approve = (event: MouseEvent<HTMLButtonElement>) => {
    if (guarded) {
      setTyped("");
      setPrompt(riskPrompt(guarded));
      return;
    }
    mint(
      event,
      targets.map((record) => ({ changeId: record.id, fingerprint: fingerprintOf(record) })),
    );
  };

  const confirm = (event: MouseEvent<HTMLButtonElement>) => {
    const risk = guarded ? riskOf(guarded) : null;
    if (!guarded || risk === null || !prompt || typed !== prompt.code) return;
    setPrompt(null);
    mint(event, [{ changeId: guarded.id, fingerprint: fingerprintOf(guarded), risk }]);
  };

  if (targets.length > 1 && risky.length > 0) {
    return (
      <span className="text-meta text-muted-foreground">
        A course copy into a course with people or content is approved on its own, not in a batch.
      </span>
    );
  }

  return (
    <>
      {stale && (
        <span className="text-meta text-warning-foreground">
          The draft changed. Check it and approve again.
        </span>
      )}
      <Button
        variant="default"
        size={size}
        data-approve
        data-lands='[data-undo-approval], [data-testid="thread-panel"]'
        data-testid={testId}
        disabled={targets.length === 0}
        onClick={approve}
      >
        <span className="tabular-nums">{label}</span>
        {kbd}
      </Button>
      {guarded && (
        <Dialog open={prompt !== null} onOpenChange={(open) => !open && setPrompt(null)}>
          {prompt && (
            <DialogPopup>
              <DialogTitle>{prompt.title}</DialogTitle>
              <DialogDescription>{prompt.body}</DialogDescription>
              <input
                data-confirm-code
                aria-label={`Type ${prompt.code} to confirm`}
                className="h-field w-full rounded-md border border-border bg-transparent px-field-x text-body"
                autoComplete="off"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
              <div className="flex justify-end gap-btn-gap">
                <DialogClose render={<Button variant="ghost-muted" size="lg" />}>
                  Cancel
                </DialogClose>
                <Button
                  variant="default"
                  size="lg"
                  data-approve-confirm
                  disabled={typed !== prompt.code}
                  onClick={confirm}
                >
                  {label}
                </Button>
              </div>
            </DialogPopup>
          )}
        </Dialog>
      )}
    </>
  );
}
