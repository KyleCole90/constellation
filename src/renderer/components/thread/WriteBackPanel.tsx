import { CheckCircle2, ChevronRight } from "lucide-react";

import { OFFLINE_SEND_REASON } from "~/renderer/desktop";
import { cn, formatTime } from "~/renderer/lib/utils";
import { selectCourse } from "~/renderer/stores/selectors";
import { useWorkspace } from "~/renderer/stores/workspace";

import { ApproveButton } from "../ApproveButton";
import { SchoolBadge } from "../SchoolBadge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { DiscardButton } from "./DraftCard";
import { useThreadActions } from "./context";
import { RecoveryBanner } from "./RecoveryBanner";
import { SendPreview } from "./SendPreview";
import { revokeApproval, useEditDraft, type ChangeView } from "./useChange";
import { missingWords } from "./writeback.logic";
import { approvalResetWords, previewHeading } from "./writeback.logic";

const STEPS = ["Draft", "Approved", "Sent"] as const;
// Its basis is its one line, so the words share a row with the buttons when they fit and take their own when they don't.
const FOOTER_TEXT = "flex-[1_1_auto] text-meta text-muted-foreground";
const FOOTER_BUTTONS = "ml-auto flex min-w-0 items-center gap-btn-gap";

// A read-only progress line, so nothing about it looks pressable.
function Flow({ index }: { index: number }) {
  return (
    <ol data-testid="flow" aria-label="Progress" className="flex items-center gap-2 text-meta">
      {STEPS.map((step, position) => (
        <li
          key={step}
          aria-current={position === index ? "step" : undefined}
          className={cn(
            "flex items-center gap-1.5",
            position === index ? "text-foreground" : "text-tertiary-label",
          )}
        >
          {position > 0 && <span aria-hidden className="h-px w-3 bg-foreground/15" />}
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              position < index
                ? "bg-success-foreground"
                : position === index
                  ? "bg-current"
                  : "border border-current",
            )}
          />
          {step}
        </li>
      ))}
    </ol>
  );
}

// The footer shows only the next real step, so Send appears once there is an approval to send.
function Footer({ view }: { view: ChangeView }) {
  const { busy, send, next, openRow } = useThreadActions();
  const { record, summary } = view;
  const vendor = useWorkspace((state) => state.vendorLabelFor(record.school) ?? "the LMS");
  const host = useWorkspace((state) => state.schools.find((s) => s.id === record.school)?.host);
  const online = useWorkspace((state) => state.online);
  const sending = busy.has(record.id) || summary.tone === "working";
  const base =
    "flex flex-none flex-wrap items-center justify-end gap-x-btn-gap gap-y-2 border-t border-border bg-card px-card py-3";

  if (summary.sentAt) {
    return (
      <div className={cn(base, "bg-success/11")}>
        <p
          data-testid="sent-banner"
          className="fade-in flex flex-[1_1_auto] items-center gap-2 text-body text-success-foreground"
        >
          <CheckCircle2 className="size-3.5 flex-none" />
          Written to {host} at {formatTime(summary.sentAt)}.
        </p>
        {next && (
          <Button variant="default" size="lg" className="min-w-0" onClick={() => openRow(next)}>
            <span className="truncate">Next: {next.title}</span>
            <Kbd variant="on-primary">⌘↵</Kbd>
          </Button>
        )}
      </div>
    );
  }
  const discard = <DiscardButton view={view} size="lg" />;
  // The send promise outlives the failure, so busy alone would claim it's still sending under a recovery banner.
  if (summary.banner)
    return summary.canDiscard ? (
      <div className={base}>
        <div className={FOOTER_BUTTONS}>{discard}</div>
      </div>
    ) : null;
  if (sending) {
    return (
      <div className={base}>
        <span className="dot-pulse size-1.5 rounded-full bg-info-foreground" />
        <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">
          {summary.label === "Waiting on the LMS"
            ? "The LMS asked us to slow down. Waiting."
            : `Sending to ${vendor}.`}
        </span>
      </div>
    );
  }
  if (summary.missing.length > 0) {
    return (
      <div className={base}>
        <span data-testid="still-missing" className={FOOTER_TEXT}>
          {missingWords(summary.missing)}
        </span>
        <div className={FOOTER_BUTTONS}>
          {discard}
          <Button size="lg" disabled>
            Approve
          </Button>
        </div>
      </div>
    );
  }
  if (summary.canApprove) {
    return (
      <div className={base}>
        <span className={FOOTER_TEXT}>Nothing goes to {vendor} until you approve it.</span>
        <div className={FOOTER_BUTTONS}>
          {discard}
          <ApproveButton targets={[record]} label="Approve" size="lg" />
        </div>
      </div>
    );
  }
  return (
    <div className={base}>
      <span data-testid="send-state" className={FOOTER_TEXT}>
        {!online
          ? OFFLINE_SEND_REASON
          : summary.approvedAt && `Approved by you at ${formatTime(summary.approvedAt)}.`}
      </span>
      <div className={FOOTER_BUTTONS}>
        {discard}
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
        <Button
          variant="default"
          size="lg"
          disabled={!summary.canSend}
          data-lands='[data-testid="thread-panel"]'
          onClick={() => send([record.id])}
        >
          Send to {vendor}
          <Kbd variant="on-primary">⌘↵</Kbd>
        </Button>
      </div>
    </div>
  );
}

