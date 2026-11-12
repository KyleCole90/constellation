import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { ChangeRecord } from "~/shared/domain/change";
import { selectSubmission, summarizeFor } from "~/renderer/stores/selectors";
import { useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { ApproveButton } from "../ApproveButton";
import { SchoolBadge } from "../SchoolBadge";
import { StatusPill } from "../StatusPill";
import { Button } from "../ui/button";
import {
  batchPhase,
  identicalDrafts,
  identicalNote,
  laneMessage,
  outcomeSummary,
  retryTargets,
} from "./batch.logic";
import { useThreadActions } from "./context";
import { splitSelection } from "./queue.logic";
import { SendPreview } from "./SendPreview";
import { useChange } from "./useChange";
import { missingWords } from "./writeback.logic";
import type { RowKey } from "~/renderer/stores/types";

const LANE_TICK_MS = 250;

function BatchSection({
  record,
  removable,
  onRemove,
}: {
  record: ChangeRecord;
  removable: boolean;
  onRemove: () => void;
}) {
  const view = useChange(record.id);
  if (!view) return null;
  return (
    <section data-batch-item={record.id} className="rounded-card border border-border">
      <div
        data-testid="batch-item-header"
        className={`sticky top-0 z-[1] flex items-center gap-2 rounded-t-card border-b border-border bg-card py-2 pl-card ${removable ? "pr-2" : "pr-card"}`}
      >
        <SchoolBadge school={record.school} />
        <div className="min-w-0 flex-1">
          <div className="wrap-anywhere text-title">{record.subject}</div>
        </div>
        <StatusPill tone={view.summary.tone} label={view.summary.label} />
        {removable && (
          <Button
            variant="ghost-muted"
            size="icon"
            aria-label={`Remove ${record.subject}`}
            onClick={onRemove}
          >
            <X />
          </Button>
        )}
      </div>
      {view.summary.missing.length > 0 && (
        <p data-testid="still-missing" className="px-card pt-2 text-meta text-muted-foreground">
          {missingWords(view.summary.missing)}
        </p>
      )}
      <SendPreview fields={view.preview} summary={view.summary} />
    </section>
  );
}

function ProgressRow({ record, onOpen }: { record: ChangeRecord; onOpen: () => void }) {
  const view = useChange(record.id);
  if (!view) return null;
  return (
    <li data-progress-item={record.id}>
      <button
        type="button"
        onClick={onOpen}
        className="flex h-btn-sm w-full cursor-pointer items-center gap-2 rounded px-3 text-left text-meta hover:bg-accent"
      >
        <SchoolBadge school={record.school} />
        <span className="min-w-0 flex-1 truncate">{record.subject}</span>
        <StatusPill tone={view.summary.tone} label={view.summary.label} />
      </button>
    </li>
  );
}

const useLaneMessages = (records: readonly ChangeRecord[], active: boolean): readonly string[] => {
  const [messages, setMessages] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!active) return;
    const read = () => {
      const state = workspaceStore().getState();
      const paused = new Set(records.map((record) => record.school));
      setMessages(
        [...paused].flatMap((id) => {
          const lane = state.laneStatus(id);
          const school = state.schools.find((candidate) => candidate.id === id);
          return lane.state === "paused" && school
            ? [laneMessage(school.name, lane.until, state.now())]
            : [];
        }),
      );
    };
    read();
    const timer = window.setInterval(read, LANE_TICK_MS);
    return () => {
      window.clearInterval(timer);
      setMessages([]);
    };
  }, [records, active]);
  return messages;
};

