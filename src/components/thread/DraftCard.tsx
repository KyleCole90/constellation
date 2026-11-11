import { Link } from "@tanstack/react-router";
import { Check, Minus, Paperclip, Pencil, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { OVERALL_RATIONALE } from "~/agent/agent";
import {
  finalGrade,
  sendsOnChord,
  latePenalty,
  rawScore,
  zeroPatch,
  type ChangeRecord,
  type ChangeSummary,
  type GradeContent,
  type RubricScore,
} from "~/domain/change";
import type { ChangeId } from "~/domain/ids";
import { ratingLabel } from "~/domain/preview";
import { workLine } from "~/domain/workName";
import { cn } from "~/lib/utils";
import { selectConversation, selectCourse, selectSubmission } from "~/stores/selectors";
import type { ThreadUi } from "~/stores/types";
import { useWorkspace } from "~/stores/workspace";

import { ApproveButton } from "../ApproveButton";
import { AfterQueue } from "./AfterQueue";
import { SchoolBadge } from "../SchoolBadge";
import { StatusPill } from "../StatusPill";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { criterionHue, criterionNumbers } from "./anchors.logic";
import { useRationale, useThreadActions } from "./context";
import {
  discardChange,
  useAgentFlash,
  useChange,
  useEditDraft,
  editChange,
  type ChangeView,
} from "./useChange";
import { useCommitOnLeave } from "./useCommitOnLeave";
import { parseScore, stepScore } from "./score.logic";
import { approvalResetWords } from "./writeback.logic";

const cardHeadId = (id: ChangeId): string => `card-head-${id}`;

/** The one-line look a draft takes when it isn't the card being worked on. */
const COMPACT_ROW =
  "flex h-btn-md flex-none items-center gap-2 rounded-lg border border-border bg-card";

const FIELD =
  "block w-full resize-none rounded-lg border border-input bg-background px-field-x py-field-y text-chat outline-none [field-sizing:content] focus:border-ring/60 read-only:text-secondary-label";

const cardLabel = (summary: ChangeSummary): string =>
  summary.tone === "ready" ? "Approved. Not sent" : summary.label;

function CardHead({ view, name }: { view: ChangeView; name?: React.ReactNode }) {
  const { record, summary } = view;
  const course = useWorkspace((state) => selectCourse(state, record.course));
  const line = course ? workLine(record.content, course.code) : null;
  return (
    <div id={cardHeadId(record.id)} className="flex items-center gap-2">
      <SchoolBadge school={record.school} />
      <div className="min-w-0 flex-1">
        {name ?? <div className="wrap-anywhere text-title">{record.subject}</div>}
        {line && (
          <div data-card-line className="truncate text-meta text-muted-foreground">
            {line}
          </div>
        )}
      </div>
      <StatusPill tone={summary.tone} label={cardLabel(summary)} />
    </div>
  );
}

function TypedScore({
  value,
  outOf,
  disabled,
  label,
  onCommit,
}: {
  value: number | null;
  outOf: number;
  disabled: boolean;
  label: string;
  onCommit: (next: number | null) => void;
}) {
  const shown = value === null ? "" : String(value);
  const [text, setText] = useState(shown);
  const [synced, setSynced] = useState(shown);
  if (synced !== shown) {
    setSynced(shown);
    setText(shown);
  }
  const commit = () => {
    if (!text.trim()) {
      if (value !== null) onCommit(null);
      return;
    }
    const next = parseScore(text, outOf);
    if (next === null) setText(shown);
    else {
      setText(String(next));
      if (next !== value) onCommit(next);
    }
  };
  useCommitOnLeave(commit);
  const step = (by: 1 | -1) => {
    const next = stepScore(parseScore(text, outOf) ?? value, by, outOf);
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      aria-label={`Type ${label}`}
      data-typed-score
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          // A capped or rejected score would change on blur, so ⌘↵ waits until the person has seen what it became.
          const typed = text.trim();
          if (typed && parseScore(text, outOf) !== Number(typed)) event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          step(event.key === "ArrowUp" ? 1 : -1);
        }
      }}
      className="w-8 rounded border border-input bg-background text-center text-body font-medium text-foreground outline-none focus:border-ring/60"
    />
  );
}

