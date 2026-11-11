import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  MessageSquare,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { cn } from "~/lib/utils";
import type { QueueFilter, RowKey, Thread, ThreadUi } from "~/stores/types";
import { useAiOn } from "~/stores/workspace";

import { SchoolBadge } from "../SchoolBadge";
import { CompactStatus, StatusPill } from "../StatusPill";
import { SubmissionBadge } from "../ui/badge";
import { Button } from "../ui/button";
import { CHIP, toggleState } from "../ui/toggle";
import { Picker } from "../settings/Picker";
import { useThreadActions } from "./context";
import { cardFloor } from "./DraftCard";
import {
  assignmentChoices,
  moreWords,
  nameFillsStrip,
  neighbor,
  queueChips,
  queueProgress,
  rowLine,
  rowStatus,
  rowsOutOfView,
  runOf,
  selectable,
  spansSchools,
  splitSelection,
  type WorkRow,
} from "./queue.logic";

// The inner width and left edge of What's due's column, so both lists sit on one axis. A row's hover box is this column, and the progress line and filters span the same box, so all three share both edges while the scroller around the rows stays full width.
const COLUMN = "mx-auto w-[calc(100%-2rem)] max-w-[calc(var(--container-chat)-2rem)]";

function Progress({
  rows,
  currentKey = null,
  placeOnly = false,
}: {
  rows: readonly WorkRow[];
  currentKey?: string | null;
  placeOnly?: boolean;
}) {
  const { label, place, sent, fraction } = queueProgress(rows, currentKey);
  return (
    <>
      <span className="flex flex-none items-baseline gap-x-1 text-meta tabular-nums">
        <span data-testid="queue-progress" className="text-secondary-label">
          {place ?? label}
        </span>
        {place && !placeOnly && <span className="text-muted-foreground">· {sent}</span>}
      </span>
      <span className="h-[3px] w-16 flex-none overflow-hidden rounded-full bg-foreground/8 @max-[600px]/queue:hidden">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${fraction * 100}%` }}
        />
      </span>
    </>
  );
}

function QueueRowView({
  row,
  line,
  showSchool,
  selected,
  checkbox,
  current,
  cursor,
  drafting,
  onToggle,
}: {
  row: WorkRow;
  line: string;
  showSchool: boolean;
  selected: boolean;
  checkbox: "hidden" | "on" | "off";
  current: boolean;
  cursor: boolean;
  drafting: boolean;
  onToggle: () => void;
}) {
  const { openRow, messageRow } = useThreadActions();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (cursor) ref.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const status = rowStatus(row, drafting);
  // A dot can't say what went wrong, so a row that needs someone keeps its words however narrow the queue gets.
  const needsWords = status.tone === "attention";
  const flagged = row.lateDays > 0 || row.resubmitted || row.missing;
  return (
    <li
      ref={ref}
      data-row={row.key}
      data-current={current}
      data-cursor={cursor}
      className={cn(
        COLUMN,
        "flex items-center gap-2 pr-row-end pl-row-x",
        line || showSchool ? "min-h-row-two" : "min-h-row-one",
        "focus-inset rounded-md hover:bg-accent",
        current && "row-selected",
        cursor && "bg-accent",
        !row.open && "text-tertiary-label",
      )}
    >
      {checkbox !== "hidden" && (
        <span className="flex h-5 flex-none items-center">
          <input
            type="checkbox"
            aria-label={`Select ${row.title}`}
            checked={selected}
            disabled={checkbox === "off"}
            onChange={onToggle}
            className="size-3.5 accent-primary"
          />
        </span>
      )}
      <button
        type="button"
        data-lands='[data-testid="thread-panel"]'
        onClick={() => openRow(row)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-1 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          {/* The status follows the name, so the eye never crosses the row to find it. */}
          <span className="flex min-w-0 items-center gap-2">
            <span title={row.title} className="min-w-0 truncate text-body">
              {row.title}
            </span>
            {flagged && (
              <span data-testid="row-badges" className="flex flex-none items-center gap-1.5">
                {row.lateDays > 0 && (
                  <SubmissionBadge status="late">{row.lateDays}d late</SubmissionBadge>
                )}
                {row.resubmitted && <SubmissionBadge status="resubmitted" />}
                {row.missing && <SubmissionBadge status="missing" />}
              </span>
            )}
            <StatusPill
              {...status}
              className={cn("flex-none", !needsWords && "@max-[360px]/queue:hidden")}
            />
            {!needsWords && (
              <CompactStatus {...status} className="hidden @max-[360px]/queue:inline-flex" />
            )}
          </span>
          {(line || showSchool) && (
            <span className="flex min-w-0 items-center gap-x-2 text-meta text-muted-foreground">
              {showSchool && <SchoolBadge school={row.school} />}
              {line && <span className="min-w-0 truncate">{line}</span>}
            </span>
          )}
        </span>
      </button>
      {row.missing && (
        <Button
          variant="ghost-muted"
          size="meta"
          className="flex-none"
          aria-label={`Message ${row.title}`}
          title="Message the student without grading"
          onClick={() => messageRow(row)}
        >
          <MessageSquare />
          Message
        </Button>
      )}
    </li>
  );
}

export function SelectionBar({
  rows,
  selected,
  batching = false,
}: {
  rows: readonly WorkRow[];
  selected: readonly string[];
  batching?: boolean;
}) {
  const { draftRows, setUi, drafting } = useThreadActions();
  const ai = useAiOn();
  const { toDraft, toReview, drafting: waiting } = splitSelection(rows, selected, drafting);
  // Once part of an open batch has landed, the panel is the one place that counts it.
  if (batching && toDraft.length + toReview.length + waiting.length < selected.length) return null;
  return (
    <div className="flex flex-none items-center gap-2 border-t border-border bg-card py-3 pr-4 pl-row-x">
      <span className="flex-1 text-meta text-secondary-label">{selected.length} selected</span>
      <Button variant="ghost-muted" size="sm" onClick={() => setUi({ selected: [] })}>
        Clear
      </Button>
      {waiting.length > 0 && (
        <span data-testid="selection-drafting" className="text-meta text-muted-foreground">
          Drafting {waiting.length}
        </span>
      )}
      {ai && toDraft.length > 0 && (
        <Button size="sm" disabled={drafting.size > 0} onClick={() => void draftRows(toDraft)}>
          Draft {toDraft.length}
        </Button>
      )}
      {/* A batch opened now would leave out the rows still drafting, and Approve would skip them unseen (#249). */}
      {toReview.length > 0 && waiting.length === 0 && !batching && (
        <Button
          variant="default"
          size="sm"
          data-lands='[data-testid="thread-panel"]'
          onClick={() => setUi({ panel: "batch" })}
        >
          Review {toReview.length}
        </Button>
      )}
    </div>
  );
}

const rowsOf = (list: HTMLElement): readonly HTMLElement[] => [
  ...list.querySelectorAll<HTMLElement>("[data-row]"),
];

const useRowsOutOfView = (
  list: RefObject<HTMLElement | null>,
  shown: readonly WorkRow[],
  open: boolean,
) => {
  const [above, setAbove] = useState(0);
  const [below, setBelow] = useState(0);
  useEffect(() => {
    const box = list.current;
    const measure = () => {
      const hidden = box
        ? rowsOutOfView(
            box.getBoundingClientRect(),
            rowsOf(box).map((row) => row.getBoundingClientRect()),
          )
        : { above: 0, below: 0 };
      setAbove(hidden.above);
      setBelow(hidden.below);
    };
    measure();
    if (!box) return;
    box.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => {
      box.removeEventListener("scroll", measure);
      observer.disconnect();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the rows in the DOM follow shown and open, so a change to either re-measures
  }, [list, shown, open]);
  return { above, below };
};

// The open list takes up to this share of the thread, cut at a row's edge so no row shows in half. On a short screen it gives up rows, down to one, so the focused card and its comment stay in view (#207).
const LIST_SHARE = 0.46;

const useWholeRows = (
  on: boolean,
  shown: readonly WorkRow[],
  selecting: boolean,
  currentKey: string | null,
) => {
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const box = list.current;
    const section = box?.parentElement;
    const main = section?.parentElement;
    if (!box || !section || !main) return;
    // Clearing the cap only when the list stops being capped: uncapping it even for a moment resets its scroll to the top.
    if (!on) {
      box.style.maxHeight = "";
      return;
    }
    const fit = () => {
      const row = box.querySelector<HTMLElement>("[data-row]")?.offsetHeight;
      if (!row) return;
      const frame =
        box.offsetHeight - box.clientHeight + parseFloat(getComputedStyle(box).paddingBottom);
      const above = section.offsetHeight - box.offsetHeight;
      const share = Math.floor((main.clientHeight * LIST_SHARE - above - frame) / row);
      const chat = main.querySelector<HTMLElement>('[data-testid="chat"]');
      const floor = chat ? cardFloor(chat) : 0;
      const besideCard =
        chat && floor
          ? Math.floor((box.offsetHeight - frame + chat.clientHeight - floor) / row)
          : share;
      const rows = Math.max(Math.min(share, besideCard), 1);
      box.style.maxHeight = `${rows * row + frame}px`;
    };
    fit();
    // The thread, not the list, so setting the list's height never re-triggers this observer.
    const observer = new ResizeObserver(fit);
    observer.observe(main);
    // The card can change height as the chat resizes, so its refit waits a frame: resizing the chat inside that callback is a ResizeObserver loop (#159).
    const pending = { frame: 0 };
    const card = new ResizeObserver(() => {
      cancelAnimationFrame(pending.frame);
      pending.frame = requestAnimationFrame(fit);
    });
    const content = main.querySelector('[data-testid="chat"]')?.firstElementChild;
    if (content) card.observe(content);
    return () => {
      observer.disconnect();
      card.disconnect();
      cancelAnimationFrame(pending.frame);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the rows, the selection bar and the focused card change the heights fit reads
  }, [on, shown, selecting, currentKey]);
  return list;
};

export function PinnedQueue({
  thread,
  ui,
  shown,
  cursor,
  currentKey,
  batching = false,
  fill = false,
}: {
  thread: Thread;
  ui: ThreadUi;
  shown: readonly WorkRow[];
  cursor: number;
  currentKey: string | null;
  batching?: boolean;
  fill?: boolean;
}) {
  const { rows, setUi, openRow, drafting } = useThreadActions();
  const ai = useAiOn();
  const clear = rows.length > 0 && rows.every((row) => !row.open);
  const empty = rows.length === 0;
  const current = rows.find((row) => row.key === currentKey) ?? null;
  const nameFills = current !== null && nameFillsStrip(current.title);
  const where = current && !nameFills && rowLine(current, thread);
  // A row opened from outside the ticks has no place among them, so the header walks every row.
  const ticked = runOf(rows, ui.selected);
  const run = current && !ticked.includes(current) ? rows : ticked;
  const previous = current && neighbor(run, current.key, -1);
  const following = current ? neighbor(run, current.key, 1) : (run[0] ?? null);
  const toggleRow = (key: RowKey) =>
    setUi({
      selected: ui.selected.includes(key)
        ? ui.selected.filter((k) => k !== key)
        : [...ui.selected, key],
    });
  const line = "flex h-btn-md flex-none items-center gap-2";
  const list = useWholeRows(ui.queueOpen && !fill, shown, ui.selected.length > 0, currentKey);
  const hidden = useRowsOutOfView(list, shown, ui.queueOpen);
  const more = moreWords(hidden);
  const revealNext = () => {
    const all = list.current ? rowsOf(list.current) : [];
    all[hidden.below > 0 ? all.length - hidden.below : hidden.above - 1]?.scrollIntoView({
      block: "nearest",
    });
  };
  const batched = batching ? shown.filter((row) => ui.selected.includes(row.key)) : [];
  const anchor = (batched.find((row) => row.summary?.tone === "attention") ?? batched[0])?.key;
  useEffect(() => {
    if (anchor)
      list.current
        ?.querySelector(`[data-row="${CSS.escape(anchor)}"]`)
        ?.scrollIntoView({ block: "center" });
  }, [anchor, list]);

  if (empty) {
    return (
      <section
        data-testid="pinned-queue"
        className={cn(line, "border-b border-border text-meta text-muted-foreground")}
      >
        {thread.kind === "messages"
          ? "No messages waiting in this course."
          : "Nothing to grade here."}
      </section>
    );
  }

  if (!ui.queueOpen) {
    return (
      <section
        data-testid="pinned-queue"
        data-open="false"
        className="@container/queue flex min-h-btn-md flex-none items-center gap-2 border-b border-border bg-card pr-4 pl-row-x py-0.5"
      >
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label="Expand queue"
          title="Expand queue"
          onClick={() => setUi({ queueOpen: true })}
        >
          <ChevronDown />
        </Button>
        <span className="flex min-w-0 flex-1 items-baseline gap-x-1 text-body">
          {clear ? (
            <span className="text-success-foreground">The queue is clear.</span>
          ) : current ? (
            <>
              <span title={current.title} className="min-w-0 truncate">
                {current.title}
              </span>
              {where && (
                <span
                  title={where}
                  className="min-w-0 flex-[1_1_72px] truncate text-muted-foreground"
                >
                  · {where}
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">Nothing open</span>
          )}
        </span>
        <Progress rows={run} currentKey={clear ? null : currentKey} placeOnly={nameFills} />
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label="Previous in queue"
          title="Previous in queue"
          disabled={!previous}
          onClick={() => previous && openRow(previous)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label="Next in queue"
          title="Next in queue"
          disabled={!following}
          onClick={() => following && openRow(following)}
        >
          <ChevronRight />
        </Button>
      </section>
    );
  }

  const chips = queueChips(rows);
  const assignments = assignmentChoices(rows);
  const start = runOf(shown, ui.selected).find((row) => row.open);
  const showSchool = !thread.course && spansSchools(rows);
  const pickable = shown.filter((row) => selectable(row, ai)).map((row) => row.key);
  return (
    <section
      data-testid="pinned-queue"
      data-open="true"
      className={cn(
        "@container/queue flex flex-col border-b border-border bg-card",
        fill ? "min-h-0 flex-1" : "flex-none",
      )}
    >
      <div className={cn(line, COLUMN)}>
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label="Collapse queue"
          title="Collapse queue"
          onClick={() => setUi({ queueOpen: false })}
        >
          <ChevronUp />
        </Button>
        <Progress rows={rows} />
        {clear && (
          <span className="flex items-center gap-1.5 text-meta text-success-foreground">
            <CheckCircle2 className="size-3.5" />
            The queue is clear.
          </span>
        )}
        {more && (
          <Button
            variant="ghost-muted"
            size="meta"
            data-testid="queue-more"
            className="ml-auto"
            onClick={revealNext}
          >
            {more}
          </Button>
        )}
      </div>
      <div className={cn(COLUMN, "flex flex-none flex-wrap items-center gap-1 pb-2")}>
        {chips.map((chip) => (
          <button
            key={chip.filter}
            type="button"
            aria-pressed={ui.queueFilter === chip.filter}
            onClick={() => setUi({ queueFilter: chip.filter })}
            className={cn(CHIP, "flex-none px-2", toggleState(ui.queueFilter === chip.filter))}
          >
            {chip.label}
            <span className="tabular-nums text-tertiary-label">{chip.count}</span>
          </button>
        ))}
        {assignments.length > 0 && (
          <Picker
            label="Assignment"
            items={[
              { value: "all", label: "All assignments" },
              ...assignments.map((choice) => ({
                value: choice.filter,
                label: `${choice.label} · ${choice.count}`,
              })),
            ]}
            value={ui.queueFilter.startsWith("assignment:") ? ui.queueFilter : "all"}
            onChange={(value) => setUi({ queueFilter: value as QueueFilter })}
            className={cn(
              "h-btn-sm max-w-[280px] rounded-full text-meta",
              ui.queueFilter.startsWith("assignment:") && toggleState(true),
            )}
          />
        )}
        <span className="ml-auto flex flex-none items-center gap-1">
          {pickable.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setUi({ selected: [...new Set([...ui.selected, ...pickable])] })}
            >
              Select all shown
            </Button>
          )}
          {!current && start && !batching && (
            <Button
              variant="default"
              size="sm"
              data-testid="queue-start"
              data-lands='[data-testid="thread-panel"]'
              onClick={() => openRow(start)}
            >
              {thread.kind === "messages" ? "Start replying" : "Start grading"}
            </Button>
          )}
        </span>
      </div>
      <ul
        ref={list}
        data-testid="queue-list"
        className="row-dividers min-h-0 flex-1 overflow-y-auto border-t border-border pb-px"
      >
        {shown.map((row, index) => (
          <QueueRowView
            key={row.key}
            row={row}
            line={rowLine(row, thread)}
            showSchool={showSchool}
            selected={ui.selected.includes(row.key)}
            checkbox={pickable.length === 0 ? "hidden" : pickable.includes(row.key) ? "on" : "off"}
            current={row.key === currentKey}
            cursor={index === cursor}
            drafting={drafting.has(row.key)}
            onToggle={() => toggleRow(row.key)}
          />
        ))}
      </ul>
      {ui.selected.length > 0 && (
        <SelectionBar rows={rows} selected={ui.selected} batching={batching} />
      )}
    </section>
  );
}