export function WriteBackPanel({ view }: { view: ChangeView }) {
  const { setUi, batch } = useThreadActions();
  const edit = useEditDraft();
  const { record, summary, preview } = view;
  const course = useWorkspace((state) => selectCourse(state, record.course));
  const school = useWorkspace((state) => state.schools.find((s) => s.id === record.school));
  const reset = approvalResetWords(summary.approvalReset);
  const step = summary.sentAt ? 2 : summary.approvedAt ? 1 : 0;

  return (
    <>
      <div
        data-testid="writeback-scroll"
        data-panel-scroll
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {batch.length > 0 && (
          <button
            type="button"
            onClick={() => setUi({ panel: "batch", queueOpen: true })}
            className="flex h-btn-sm w-full cursor-pointer items-center border-b border-border px-card text-left text-meta text-info-foreground hover:bg-accent"
          >
            Back to batch
          </button>
        )}
        <div className="flex flex-col gap-2 border-b border-border px-card py-3">
          <div className="flex items-start gap-2">
            <SchoolBadge school={record.school} />
            <div className="min-w-0 flex-1">
              <div className="wrap-anywhere text-title">{record.subject}</div>
              <div className="text-meta text-muted-foreground">
                {school?.name} · {course?.code}
              </div>
            </div>
          </div>
          <Flow index={step} />
          {record.content.kind === "announcement" && course && (
            <div data-testid="audience" className="text-meta text-secondary-label">
              Posts to all {course.studentCount} {course.code} students
            </div>
          )}
        </div>
        <h3
          data-testid="preview-heading"
          className="border-b border-border px-card py-2 text-meta text-secondary-label"
        >
          {previewHeading(preview, Boolean(summary.sentAt), school?.host ?? "the LMS")}
        </h3>
        <SendPreview fields={preview} summary={summary} />
        <details data-testid="activity" className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-card py-2 text-meta text-muted-foreground hover:text-foreground focus-inset [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 flex-none transition-transform duration-100 group-open:rotate-90" />
            Activity ({record.activity.length})
          </summary>
          <ol className="flex flex-col gap-1 px-card pb-3 text-meta">
            {record.activity.map((entry, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- entries are rendered whole from props and carry no id
              <li key={index} className="flex gap-2">
                <span className="w-[58px] flex-none text-muted-foreground tabular-nums">
                  {formatTime(entry.at)}
                </span>
                <span className="text-secondary-label">{entry.text}</span>
              </li>
            ))}
          </ol>
        </details>
      </div>
      <div data-testid="action-banners" className="max-h-[60%] flex-none overflow-y-auto">
        <RecoveryBanner view={view} onEdit={edit} />
        {reset && (
          <p
            data-approval-reset
            className="fade-in border-t border-warning/25 bg-warning/8 px-banner-x py-banner-y text-body text-warning-foreground"
          >
            {reset}
          </p>
        )}
      </div>
      <Footer view={view} />
    </>
  );
}