function Stepper({
  value,
  outOf,
  disabled,
  label,
  typed,
  onStep,
}: {
  value: number | null;
  outOf: number;
  disabled: boolean;
  label: string;
  typed: boolean;
  onStep: (next: number | null) => void;
}) {
  return (
    <div className="flex flex-none items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        aria-label={`Lower ${label}`}
        tabIndex={-1}
        disabled={disabled || value === null || value <= 0}
        onClick={() => onStep(stepScore(value, -1, outOf))}
      >
        <Minus />
      </Button>
      <span
        data-score
        className="min-w-[62px] text-right tabular-nums text-meta text-muted-foreground"
      >
        {typed ? (
          <TypedScore
            value={value}
            outOf={outOf}
            disabled={disabled}
            label={label}
            onCommit={onStep}
          />
        ) : (
          <b className="text-body font-medium text-foreground">{value}</b>
        )}{" "}
        / {outOf}
      </span>
      <Button
        variant="outline"
        size="icon"
        aria-label={`Raise ${label}`}
        tabIndex={-1}
        disabled={disabled || (value !== null && value >= outOf)}
        onClick={() => onStep(stepScore(value, 1, outOf))}
      >
        <Plus />
      </Button>
    </div>
  );
}

function CriterionNumber({ number }: { number: number | undefined }) {
  if (number === undefined) return null;
  return (
    <span data-row-number className="crit-number" style={{ "--crit": criterionHue(number) }}>
      {number}
    </span>
  );
}

