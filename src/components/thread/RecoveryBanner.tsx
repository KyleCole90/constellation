import { AlertTriangle } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ConflictChoice, FieldKey } from "~/domain/change";
import { selectSubmission } from "~/stores/selectors";
import { cn } from "~/lib/utils";
import { REJECTION_TEXT, useWorkspace, workspaceStore } from "~/stores/workspace";

import { TokenDialog } from "../TokenDialog";
import { Button } from "../ui/button";
import { CHIP, toggleState } from "../ui/toggle";
import { useThreadActions } from "./context";
import { focusDraftField, type ChangeView } from "./useChange";
import {
  conflictColumns,
  conflictOptions,
  fieldCount,
  lastOutsideNote,
  outcomeWords,
  retryRemainingLabel,
  unwritten,
} from "./writeback.logic";

function Frame({
  kind,
  title,
  children,
  actions,
}: {
  kind: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      data-banner={kind}
      role="alert"
      className="fade-in flex flex-col gap-2 border-t border-warning/25 bg-warning/8 px-banner-x py-banner-y"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-[3px] size-3.5 flex-none text-warning-foreground" />
        <div className="min-w-0 flex-1 text-body">
          <div className="font-medium">{title}</div>
          {children && <div className="mt-0.5 text-secondary-label">{children}</div>}
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center justify-end gap-btn-gap">{actions}</div>
      )}
    </div>
  );
}

function EditButton({ onEdit }: { onEdit: () => void }) {
  return <Button onClick={onEdit}>Edit</Button>;
}

