import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import type { ChangeId, LmsRef, SchoolId, ThreadId } from "~/domain/ids";
import { isOpenRow, type ReviewRow } from "~/domain/setup";
import { editableAfter } from "~/domain/splice";
import { cn } from "~/lib/utils";
import { selectThreadUi } from "~/stores/selectors";
import { useWorkspace, workspaceStore } from "~/stores/workspace";

import { ApproveButton } from "../ApproveButton";
import { StatusPill } from "../StatusPill";
import { batchPhase, outcomeSummary } from "../thread/batch.logic";
import { useThreadActions } from "../thread/context";
import { RecoveryBanner } from "../thread/RecoveryBanner";
import { SendPreview } from "../thread/SendPreview";
import { editChange, revokeApproval, useChange, type ChangeView } from "../thread/useChange";
import { approvalResetWords } from "../thread/writeback.logic";
import { Button } from "../ui/button";
import { Refusal } from "./parts";
import { batchOf, groupRows, rowName, rowQuote, rowWord, selectableKeys } from "./setup.logic";
import { FIELD_CLASS } from "./styles";
import type { RowKey } from "~/stores/types";

function EditFix({ view, onDone }: { view: ChangeView; onDone: () => void }) {
  const { content, id } = view.record;
  const { lead, words } =
    content.kind === "text-fix" ? editableAfter(content.splice) : { lead: "", words: "" };
  const [text, setText] = useState(words);
  const [refused, setRefused] = useState<string | null>(null);
  const save = () => {
    const problem = editChange(id, { kind: "text-fix", after: lead + text });
    setRefused(problem);
    if (!problem) onDone();
  };
  return (
    <div className="flex flex-col gap-2 px-card py-card-head-y">
      <textarea
        aria-label="New text"
        data-testid="finding-edit-text"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className={cn(FIELD_CLASS, "h-auto py-field-y")}
      />
      <Refusal text={refused} />
      <div className="flex gap-btn-gap">
        <Button size="sm" data-testid="finding-edit-save" onClick={save}>
          Save
        </Button>
        <Button variant="ghost-muted" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DismissFix({
  course,
  row,
  onDone,
}: {
  course: LmsRef<"course">;
  row: ReviewRow;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const dismiss = () => {
    const problem = workspaceStore()
      .getState()
      .dismissFinding(course, row.key, reason || null);
    setRefused(problem);
    if (!problem) onDone();
  };
  return (
    <div className="flex flex-col gap-2 px-card py-card-head-y">
      <div className="flex items-center gap-btn-gap">
        <input
          aria-label="Why, if you like"
          data-testid="finding-dismiss-reason"
          placeholder="Why, if you like"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={cn(FIELD_CLASS, "flex-1")}
        />
        <Button
          variant="destructive-outline"
          size="sm"
          data-testid="finding-dismiss-confirm"
          onClick={dismiss}
        >
          Dismiss
        </Button>
        <Button variant="ghost-muted" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <Refusal text={refused} />
    </div>
  );
}

function RowDetail({
  course,
  school,
  row,
  view,
}: {
  course: LmsRef<"course">;
  school: SchoolId;
  row: ReviewRow;
  view: ChangeView | null;
}) {
  const [mode, setMode] = useState<"edit" | "dismiss" | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const vendor = useWorkspace((state) => state.vendorLabelFor(school) ?? "the LMS");
  const store = () => workspaceStore().getState();
  const open = isOpenRow(row);
  const summary = view?.summary ?? null;
  const moved = summary?.recovery === "rescan";
  const reset = summary && approvalResetWords(summary.approvalReset);
  const scanAgain = () => void store().scanNow(course).then(setRefused);
  return (
    <div className="flex flex-col border-t border-border">
      {row.finding && (
        <div className="flex flex-col gap-1 px-card py-card-head-y text-body">
          <p>{row.finding.why}</p>
          {!view && rowQuote(row) && (
            <p className="whitespace-pre-wrap text-meta text-muted-foreground">{rowQuote(row)}</p>
          )}
          {row.resolution?.reason && (
            <p className="text-meta text-muted-foreground">Your reason: {row.resolution.reason}</p>
          )}
        </div>
      )}
      {view && !moved && <RecoveryBanner view={view} />}
      {moved && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-warning/25 bg-warning/8 px-banner-x py-banner-y text-body"
        >
          <p className="min-w-0 flex-1">The passage moved after this fix was drafted.</p>
          <Button variant="outline" size="sm" data-testid="scan-again" onClick={scanAgain}>
            Scan again
          </Button>
        </div>
      )}
      {view && <SendPreview fields={view.preview} summary={view.summary} />}
      {reset && (
        <p data-approval-reset className="mx-card mt-2 text-meta text-warning-foreground">
          {reset}
        </p>
      )}
      {mode === "edit" && view && <EditFix view={view} onDone={() => setMode(null)} />}
      {mode === "dismiss" && <DismissFix course={course} row={row} onDone={() => setMode(null)} />}
      {mode === null && (
        <div className="flex flex-wrap items-center justify-end gap-btn-gap px-card py-row-y empty:hidden">
          <Refusal text={refused} />
          {row.finding?.openUrl && (
            <a
              data-testid="finding-open"
              href={row.finding.openUrl}
              target="_blank"
              rel="noreferrer"
              className="link mr-auto flex items-center gap-1 text-meta"
            >
              Open in {vendor} <ArrowUpRight className="size-3" />
            </a>
          )}
          {open && (
            <Button
              variant="ghost-muted"
              size="sm"
              data-testid="finding-dismiss"
              onClick={() => setMode("dismiss")}
            >
              Dismiss
            </Button>
          )}
          {!open && row.resolution && (
            <Button
              variant="outline"
              size="sm"
              data-testid="finding-restore"
              onClick={() => void store().restoreFinding(course, row.key).then(setRefused)}
            >
              Restore
            </Button>
          )}
          {(row.status === "manual" || row.status === "still-here") && (
            <Button
              variant="outline"
              size="sm"
              data-testid="finding-handled"
              onClick={() => setRefused(store().markHandled(course, row.key))}
            >
              I handled it
            </Button>
          )}
          {view?.record.content.kind === "text-fix" && summary?.canEdit && (
            <Button
              variant="outline"
              size="sm"
              data-testid="finding-edit"
              onClick={() => setMode("edit")}
            >
              Edit
            </Button>
          )}
          {view && summary?.canUndoApproval && (
            <Button
              variant="ghost-muted"
              size="sm"
              data-undo-approval
              data-lands="[data-approve]"
              onClick={() => revokeApproval(view.record.id)}
            >
              Undo approval
            </Button>
          )}
          {view && summary?.canApprove && (
            <ApproveButton
              targets={[view.record]}
              label="Approve"
              testId="finding-approve"
              size="sm"
            />
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  course,
  school,
  thread,
  row,
  opened,
  onOpen,
  checked,
  onCheck,
  selectable,
}: {
  course: LmsRef<"course">;
  school: SchoolId;
  thread: ThreadId;
  row: ReviewRow;
  opened: boolean;
  onOpen: (key: string | null) => void;
  checked: boolean;
  onCheck: () => void;
  selectable: boolean;
}) {
  const id = row.change?.id ?? null;
  const view = useChange(id);
  const word = rowWord(row, view?.summary ?? row.summary);
  const toggle = () => {
    onOpen(opened ? null : row.key);
    workspaceStore()
      .getState()
      .focusChange(thread, opened ? null : id);
  };
  return (
    <li
      data-row={row.key}
      data-testid="finding-row"
      data-finding-key={row.key}
      data-status={row.status}
      className={cn("flex scroll-mt-2 flex-col", opened && "bg-background/40")}
    >
      <div
        data-row-hit
        className="flex min-h-row-table items-center gap-2 border-t border-border pr-row-end pl-row-x"
      >
        {selectable ? (
          <input
            type="checkbox"
            data-testid="finding-toggle"
            aria-label={`Select ${rowName(row)}`}
            checked={checked}
            onChange={onCheck}
            className="size-3.5 flex-none accent-primary"
          />
        ) : (
          <span className="size-3.5 flex-none" />
        )}
        <button
          type="button"
          aria-expanded={opened}
          onClick={toggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded text-left"
        >
          <ChevronRight
            className={cn(
              "size-3 flex-none text-muted-foreground transition-transform duration-100",
              opened && "rotate-90",
            )}
          />
          <span className="max-w-[60%] flex-none truncate text-body">{rowName(row)}</span>
          <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">
            {rowQuote(row)}
          </span>
        </button>
        <StatusPill tone={word.tone} label={word.label} />
      </div>
      {opened && <RowDetail course={course} school={school} row={row} view={view} />}
    </li>
  );
}

function BatchBar({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly ReviewRow[];
  selected: readonly RowKey[];
  onSelect: (keys: readonly RowKey[]) => void;
}) {
  const { send, busy } = useThreadActions();
  const [sent, setSent] = useState<readonly ChangeId[]>([]);
  const batch = batchOf(rows, selected);
  const keys = selectableKeys(rows);
  const items = rows.flatMap(({ change, summary }) =>
    change && summary && sent.includes(change.id) ? [{ summary, busy: busy.has(change.id) }] : [],
  );
  const summaries = items.map((item) => item.summary);
  const phase = batchPhase(items);
  if (keys.length === 0 && sent.length === 0) return null;
  const go = () => {
    setSent(batch.send);
    send(batch.send);
  };
  return (
    <div
      data-testid="batch-bar"
      className="sticky bottom-0 z-10 flex flex-wrap items-center gap-btn-gap rounded-b-[9px] border-t border-border bg-card py-row-y pr-row-end pl-row-x"
    >
      {keys.length > 0 && (
        <Button
          variant="ghost-muted"
          size="sm"
          data-testid="batch-select-all"
          onClick={() => onSelect(selected.length > 0 ? [] : keys)}
        >
          {selected.length > 0 ? "Clear" : `Select all ${keys.length}`}
        </Button>
      )}
      <span
        data-testid="batch-outcome"
        aria-live="polite"
        className="min-w-0 flex-1 text-meta text-muted-foreground"
      >
        {sent.length > 0 &&
          (phase === "outcome" ? outcomeSummary(summaries) : `Sending ${sent.length}.`)}
      </span>
      {keys.length > 0 && (
        <>
          <ApproveButton
            targets={batch.approve}
            label={`Approve ${batch.approve.length}`}
            testId="batch-approve"
            size="lg"
          />
          {batch.send.length > 0 && (
            <Button
              variant={batch.approve.length > 0 ? "outline" : "default"}
              size="lg"
              data-testid="batch-send"
              onClick={go}
            >
              Send {batch.send.length} approved
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export function ReviewCard({
  course,
  school,
  thread,
  rows,
  opened,
  onOpen,
}: {
  course: LmsRef<"course">;
  school: SchoolId;
  thread: ThreadId;
  rows: readonly ReviewRow[];
  opened: string | null;
  onOpen: (key: string | null) => void;
}) {
  const { setUi } = useThreadActions();
  const { selected } = useWorkspace((state) => selectThreadUi(state, thread));
  const groups = useMemo(() => groupRows(rows), [rows]);
  const selectable = useMemo(() => new Set<string>(selectableKeys(rows)), [rows]);
  const toggle = (key: RowKey) =>
    setUi({
      selected: selected.includes(key)
        ? selected.filter((held) => held !== key)
        : [...selected, key],
    });
  const live = selected.filter((key) => selectable.has(key));
  return (
    <div
      data-testid="finding-list"
      className="flex flex-col rounded-card border border-input bg-card"
    >
      {groups.length === 0 && (
        <h3 className="px-card py-card-head-y text-title">The scan found nothing to fix.</h3>
      )}
      {groups.map((group) => (
        <section
          key={group.type}
          data-testid={`finding-group-${group.type}`}
          className="flex flex-col"
        >
          <h3 className="flex min-h-row-one items-center gap-2 px-row-x text-title text-foreground">
            {group.label}
            <span className="font-normal text-muted-foreground tabular-nums">
              {group.rows.length}
            </span>
          </h3>
          <ul className="flex flex-col">
            {group.rows.map((row) => (
              <Row
                key={row.key}
                course={course}
                school={school}
                thread={thread}
                row={row}
                opened={opened === row.key}
                onOpen={onOpen}
                checked={live.includes(row.key)}
                onCheck={() => toggle(row.key)}
                selectable={selectable.has(row.key)}
              />
            ))}
          </ul>
        </section>
      ))}
      <BatchBar rows={rows} selected={live} onSelect={(keys) => setUi({ selected: keys })} />
    </div>
  );
}