function RubricRow({
  record,
  score,
  order,
  canEdit,
  onError,
}: {
  record: ChangeRecord;
  score: RubricScore;
  order: readonly string[];
  canEdit: boolean;
  onError: (text: string | null) => void;
}) {
  const link = useRationale();
  const flash = useAgentFlash(score.points, record);
  const rationale = record.rationale.find((entry) => entry.field === score.criterion);
  const ref = useRef<HTMLDivElement>(null);
  const selected = link.selected === score.criterion;
  const linked = (rationale?.anchors.length ?? 0) > 0;
  const number = criterionNumbers(order, record.rationale).get(score.criterion);
  useEffect(() => {
    if (selected && link.from === "passage") ref.current?.scrollIntoView({ block: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- tick bumps on every selection, so choosing the same criterion again scrolls again
  }, [selected, link.from, link.tick]);
  return (
    <div
      ref={ref}
      data-criterion={score.criterion}
      data-selected={selected}
      data-hovered={link.hover === score.criterion}
      data-flash={flash}
      onMouseEnter={() => link.setHover(score.criterion)}
      onMouseLeave={() => link.setHover(null)}
      className={cn(
        "flex flex-col gap-0.5 px-row-x py-row-y transition-colors",
        selected ? "row-selected" : link.hover === score.criterion && "bg-accent",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 text-body">
          <CriterionNumber number={number} />
          {score.name}
        </span>
        {score.points !== null && (
          <span className="flex-none text-meta text-muted-foreground">
            {ratingLabel(score.points, score.outOf)}
          </span>
        )}
        <Stepper
          value={score.points}
          outOf={score.outOf}
          disabled={!canEdit}
          label={score.name}
          typed={record.activity[0]?.actor === "you"}
          onStep={(points) =>
            onError(
              editChange(record.id, { kind: "grade", rubricPoints: { [score.criterion]: points } }),
            )
          }
        />
      </div>
      {rationale && (
        <button
          type="button"
          data-rationale
          data-row-reason
          data-text-link
          aria-label={linked ? `Jump to passage for ${score.name}: ${rationale.why}` : undefined}
          title={linked ? "Jump to the passage this reason marks" : undefined}
          onClick={() => link.selectFromRow(score.criterion)}
          className="cursor-pointer self-start text-left text-body text-muted-foreground hover:text-foreground"
        >
          {rationale.why}
        </button>
      )}
    </div>
  );
}

function OverallRow({
  record,
  content,
  canEdit,
  onError,
}: {
  record: ChangeRecord;
  content: GradeContent;
  canEdit: boolean;
  onError: (text: string | null) => void;
}) {
  const link = useRationale();
  const points = content.points;
  const flash = useAgentFlash(points, record);
  const rationale = record.rationale.find((entry) => entry.field === OVERALL_RATIONALE);
  return (
    <div
      data-flash={flash}
      data-selected={link.selected === OVERALL_RATIONALE}
      className="flex items-center gap-3 px-row-x py-row-y"
    >
      <div className="min-w-0 flex-1">
        <div className="text-body">
          <CriterionNumber
            number={criterionNumbers([OVERALL_RATIONALE], record.rationale).get(OVERALL_RATIONALE)}
          />
          Score
        </div>
        {rationale && (
          <button
            type="button"
            data-rationale
            data-text-link
            onClick={() => link.selectFromRow(OVERALL_RATIONALE)}
            className="cursor-pointer text-left text-body text-muted-foreground hover:text-foreground"
          >
            {rationale.why}
          </button>
        )}
      </div>
      <Stepper
        value={points}
        outOf={content.outOf}
        disabled={!canEdit}
        label="score"
        typed={record.activity[0]?.actor === "you"}
        onStep={(next) => onError(editChange(record.id, { kind: "grade", points: next }))}
      />
    </div>
  );
}

function TotalRow({
  label,
  children,
  strong,
  note,
}: {
  label: string;
  children: React.ReactNode;
  strong?: boolean;
  note?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3",
        strong ? "text-body" : "text-meta text-muted-foreground",
      )}
    >
      <span>{label}</span>
      {note && (
        <span className="min-w-0 flex-1 text-right text-meta text-muted-foreground">{note}</span>
      )}
      <span className="flex-none tabular-nums">{children}</span>
    </div>
  );
}

/** Commits on blur or when the field goes away, so typing doesn't reset an approval on every keystroke. */
function EditableText({
  value,
  field,
  label,
  multiline,
  readOnly,
  autoFocus,
  record,
  fieldRef,
  onCommit,
}: {
  value: string;
  field?: boolean;
  label: string;
  multiline?: boolean;
  readOnly: boolean;
  autoFocus?: boolean;
  record: ChangeRecord;
  fieldRef?: RefObject<HTMLTextAreaElement | null>;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setText(value);
  }
  const flash = useAgentFlash(value, record);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  useCommitOnLeave(commit);
  return multiline === false ? (
    <input
      aria-label={label}
      value={text}
      readOnly={readOnly}
      autoFocus={autoFocus}
      data-flash={flash}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      className={FIELD}
    />
  ) : (
    <textarea
      ref={fieldRef}
      aria-label={label}
      value={text}
      readOnly={readOnly}
      data-edit-field={field ? "" : undefined}
      data-flash={flash}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      className={cn(FIELD, "min-h-16")}
    />
  );
}

function TitleInPlace({
  title,
  readOnly,
  record,
  onCommit,
  onEmptied,
}: {
  title: string;
  readOnly: boolean;
  record: ChangeRecord;
  onCommit: (text: string) => void;
  onEmptied: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const byKey = useRef(false);
  const editControl = useRef<HTMLButtonElement>(null);
  const flash = useAgentFlash(title, record);
  useEffect(() => {
    if (draft !== null || !byKey.current) return;
    byKey.current = false;
    editControl.current?.focus();
  }, [draft]);
  const settle = () => {
    if (draft !== null && !cancelled.current && draft !== title) {
      onCommit(draft);
      if (byKey.current && !draft.trim()) onEmptied();
    }
    cancelled.current = false;
    setDraft(null);
  };
  useCommitOnLeave(settle);
  if (draft !== null) {
    return (
      <input
        aria-label="Title"
        autoFocus
        value={draft}
        onFocus={(event) => event.currentTarget.setSelectionRange(draft.length, draft.length)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={settle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          cancelled.current = event.key === "Escape";
          byKey.current = true;
          event.currentTarget.blur();
        }}
        className="-mx-1 block h-5 w-full rounded border border-input bg-background px-1 text-title outline-none focus:border-ring/60"
      />
    );
  }
  if (readOnly)
    return (
      <h2 data-flash={flash} className="wrap-anywhere text-title">
        {title}
      </h2>
    );
  return (
    <div className="flex items-start gap-1">
      <h2
        data-flash={flash}
        onClick={() => setDraft(title)}
        className="min-w-0 cursor-text wrap-anywhere text-title"
      >
        {title}
      </h2>
      <Button
        ref={editControl}
        variant="ghost-muted"
        size="icon"
        className="-my-1 size-7 flex-none"
        aria-label="Edit title"
        onClick={() => setDraft(title)}
      >
        <Pencil className="size-3.5" />
      </Button>
    </div>
  );
}

const reviewLabel = (summary: ChangeSummary): string => {
  if (summary.tone === "attention") return "See what happened";
  if (summary.canApprove || summary.canSend) return "Review before sending";
  return summary.tone === "working" ? "See what's sending" : "See what's left";
};

function ReviewButton({ view, chord }: { view: ChangeView; chord: boolean }) {
  const { setUi } = useThreadActions();
  const { summary } = view;
  return (
    <Button
      data-card-primary
      aria-describedby={cardHeadId(view.record.id)}
      variant={chord ? "ghost" : summary.tone === "attention" ? "outline" : "default"}
      size="md"
      onClick={() => setUi({ panel: "writeback" })}
    >
      {chord ? "Preview" : reviewLabel(summary)}
      {!chord && <Kbd variant="on-primary">⌘↵</Kbd>}
    </Button>
  );
}

const REDRAFTS = "Opening it again starts a new draft.";

/** Discarding asks nothing, because the toast it leaves can undo it. */
export function DiscardButton({ view, size }: { view: ChangeView; size: "sm" | "lg" }) {
  const { threadId } = useThreadActions();
  if (!view.summary.canDiscard) return null;
  return (
    <Button
      variant="ghost"
      size={size}
      title={REDRAFTS}
      data-lands='[data-testid="queue-start"], [data-draft-reply]'
      onClick={() => discardChange(threadId, view.record.id)}
    >
      {view.summary.banner === "in-doubt" || view.summary.banner === "interrupted"
        ? "Discard, it may already have landed"
        : "Discard"}
    </Button>
  );
}

function CardActions({ view, extra }: { view: ChangeView; extra?: React.ReactNode }) {
  const { send } = useThreadActions();
  const { record, summary } = view;
  // A grade only you have edited skips the preview, as walkStep does, unless it is a zero or has no comment.
  const chord = sendsOnChord(record) && summary.canApprove;
  return (
    <div
      data-testid="card-actions"
      data-action-bar
      className="sticky bottom-0 z-[1] -mx-card -mb-card flex flex-wrap items-center justify-between gap-btn-gap rounded-b-card border-t border-border bg-card px-card py-3 shadow-action-bar"
    >
      <span className="flex items-center gap-btn-gap">
        <DiscardButton view={view} size="sm" />
        {extra}
      </span>
      <span className="ml-auto flex items-center gap-btn-gap">
        <ReviewButton view={view} chord={chord} />
        {chord && (
          <ApproveButton
            targets={[record]}
            label="Approve and send"
            kbd={<Kbd variant="on-primary">⌘↵</Kbd>}
            onApproved={() => send([record.id])}
          />
        )}
      </span>
    </div>
  );
}

function CardNotes({ summary, error }: { summary: ChangeSummary; error: string | null }) {
  const reset = approvalResetWords(summary.approvalReset);
  return (
    <>
      {reset && (
        <p data-approval-reset className="text-meta text-warning-foreground">
          {reset}
        </p>
      )}
      {summary.banner && summary.reason && (
        <p data-card-reason className="text-meta text-error-foreground">
          {summary.reason}
        </p>
      )}
      {error && <p className="text-meta text-error-foreground">{error}</p>}
    </>
  );
}

const COMMENT_LINE_PX = 22;
const COMMENT_MIN_LINES = 3;
const CARD_MARGIN_PX = 20;
const REASONS_ASIDE = "data-reasons-aside";

// The focused card's height in the chat with its comment cut to the fewest lines it shows, so an open queue can give up rows until the comment is in view (#207).
export const cardFloor = (chat: HTMLElement): number => {
  const card = chat.querySelector<HTMLElement>("article[data-focused]");
  const field = card?.querySelector<HTMLElement>("[data-edit-field]");
  if (!card || !field) return 0;
  const inset = parseFloat(getComputedStyle(field).paddingTop);
  const border = field.offsetHeight - field.clientHeight;
  return (
    card.offsetHeight -
    field.offsetHeight +
    COMMENT_MIN_LINES * COMMENT_LINE_PX +
    inset +
    border +
    CARD_MARGIN_PX
  );
};

const useCommentFit = (fieldRef: RefObject<HTMLTextAreaElement | null>): boolean => {
  const [scrolls, setScrolls] = useState(false);
  // Dropping the aside shortens the pane and clamps its scroll. StrictMode reruns this effect right after the panel restores its place, so the rerun reads the place from before the drop.
  const kept = useRef<{ pane: Element; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = fieldRef.current;
    const card = box?.closest("article");
    const chat = box?.closest<HTMLElement>('[data-testid="chat"]');
    const host = box?.closest<HTMLElement>(".panel-host");
    if (!box || !card || !chat || !host) return;
    const fit = () => {
      const pane = host.querySelector("[data-panel-scroll]");
      const paneTop = (kept.current?.pane === pane ? kept.current.top : pane?.scrollTop) ?? 0;
      kept.current = null;
      host.removeAttribute(REASONS_ASIDE);
      const inset = parseFloat(getComputedStyle(box).paddingTop);
      const border = box.offsetHeight - box.clientHeight;
      const textHeight = box.scrollHeight - inset - parseFloat(getComputedStyle(box).paddingBottom);
      const needs = () =>
        card.offsetHeight - box.offsetHeight + textHeight + 2 * inset + border + CARD_MARGIN_PX;
      if (needs() > chat.clientHeight) host.setAttribute(REASONS_ASIDE, "");
      const room =
        chat.clientHeight -
        CARD_MARGIN_PX -
        (card.offsetHeight - box.offsetHeight) -
        border -
        2 * inset;
      const lines = Math.max(Math.floor(room / COMMENT_LINE_PX), COMMENT_MIN_LINES);
      const over = Math.round(textHeight / COMMENT_LINE_PX) > lines;
      // A textarea paints its text through its bottom padding, so a capped box drops it or the next line shows cut in half.
      box.style.paddingBottom = over ? "0" : "";
      box.style.maxHeight = over ? `${lines * COMMENT_LINE_PX + inset + border}px` : "";
      setScrolls(over);
      if (pane) pane.scrollTop = paneTop;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(chat);
    observer.observe(card);
    return () => {
      observer.disconnect();
      const pane = host.querySelector("[data-panel-scroll]");
      kept.current = pane && { pane, top: pane.scrollTop };
      host.removeAttribute(REASONS_ASIDE);
    };
  }, [fieldRef]);
  return scrolls;
};

function GradeCard({ view, content }: { view: ChangeView; content: GradeContent }) {
  const { record, summary } = view;
  const [error, setError] = useState<string | null>(null);
  const canAttach = useWorkspace(
    (state) => state.capabilitiesFor(record.school)?.attachments ?? false,
  );
  const canExcuse = useWorkspace((state) => state.capabilitiesFor(record.school)?.excuse ?? false);
  const missing = useWorkspace(
    (state) => selectSubmission(state, content.target)?.workflow === "missing",
  );
  const total = finalGrade(content);
  const flash = useAgentFlash(total, record);
  const order = content.rubric?.map((score) => score.criterion) ?? [];
  const prior = record.basis.remote.kind === "grade" ? record.basis.remote.grade : null;
  const late = latePenalty(content);
  const raw = rawScore(content);
  const overridden = content.override != null;
  const comment = useRef<HTMLTextAreaElement>(null);
  const commentScrolls = useCommentFit(comment);
  const attachControl = canAttach && !content.attachment && (
    <Button
      variant="ghost-muted"
      size="sm"
      title="Attach an annotated PDF"
      disabled={!summary.canEdit}
      onClick={() =>
        setError(
          editChange(record.id, {
            kind: "grade",
            attachment: { name: `${record.subject.replace(/\W+/g, "_")}_feedback.pdf`, kb: 120 },
          }),
        )
      }
    >
      <Paperclip />
      Attach PDF
    </Button>
  );
  return (
    <>
      <CardHead view={view} />
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {content.rubric ? (
          content.rubric.map((score) => (
            <RubricRow
              key={score.criterion}
              record={record}
              score={score}
              order={order}
              canEdit={summary.canEdit}
              onError={setError}
            />
          ))
        ) : (
          <OverallRow
            record={record}
            content={content}
            canEdit={summary.canEdit}
            onError={setError}
          />
        )}
      </div>
      {missing && summary.canEdit && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setError(editChange(record.id, zeroPatch(content)))}
          >
            Zero
          </Button>
          {canExcuse && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setError(editChange(record.id, { kind: "grade", excused: true }))}
            >
              Excuse
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1 pr-grade-total-end">
        {prior !== null && <TotalRow label="Previous grade">{prior}</TotalRow>}
        <TotalRow
          label="Grade"
          strong
          note={
            overridden
              ? raw !== null && <>Scores {raw} · Your total</>
              : content.late && (
                  <>
                    {raw !== null && <>Scores {raw} · </>}Late penalty, {content.late.days}d at{" "}
                    {content.late.pointsPerDay}/day{" "}
                    {content.late.waived ? "waived" : <span className="tabular-nums">-{late}</span>}
                  </>
                )
          }
        >
          {overridden ? (
            <Stepper
              value={content.override}
              outOf={content.outOf}
              disabled={!summary.canEdit}
              label="total"
              typed
              onStep={(next) => setError(editChange(record.id, { kind: "grade", override: next }))}
            />
          ) : (
            <span data-testid="draft-grade" data-flash={flash} className="rounded px-1">
              {content.excused ? (
                <b className="text-page font-semibold">Excused</b>
              ) : total === null ? (
                <span className="text-meta text-muted-foreground">Not scored</span>
              ) : (
                <>
                  <b className="text-page font-semibold">{total}</b>{" "}
                  <span className="text-meta text-muted-foreground">/ {content.outOf}</span>
                </>
              )}
            </span>
          )}
        </TotalRow>
        {summary.canEdit && !content.excused && (
          <div className="flex flex-wrap justify-end gap-2">
            {content.late && !overridden && (
              <Button
                variant="ghost-muted"
                size="sm"
                onClick={() =>
                  setError(
                    editChange(record.id, { kind: "grade", lateWaived: !content.late?.waived }),
                  )
                }
              >
                {content.late.waived ? "Apply late penalty" : "Waive late penalty"}
              </Button>
            )}
            <Button
              variant="ghost-muted"
              size="sm"
              onClick={() =>
                setError(
                  editChange(record.id, {
                    kind: "grade",
                    override: overridden ? null : (total ?? 0),
                  }),
                )
              }
            >
              {overridden ? "Use the scores" : "Override total"}
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-label-gap">
        <div className="flex items-baseline justify-between gap-2 text-meta text-muted-foreground">
          <span className="text-title text-foreground">Feedback comment</span>
          {commentScrolls && <span data-comment-scrolls>Scroll for the rest</span>}
        </div>
        <EditableText
          label="Feedback comment"
          field
          fieldRef={comment}
          value={content.comment ?? ""}
          readOnly={!summary.canEdit}
          record={record}
          onCommit={(text) => setError(editChange(record.id, { kind: "grade", comment: text }))}
        />
      </div>
      {content.attachment && (
        <div className="flex items-center gap-2 text-meta">
          <Paperclip className="size-3.5 flex-none text-muted-foreground" />
          <span className="truncate text-meta">{content.attachment.name}</span>
          <span className="flex-none text-muted-foreground">
            {content.attachment.kb} KB, annotated copy
          </span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            disabled={!summary.canEdit}
            onClick={() => setError(editChange(record.id, { kind: "grade", attachment: null }))}
          >
            Remove
          </Button>
        </div>
      )}
      <CardNotes summary={summary} error={error} />
      <CardActions view={view} extra={attachControl} />
    </>
  );
}

const TEXT_LABEL = { reply: "Reply", message: "Message", announcement: "Announcement" } as const;

function TextCard({
  view,
  panel,
  quote,
}: {
  view: ChangeView;
  panel: ThreadUi["panel"];
  quote: boolean;
}) {
  const { record, summary } = view;
  const { content } = record;
  const [error, setError] = useState<string | null>(null);
  const [focusTitle, setFocusTitle] = useState(false);
  const quoted = useWorkspace((state) =>
    quote && content.kind === "reply"
      ? (selectConversation(state, content.target)?.messages.at(-1) ?? null)
      : null,
  );
  if (content.kind !== "reply" && content.kind !== "message" && content.kind !== "announcement")
    return null;
  const label = TEXT_LABEL[content.kind];
  const commitTitle = (title: string) =>
    setError(editChange(record.id, { kind: "announcement", title }));
  const titled = content.kind === "announcement" && content.title.trim() !== "";
  return (
    <>
      <CardHead
        view={view}
        name={
          titled ? (
            <TitleInPlace
              title={content.title}
              readOnly={!summary.canEdit}
              record={record}
              onCommit={commitTitle}
              onEmptied={() => setFocusTitle(true)}
            />
          ) : undefined
        }
      />
      {quoted && panel !== "source" && (
        <blockquote className="rounded-lg border border-border px-row-x py-row-y text-body text-secondary-label">
          <span className="text-muted-foreground">{quoted.author} wrote</span>
          <br />
          {quoted.text}
        </blockquote>
      )}
      {content.kind === "announcement" && !titled && (
        <div className="flex flex-col gap-1">
          <span className="text-title text-foreground">Title</span>
          <EditableText
            label="Title"
            multiline={false}
            value={content.title}
            readOnly={!summary.canEdit}
            autoFocus={focusTitle}
            record={record}
            onCommit={commitTitle}
          />
        </div>
      )}
      {content.kind === "message" && (
        <div className="text-meta text-muted-foreground">Subject: {content.subject}</div>
      )}
      <div className="flex flex-col gap-label-gap">
        <span className="text-title text-foreground">{label}</span>
        <EditableText
          label={label}
          field
          value={content.body}
          readOnly={!summary.canEdit}
          record={record}
          onCommit={(body) => setError(editChange(record.id, { kind: content.kind, body }))}
        />
      </div>
      <CardNotes summary={summary} error={error} />
      <CardActions view={view} />
    </>
  );
}

function Receipt({ view }: { view: ChangeView }) {
  const { next, openRow, setUi, rows } = useThreadActions();
  const school = useWorkspace((state) => state.schools.find((s) => s.id === view.record.school));
  return (
    <>
      <CardHead view={view} />
      <div className="text-meta text-success-foreground">Written to {school?.host}</div>
      <ul
        data-testid="receipt"
        className="flex flex-wrap gap-x-3 gap-y-0.5 text-meta text-secondary-label"
      >
        {view.preview.map((file) => (
          <li key={file.field} className="flex items-center gap-1.5">
            <Check className="size-3 flex-none text-success-foreground" />
            {file.label}
          </li>
        ))}
      </ul>
      {/* The way on drops to its own line before its label would cut off. */}
      <div className="sticky bottom-0 z-[1] flex flex-wrap items-center justify-between gap-btn-gap bg-card">
        <Button variant="ghost-muted" size="sm" onClick={() => setUi({ panel: "writeback" })}>
          View what was sent
        </Button>
        {next ? (
          <Button
            data-card-primary
            aria-describedby={cardHeadId(view.record.id)}
            variant="default"
            size="md"
            className="ml-auto min-w-0"
            onClick={() => openRow(next)}
          >
            <span className="truncate">Next: {next.title}</span>
            <Kbd variant="on-primary">⌘↵</Kbd>
          </Button>
        ) : view.record.content.kind === "announcement" ? (
          <Link
            to="/courses/$courseId/announcements"
            params={{ courseId: view.record.course }}
            className="link text-meta"
          >
            See posted announcements
          </Link>
        ) : (
          rows.length > 0 && <AfterQueue describedBy={cardHeadId(view.record.id)} />
        )}
      </div>
    </>
  );
}

/** With the preview open, the preview holds the text and every action, so the card shrinks to a line that leads back to editing. */
function PreviewingRow({ view }: { view: ChangeView }) {
  const edit = useEditDraft();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 pr-1 pl-3">
      <SchoolBadge school={view.record.school} />
      <span id={cardHeadId(view.record.id)} className="min-w-0 flex-1 truncate text-body">
        {view.record.subject}
      </span>
      <StatusPill tone={view.summary.tone} label={cardLabel(view.summary)} />
      <Button
        variant="ghost-info"
        size="sm"
        data-card-edit
        aria-describedby={cardHeadId(view.record.id)}
        onClick={edit}
      >
        Edit
      </Button>
    </div>
  );
}

/** `quote` shows the message a reply answers, for a card the conversation isn't right above. */
export function ChangeCard({
  id,
  panel,
  quote,
}: {
  id: ChangeId;
  panel: ThreadUi["panel"];
  quote: boolean;
}) {
  const view = useChange(id);
  if (!view) return null;
  const { content } = view.record;
  if (panel === "writeback" && !view.summary.sentAt)
    return (
      <article data-change={id} data-focused data-previewing className={COMPACT_ROW}>
        <PreviewingRow view={view} />
      </article>
    );
  return (
    <article
      data-change={id}
      data-focused
      className="flex scroll-mt-3 flex-col gap-card-gap rounded-card border border-input bg-card p-card"
    >
      {view.summary.sentAt ? (
        <Receipt view={view} />
      ) : content.kind === "grade" ? (
        <GradeCard view={view} content={content} />
      ) : (
        <TextCard view={view} panel={panel} quote={quote} />
      )}
    </article>
  );
}

export function ChangeRow({ id }: { id: ChangeId }) {
  const { focus } = useThreadActions();
  const view = useChange(id);
  if (!view) return null;
  return (
    <button
      type="button"
      data-change={id}
      onClick={() => focus(id)}
      className={cn(COMPACT_ROW, "cursor-pointer pr-3 pl-3 text-left hover:bg-accent")}
    >
      <SchoolBadge school={view.record.school} />
      <span className="min-w-0 flex-1 wrap-anywhere text-body">{view.record.subject}</span>
      <StatusPill tone={view.summary.tone} label={view.summary.label} />
    </button>
  );
}
