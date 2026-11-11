import type { ReactNode } from "react";

import type { ChangeId } from "~/shared/domain/ids";
import { formatTime } from "~/renderer/lib/utils";
import { useWorkspace } from "~/renderer/stores/workspace";

import { ApproveButton } from "../ApproveButton";
import { StatusPill } from "../StatusPill";
import { useThreadActions } from "../thread/context";
import { RecoveryBanner } from "../thread/RecoveryBanner";
import { SendPreview } from "../thread/SendPreview";
import { revokeApproval, useChange, type ChangeView } from "../thread/useChange";
import { approvalResetWords } from "../thread/writeback.logic";
import { Button } from "../ui/button";
import { Note } from "./parts";
import { FOOTER_CLASS } from "./styles";

function Footer({
  view,
  name,
  sendLabel,
  stale,
}: {
  view: ChangeView;
  name: string;
  sendLabel: string;
  stale: string | null;
}) {
  const { busy, send } = useThreadActions();
  const { record, summary } = view;
  const vendor = useWorkspace((state) => state.vendorLabelFor(record.school) ?? "the LMS");
  if (summary.sentAt)
    return (
      <div data-action-bar className={FOOTER_CLASS}>
        <Note>
          Sent to {vendor} at {formatTime(summary.sentAt)}.
        </Note>
      </div>
    );
  if (summary.banner) return null;
  if (busy.has(record.id) || summary.tone === "working")
    return (
      <div data-action-bar className={FOOTER_CLASS}>
        <span className="dot-pulse size-1.5 rounded-full bg-info-foreground" />
        <Note>Sending to {vendor}.</Note>
      </div>
    );
  if (stale)
    return (
      <div data-action-bar className={FOOTER_CLASS}>
        <p data-testid={`${name}-stale`} className="text-meta text-warning-foreground">
          {stale}
        </p>
      </div>
    );
  return (
    <div data-action-bar className={FOOTER_CLASS}>
      <span className="min-w-0 flex-1 text-meta text-muted-foreground">
        {summary.canSend
          ? "Approved. Nothing has gone yet."
          : `Nothing goes to ${vendor} until you approve it.`}
      </span>
      {summary.canApprove && (
        <ApproveButton targets={[record]} label="Approve" testId={`${name}-approve`} size="lg" />
      )}
      {summary.canUndoApproval && (
        <Button
          variant="ghost-muted"
          size="lg"
          data-undo-approval
          data-lands="[data-approve]"
          onClick={() => revokeApproval(record.id)}
        >
          Undo approval
        </Button>
      )}
      {summary.canSend && (
        <Button
          variant="default"
          size="lg"
          data-testid={`${name}-send`}
          onClick={() => send([record.id])}
        >
          {sendLabel}
        </Button>
      )}
    </div>
  );
}

/** One change, from preview through approval to send. `name` prefixes its test ids: copy, publish, or template. `stale` says why the card on screen can't be approved or sent yet. `children` add to the preview. */
export function SetupChangeCard({
  id,
  name,
  sendLabel,
  stale = null,
  children,
}: {
  id: ChangeId;
  name: string;
  sendLabel: (vendor: string) => string;
  stale?: string | null;
  children?: ReactNode;
}) {
  const view = useChange(id);
  const vendor = useWorkspace((state) =>
    view ? (state.vendorLabelFor(view.record.school) ?? "the LMS") : "the LMS",
  );
  if (!view) return null;
  const reset = approvalResetWords(view.summary.approvalReset);
  return (
    <article
      data-change={id}
      data-testid={`${name}-card`}
      className="flex scroll-mt-2 flex-col rounded-card border border-input bg-card"
    >
      <header className="flex items-center gap-2 rounded-t-card border-b border-border px-card py-card-head-y">
        <h3 className="min-w-0 flex-1 truncate text-title">{view.record.subject}</h3>
        {stale ? (
          <StatusPill tone="attention" label="Out of date" />
        ) : (
          <StatusPill tone={view.summary.tone} label={view.summary.label} />
        )}
      </header>
      <RecoveryBanner view={view} />
      <SendPreview fields={view.preview} summary={view.summary} />
      {children}
      {reset && (
        <p data-approval-reset className="px-card pt-2 text-meta text-warning-foreground">
          {reset}
        </p>
      )}
      <Footer view={view} name={name} sendLabel={sendLabel(vendor)} stale={stale} />
    </article>
  );
}