function ConflictBanner({ view }: { view: ChangeView }) {
  const { record, summary } = view;
  const [choices, setChoices] = useState<Readonly<Partial<Record<FieldKey, ConflictChoice>>>>({});
  const [error, setError] = useState<string | null>(null);
  const outsideNote = useWorkspace((state) => {
    const submission =
      record.content.kind === "grade" ? selectSubmission(state, record.content.target) : null;
    return submission ? lastOutsideNote(submission.comments) : null;
  });
  const allChosen = summary.conflicts.every((conflict) => choices[conflict.field]);
  const resolve = async () => {
    const result = await workspaceStore().getState().resolveConflict(record.id, choices);
    if (!result.ok)
      setError(
        result.error in REJECTION_TEXT
          ? ((REJECTION_TEXT as Record<string, string>)[result.error] ?? null)
          : "Couldn't read the LMS. Try again in a moment.",
      );
  };
  return (
    <div
      data-banner="conflict"
      role="alert"
      className="fade-in flex flex-col gap-2 border-t border-warning/25 bg-warning/8 px-banner-x py-banner-y"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-[3px] size-3.5 flex-none text-warning-foreground" />
        <div className="text-body">
          <div className="font-medium">This changed in the LMS after the draft was read.</div>
          <div className="mt-0.5 text-secondary-label">
            Nothing was overwritten. Choose what to keep for each field.
          </div>
          {outsideNote && (
            <div data-who className="mt-0.5 text-secondary-label">
              {outsideNote}
            </div>
          )}
        </div>
      </div>
      {summary.conflicts.map((conflict) => {
        const columns = conflictColumns(conflict);
        return (
          <div
            key={conflict.field}
            data-conflict={conflict.field}
            className="overflow-hidden rounded-lg border border-border bg-background"
          >
            <div className="border-b border-border px-2.5 py-1 text-meta">
              <span className="font-medium">{columns.title}</span>{" "}
              <span className="text-muted-foreground">{columns.why}</span>
            </div>
            <div className="grid grid-cols-3 divide-x divide-border text-meta">
              {[
                ["Draft saw", columns.saw],
                ["LMS holds now", columns.now],
                ["You propose", columns.mine],
              ].map(([heading, value]) => (
                <div key={heading} className="min-w-0 px-row-x py-row-y">
                  <div className="text-meta text-muted-foreground">{heading}</div>
                  <div className="break-words whitespace-pre-wrap">{value}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-btn-gap border-t border-border px-row-x py-row-y">
              {conflictOptions(conflict).map((option) => (
                <button
                  key={option.choice}
                  type="button"
                  aria-pressed={choices[conflict.field] === option.choice}
                  onClick={() => setChoices({ ...choices, [conflict.field]: option.choice })}
                  className={cn(CHIP, toggleState(choices[conflict.field] === option.choice))}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {error && <p className="text-meta text-error-foreground">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <span className="text-meta text-muted-foreground">
          It returns to draft and needs a fresh approval.
        </span>
        <Button variant="default" disabled={!allChosen} onClick={() => void resolve()}>
          Resolve and return to draft
        </Button>
      </div>
    </div>
  );
}

function ReconnectBanner({
  view,
  kind,
  title,
  words,
}: {
  view: ChangeView;
  kind: "reconnect" | "forbidden";
  title: string;
  words: string;
}) {
  const { send } = useThreadActions();
  const [open, setOpen] = useState(false);
  const { record, summary } = view;
  return (
    <>
      <Frame
        kind={kind}
        title={title}
        actions={
          <>
            {(summary.waitingOnReconnect || kind === "forbidden") && (
              <Button variant="default" onClick={() => setOpen(true)}>
                Reconnect
              </Button>
            )}
            {!summary.waitingOnReconnect && (
              <Button onClick={() => send([record.id])}>Retry</Button>
            )}
          </>
        }
      >
        {words}
      </Frame>
      <TokenDialog school={record.school} open={open} onOpenChange={setOpen} />
    </>
  );
}

function InDoubtBanner({ view }: { view: ChangeView }) {
  const { send } = useThreadActions();
  const [checked, setChecked] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    const result = await workspaceStore().getState().checkAgain(view.record.id);
    setChecking(false);
    setChecked(
      result === "still-unconfirmed"
        ? "Still can't confirm. The LMS doesn't show it yet."
        : result === "unreachable"
          ? "Couldn't reach the LMS to check."
          : null,
    );
  };
  return (
    <Frame
      kind="in-doubt"
      title="We could not confirm this reached the LMS."
      actions={
        <>
          <Button variant="default" disabled={checking} onClick={() => void check()}>
            Check again
          </Button>
          <Button onClick={() => send([view.record.id])}>Resume, could post twice</Button>
        </>
      }
    >
      {outcomeWords(view.preview)} Check again only reads. Resume writes again, and if the first
      attempt landed late it could post twice.
      {checked && (
        <div data-checked className="mt-1 text-warning-foreground">
          {checked}
        </div>
      )}
    </Frame>
  );
}

/** `onEdit` defaults to the field on the same screen. A thread's preview passes one that first closes itself, since the field sits behind it. */
export function RecoveryBanner({
  view,
  onEdit = focusDraftField,
}: {
  view: ChangeView;
  onEdit?: () => void;
}) {
  const { send } = useThreadActions();
  const { record, summary, preview } = view;
  const school = useWorkspace((state) => state.schools.find((s) => s.id === record.school));
  const left = fieldCount(unwritten(preview).length);
  switch (summary.banner) {
    case null:
      return null;
    case "reconnect":
      return summary.waitingOnReconnect ? (
        <ReconnectBanner
          view={view}
          kind="reconnect"
          title={`${school?.name ?? "This school"} token expired. Nothing was lost.`}
          words={`${left} not written yet. Reconnect and you can pick up from here.`}
        />
      ) : (
        <ReconnectBanner
          view={view}
          kind="reconnect"
          title="Reconnected. Nothing was lost."
          words={`${left} not written yet.`}
        />
      );
    case "forbidden":
      return (
        <ReconnectBanner
          view={view}
          kind="forbidden"
          title="The LMS refused this token."
          words={summary.reason ?? ""}
        />
      );
    case "conflict":
      return <ConflictBanner view={view} />;
    case "partial":
      return (
        <Frame
          kind="partial"
          title="Part of this went through."
          actions={
            <>
              <EditButton onEdit={onEdit} />
              <Button variant="default" onClick={() => send([record.id])}>
                {retryRemainingLabel(preview)}
              </Button>
            </>
          }
        >
          {outcomeWords(preview)}
        </Frame>
      );
    case "in-doubt":
      return <InDoubtBanner view={view} />;
    case "interrupted":
      return (
        <Frame
          kind="interrupted"
          title="The send was interrupted before it finished."
          actions={
            <Button variant="default" onClick={() => send([record.id])}>
              Resume
            </Button>
          }
        >
          {outcomeWords(preview)} Resume checks the LMS first and sends only what's left.
        </Frame>
      );
    case "rejected":
    case "failed":
      return (
        <Frame
          kind={summary.banner}
          title={
            summary.banner === "rejected"
              ? "The LMS rejected this."
              : summary.retriesExhausted
                ? "We retried and ran out of tries."
                : "This didn't send."
          }
          actions={
            <>
              <EditButton onEdit={onEdit} />
              <Button variant="default" onClick={() => send([record.id])}>
                Retry
              </Button>
            </>
          }
        >
          {summary.reason} {outcomeWords(preview)}
        </Frame>
      );
  }
}