export function BatchPanel({ selected }: { selected: readonly RowKey[] }) {
  const { setUi, send, busy, focus, batch, rows, drafting } = useThreadActions();
  const waiting = splitSelection(rows, selected, drafting).drafting;
  const records = useWorkspace(
    useShallow((state) => batch.flatMap((id) => state.changes[id] ?? [])),
  );
  const connections = useWorkspace((state) => state.connections);
  const online = useWorkspace((state) => state.online);
  const students = useWorkspace(
    useShallow((state) =>
      records.map((record) =>
        record.content.kind === "grade"
          ? (selectSubmission(state, record.content.target)?.studentName ?? null)
          : null,
      ),
    ),
  );
  const identical = useMemo(
    () =>
      identicalDrafts(
        records.flatMap((record, i) => {
          const student = students[i];
          return student ? [{ id: record.id, student, content: record.content }] : [];
        }),
      ),
    [records, students],
  );
  const items = useMemo(
    () =>
      records.map((record) => ({
        id: record.id,
        record,
        summary: summarizeFor(record, connections[record.school]?.status, online),
      })),
    [records, connections, online],
  );
  const summaries = items.map((item) => item.summary);
  const phase = batchPhase(items.map((item) => ({ ...item, busy: busy.has(item.id) })));
  const stableRecords = useMemo(() => items.map((item) => item.record), [items]);
  const laneMessages = useLaneMessages(stableRecords, phase === "sending");

  // Approving or sending now would skip a ticked row whose draft hasn't landed.
  const ready = waiting.length === 0;
  const approvable = ready ? items.filter((item) => item.summary.canApprove) : [];
  const sendable = ready
    ? items.filter((item) => item.summary.canSend && item.summary.banner === null)
    : [];
  const retryable = retryTargets(items);
  const remove = (record: ChangeRecord) =>
    setUi({ selected: selected.filter((key) => key !== record.content.target) });
  const open = (id: ChangeRecord["id"]) => {
    focus(id);
    // One draft open is one row open, so the list folds to the header that names it, as opening it from the list does.
    setUi({ panel: "writeback", queueOpen: false });
  };

  return (
    <>
      <div data-testid="batch-header" className="flex-none border-b border-border bg-card">
        <div data-action-bar className="flex h-10 items-center gap-btn-gap pr-2 pl-card">
          <span className="min-w-0 flex-1 truncate text-body font-medium">
            {phase === "outcome" ? (
              <span data-testid="batch-outcome">{outcomeSummary(summaries)}</span>
            ) : (
              `${phase === "sending" ? "Sending" : "Review"} ${items.length} ${items.length === 1 ? "change" : "changes"}`
            )}
          </span>
          {phase === "review" && approvable.length > 0 && (
            <ApproveButton
              targets={approvable.map((item) => item.record)}
              label={`Approve ${approvable.length}`}
            />
          )}
          {phase === "review" && sendable.length > 0 && (
            <Button
              size="md"
              variant={approvable.length === 0 ? "default" : "outline"}
              onClick={() => send(sendable.map((item) => item.id))}
            >
              <span className="tabular-nums">Send {sendable.length}</span>
            </Button>
          )}
          {phase === "outcome" && retryable.length > 0 && (
            <Button size="md" variant="default" onClick={() => send(retryable)}>
              Retry failed
            </Button>
          )}
          <Button
            variant="ghost-muted"
            size="icon"
            aria-label="Close batch"
            onClick={() =>
              setUi(phase === "review" ? { panel: null } : { panel: null, selected: [] })
            }
          >
            <X />
          </Button>
        </div>
        {phase === "review" && !ready && (
          <p
            data-testid="batch-waiting"
            className="border-t border-border px-card py-1 text-meta text-muted-foreground"
          >
            Still drafting {waiting.map((row) => row.title).join(", ")}. Approve waits for{" "}
            {waiting.length === 1 ? "it" : "them"}.
          </p>
        )}
        {phase === "review" &&
          identical.map((group) => (
            <div
              key={group.map((draft) => draft.id).join()}
              data-testid="identical-drafts"
              className="flex items-center gap-2 border-t border-border px-card py-1"
            >
              <p className="min-w-0 flex-1 text-meta text-warning-foreground">
                {identicalNote(group.map((draft) => draft.student))}
              </p>
              <div className="flex flex-none">
                {group.map((draft) => (
                  <Button
                    key={draft.id}
                    variant="ghost-info"
                    size="meta"
                    onClick={() => open(draft.id)}
                  >
                    Open {draft.student.split(" ")[0]}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        {phase !== "review" && (
          <div className="border-t border-border px-1 py-2">
            {laneMessages.map((message) => (
              <p
                key={message}
                data-testid="lane-message"
                className="px-3 pb-1 text-meta text-warning-foreground"
              >
                {message}
              </p>
            ))}
            <ul
              data-testid="batch-progress"
              className="flex max-h-[140px] flex-col overflow-y-auto"
            >
              {items.map((item) => (
                <ProgressRow key={item.id} record={item.record} onOpen={() => open(item.id)} />
              ))}
            </ul>
          </div>
        )}
      </div>
      <div
        data-testid="batch-scroll"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-card"
      >
        {items.map((item) => (
          <BatchSection
            key={item.id}
            record={item.record}
            removable={phase === "review"}
            onRemove={() => remove(item.record)}
          />
        ))}
        {items.length === 0 && (
          <p className="p-4 text-body text-muted-foreground">Nothing left in this batch.</p>
        )}
      </div>
    </>
  );
}
