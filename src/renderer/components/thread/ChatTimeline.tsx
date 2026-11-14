import { Ban, Check, ChevronRight, Info } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { LmsRef, ThreadId } from "~/shared/domain/ids";
import { undraftableReason, type Submission } from "~/shared/domain/lms";
import {
  selectAssignment,
  selectSubmission,
  selectThreadChanges,
} from "~/renderer/stores/selectors";
import type { Thread, ThreadMessage, ThreadUi } from "~/renderer/stores/types";
import { useAiOn, useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { cn } from "~/renderer/lib/utils";

import { Button } from "../ui/button";
import { ChangeCard, ChangeRow } from "./DraftCard";
import { useRefusedFile } from "./SubmittedFile";
import { AnswerLines, HandedOffBanner, HandoffGroup, ReplyChips } from "./northStar";
import { boldRuns, buildTimeline, liveReplies, visibleMessages } from "./timeline.logic";
import { focusIsFree } from "~/renderer/lib/lostFocus";

const STICK_PX = 80;
const SAVE_MS = 250;
const CARD_OFFSET_PX = 12;
/** The top fade in .chat-scroll ends here, and so does the timeline's top padding. */
const FADE_PX = 16;
const LOG_LINES = 6;

function AgentText({ text }: { text: string }) {
  return (
    <>
      {boldRuns(text).map((run, index) =>
        run.bold ? (
          // oxlint-disable-next-line react/no-array-index-key -- pieces split from one string have no id and can repeat
          <strong key={index} className="font-medium">
            {run.text}
          </strong>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- pieces split from one string have no id and can repeat
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
}

function WorkLog({ lines }: { lines: readonly string[] }) {
  const list = (
    <ul
      data-trace
      className="flex flex-col gap-1 border-l border-input pl-3 text-meta text-muted-foreground"
    >
      {lines.map((line, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- pieces split from one string have no id and can repeat
        <li key={index} className="flex items-start gap-2">
          <Check className="mt-[2px] size-3 flex-none text-success-foreground/70" />
          {line}
        </li>
      ))}
    </ul>
  );
  if (lines.length <= LOG_LINES) return list;
  return (
    <details data-testid="work-log" className="group">
      <summary className="flex h-btn-sm cursor-pointer list-none items-center gap-1 self-start text-meta text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        Ran {lines.length} checks
        <ChevronRight className="size-3 transition-transform duration-100 group-open:rotate-90" />
      </summary>
      {list}
    </details>
  );
}

function Message({
  message,
  thread,
}: {
  message: Exclude<ThreadMessage, { type: "work" | "handoff" }>;
  thread: Thread;
}) {
  switch (message.type) {
    case "user":
      return (
        <div className="max-w-[80%] self-end rounded-2xl bg-message px-3 py-2 text-chat whitespace-pre-wrap">
          {message.text}
        </div>
      );
    case "agent": {
      const replies = liveReplies(message, thread.messages);
      return (
        <div className="text-chat whitespace-pre-line">
          <AgentText text={message.text} />
          {message.edited && message.edited.length > 0 && (
            <ul data-edited className="mt-2 flex flex-wrap gap-2">
              {message.edited.map((edit) => (
                <li
                  key={edit.label}
                  className="rounded border border-border bg-card px-1.5 py-0.5 text-meta text-secondary-label"
                >
                  {!edit.from ? (
                    <>
                      {edit.label} added: <ins className="no-underline">{edit.to}</ins>
                    </>
                  ) : !edit.to ? (
                    <>
                      {edit.label} removed: <del>{edit.from}</del>
                    </>
                  ) : (
                    <>
                      {edit.label}: <del>{edit.from}</del> to{" "}
                      <ins className="no-underline">{edit.to}</ins>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {message.lines && message.lines.length > 0 && <AnswerLines lines={message.lines} />}
          {replies.length > 0 && <ReplyChips thread={thread.id} replies={replies} />}
        </div>
      );
    }
    case "handed-off":
      return <HandedOffBanner message={message} />;
    case "refusal":
      return (
        <div
          data-refusal
          role="note"
          className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/8 px-banner-x py-banner-y text-chat"
        >
          <Ban className="mt-1 size-3.5 flex-none text-error-foreground" />
          <span>{message.text}</span>
        </div>
      );
    case "declined":
      return (
        <div
          data-declined
          role="note"
          className="flex items-start gap-2 rounded-lg border border-border bg-card px-banner-x py-banner-y text-chat"
        >
          <Info className="mt-1 size-3.5 flex-none text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <span>{message.text}</span>
            {message.lines && message.lines.length > 0 && <AnswerLines lines={message.lines} />}
          </div>
        </div>
      );
    case "notice":
      return (
        <div
          data-notice
          role="note"
          className="flex items-start gap-2 text-meta text-warning-foreground"
        >
          <Info className="mt-[2px] size-3.5 flex-none" />
          <span>{message.text}</span>
        </div>
      );
  }
}

type ScrollAnchor = "bottom" | "card" | "free";

const nearBottom = (el: HTMLElement): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
const countUserMessages = (thread: Thread): number =>
  thread.messages.filter((message) => message.type === "user").length;

const useChatScroll = (thread: Thread, ui: ThreadUi, stickOn: string | undefined) => {
  const scroller = useRef<HTMLDivElement>(null);
  const screen = stickOn !== undefined;
  const anchor = useRef<ScrollAnchor>(
    ui.scrollTop !== null ? "free" : thread.focus && !screen ? "card" : "bottom",
  );
  const saveTimer = useRef<number | undefined>(undefined);
  const lastTop = useRef(ui.scrollTop);
  const focusSeen = useRef(thread.focus);
  const sentSeen = useRef(countUserMessages(thread));
  const placedFor = useRef<{ stickOn: string; length: number } | null>(null);
  const rested = useRef(0);
  const seenTop = useRef(0);

  const focusedCard = (el: HTMLElement) =>
    thread.focus ? el.querySelector(`[data-change="${thread.focus}"]`) : null;
  const cardDelta = (el: HTMLElement, card: Element) =>
    card.getBoundingClientRect().top - el.getBoundingClientRect().top - CARD_OFFSET_PX;

  const cardRest = (el: HTMLElement, card: Element) => {
    const wanted = el.scrollTop + cardDelta(el, card);
    const lowest = el.scrollHeight - el.clientHeight;
    const inScroll = (y: number) => y - el.getBoundingClientRect().top + el.scrollTop;
    if (wanted <= lowest) {
      const trace = card.closest(".focused-slot")?.previousElementSibling;
      if (!trace?.matches("[data-trace]")) return wanted;
      const above = inScroll(trace.getBoundingClientRect().top) - CARD_OFFSET_PX;
      return inScroll(card.getBoundingClientRect().bottom) - above <= el.clientHeight
        ? above
        : wanted;
    }
    // A conversation's messages are rows of their own, so the one at the top edge can be shown whole.
    const rows = [...(card.closest(".focused-slot")?.parentElement?.children ?? [])].flatMap(
      (row) => {
        const messages = row.querySelectorAll(":scope > [data-message]");
        return messages.length > 0 ? [...messages] : [row];
      },
    );
    const index = rows.findIndex(
      (row) =>
        inScroll(row.getBoundingClientRect().top) < lowest + FADE_PX - 1 &&
        inScroll(row.getBoundingClientRect().bottom) > lowest + 1,
    );
    const cut = rows[index];
    if (!cut) return lowest;
    const revealed = index === 0 ? 0 : inScroll(cut.getBoundingClientRect().top) - FADE_PX;
    return inScroll(card.getBoundingClientRect().bottom) - revealed <= el.clientHeight
      ? revealed
      : wanted;
  };

  const place = (el: HTMLElement) => {
    if (anchor.current === "free") return;
    const column = el.firstElementChild as HTMLElement;
    column.style.paddingBottom = "";
    const card = focusedCard(el);
    if (anchor.current === "card" && card) {
      const rest = cardRest(el, card);
      const short = rest - (el.scrollHeight - el.clientHeight);
      if (short > 0)
        column.style.paddingBottom = `${parseFloat(getComputedStyle(column).paddingBottom) + short}px`;
      el.scrollTop = rest;
      rested.current = cardDelta(el, card);
    } else el.scrollTop = el.scrollHeight;
  };

  const restoreScroll = useEffectEvent(() => {
    const el = scroller.current;
    if (!el || ui.scrollTop === null) return;
    el.scrollTop = ui.scrollTop;
  });
  useLayoutEffect(() => restoreScroll(), []);

  const followFocus = useEffectEvent((focus: Thread["focus"]) => {
    if (focusSeen.current === focus) return;
    focusSeen.current = focus;
    const el = scroller.current;
    if (!el || !focusedCard(el)) return;
    anchor.current = "card";
    place(el);
  });
  useLayoutEffect(() => followFocus(thread.focus), [thread.focus]);

  // Off a screen this places after every render. On one, only when `stickOn` or the message count moves.
  useLayoutEffect(() => {
    if (stickOn !== undefined) {
      const last = placedFor.current;
      if (last?.stickOn === stickOn && last.length === thread.messages.length) return;
      placedFor.current = { stickOn, length: thread.messages.length };
    } else placedFor.current = null;
    const el = scroller.current;
    if (!el) return;
    const sent = countUserMessages(thread);
    if (sent > sentSeen.current) anchor.current = "bottom";
    sentSeen.current = sent;
    if (screen && anchor.current === "card") anchor.current = nearBottom(el) ? "bottom" : "free";
    place(el);
  });

  const follow = useEffectEvent((el: HTMLElement, onScreen: boolean) => {
    if (anchor.current === "card") return place(el);
    if (anchor.current !== "bottom" || onScreen) return;
    // The bottom, unless that would push the open card's header off the top.
    const card = focusedCard(el);
    el.scrollTop = Math.min(el.scrollHeight, card ? el.scrollTop + cardDelta(el, card) : Infinity);
  });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => follow(el, screen));
    observer.observe(el);
    return () => observer.disconnect();
  }, [screen]);

  // The open card can change height without a render here, as when the agent finishes inside it, which moves where it rests.
  const refit = useEffectEvent((el: HTMLElement) => {
    if (anchor.current === "card") place(el);
  });
  useEffect(() => {
    const el = scroller.current;
    const slot = el?.querySelector(`[data-change="${thread.focus}"]`)?.closest(".focused-slot");
    if (!el || !slot) return;
    const observer = new ResizeObserver(() => refit(el));
    observer.observe(slot);
    return () => observer.disconnect();
  }, [thread.focus]);

  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current);
      workspaceStore().getState().setThreadUi(thread.id, { scrollTop: lastTop.current });
    },
    [thread.id],
  );

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // The browser's own scroll anchoring moves scrollTop too, so a scroll only counts as the user's if it moved the card.
    const card = focusedCard(el);
    const delta = card ? cardDelta(el, card) - rested.current : null;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    const held =
      anchor.current === "card" &&
      delta !== null &&
      (Math.abs(delta) <= 1 || (delta > 0 && atBottom));
    // Scrolling up leaves the bottom even inside the stick band; otherwise the next render pulls a short chat back down.
    const up = el.scrollTop < seenTop.current;
    seenTop.current = el.scrollTop;
    if (!held) anchor.current = nearBottom(el) && (!up || atBottom) ? "bottom" : "free";
    lastTop.current =
      anchor.current === "free" || (anchor.current === "card" && screen) ? el.scrollTop : null;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(
      () => workspaceStore().getState().setThreadUi(thread.id, { scrollTop: lastTop.current }),
      SAVE_MS,
    );
  };

  /** The next layout otherwise jumps to the newest message, away from what was just clicked. */
  const holdPosition = () => {
    anchor.current = "free";
  };

  return { scroller, onScroll, holdPosition };
};

const useArrivalFocus = (scroller: RefObject<HTMLDivElement | null>, focus: Thread["focus"]) => {
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || !focus) return;
    const el = scroller.current;
    const card = el?.querySelector(`[data-change="${focus}"]`);
    if (!el || !card) return;
    arrived.current = true;
    const action = card.querySelector<HTMLElement>("[data-card-primary]");
    if (!action || !focusIsFree()) return;
    const box = action.getBoundingClientRect();
    const view = el.getBoundingClientRect();
    if (box.top >= view.top && box.bottom <= view.bottom) action.focus({ preventScroll: true });
  });
};

/**
 * A submission open with nothing drafted. It says where the grade stands in the LMS, and drafting is a choice here, since a draft costs a model call.
 * It stays while its own draft runs, so the button still holds focus when the card arrives and can hand it on.
 */
function OpenSubmission({
  thread,
  submission,
  working,
}: {
  thread: ThreadId;
  submission: Submission;
  working: boolean;
}) {
  const ai = useAiOn();
  const [asked, setAsked] = useState(false);
  const assignment = useWorkspace((state) => selectAssignment(state, submission.assignment));
  const vendor = useWorkspace((state) => state.vendorLabelFor(submission.school) ?? "the LMS");
  const comment = submission.comments.findLast((c) => c.mine)?.text;
  const drafting = asked && working;
  const refused = useRefusedFile(submission);
  const blocked = undraftableReason(submission.body) ?? refused;
  const open = (fill: "draft" | "by-hand") => {
    if (working) return;
    setAsked(fill === "draft");
    void workspaceStore().getState().openSubmission(thread, submission.ref, { fill });
  };
  if (working && !drafting) return null;
  return (
    <div data-testid="grade-open" className="flex flex-col gap-2">
      <p className="text-body">
        <span className="font-medium">{submission.studentName}</span>
        {assignment && <span className="text-muted-foreground">, {assignment.shortTitle}</span>}
      </p>
      <p data-testid="current-grade" className="text-meta text-secondary-label">
        {submission.grade === null
          ? `Not graded in ${vendor} yet.`
          : `${submission.grade}${assignment ? ` / ${assignment.pointsPossible}` : ""} in ${vendor} now.`}
      </p>
      {comment && (
        <p
          data-testid="current-comment"
          className="border-l border-input pl-3 text-meta text-muted-foreground"
        >
          {comment}
        </p>
      )}
      {ai && blocked && (
        <p data-testid="draft-blocked" className="text-meta text-secondary-label">
          {blocked}
        </p>
      )}
      <div className="flex gap-btn-gap">
        {ai && (
          <Button
            variant="default"
            disabled={blocked !== null}
            aria-disabled={drafting}
            data-lands="[data-card-primary]"
            onClick={() => open("draft")}
          >
            {drafting ? "Drafting" : "Draft with Claude"}
          </Button>
        )}
        {!drafting && (
          <Button
            variant={ai && !blocked ? "outline" : "default"}
            data-lands="[data-typed-score], [data-card-primary]"
            onClick={() => open("by-hand")}
          >
            Grade it yourself
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * `lead` sits above the chat in the same scroll, and `trail` below it. `scoped` keeps other changes out entirely, for a screen that lists them already.
 * `screen` is for a thread whose changes all live in its own screen: the chat is its words alone, every message of them, and `stickOn` says when to follow the bottom.
 * `quotedAbove` says the lead ends with the message a reply answers, so a card with only work logs between it and the lead doesn't quote that message again.
 */
export function ChatTimeline({
  thread,
  ui,
  panelOpen,
  lead,
  trail,
  scoped = false,
  screen = false,
  stickOn,
  quotedAbove = false,
}: {
  thread: Thread;
  ui: ThreadUi;
  panelOpen: boolean;
  lead?: ReactNode;
  trail?: ReactNode;
  scoped?: boolean;
  screen?: boolean;
  stickOn?: string;
  quotedAbove?: boolean;
}) {
  const changes = useWorkspace((state) => selectThreadChanges(state, thread.id));
  const working = useWorkspace((state) => state.working[thread.id] ?? false);
  // Remembers which focus it was opened for, so moving to another student closes it again.
  const [openedFor, setOpenedFor] = useState<Thread["focus"] | undefined>(undefined);
  const expanded = !scoped && openedFor === thread.focus;
  const ai = useAiOn();
  const items = useMemo(() => {
    const messages = visibleMessages(thread.messages, ai, changes.length > 0);
    if (screen)
      return buildTimeline(messages, [], { focus: thread.focus, expanded: true }).filter(
        (item) => item.type !== "earlier",
      );
    const all = buildTimeline(messages, changes, { focus: thread.focus, expanded });
    return scoped ? all.filter((item) => item.type !== "earlier") : all;
  }, [thread.messages, changes, thread.focus, expanded, scoped, screen, ai]);
  const { scroller, onScroll, holdPosition } = useChatScroll(thread, ui, stickOn);
  useArrivalFocus(scroller, thread.focus);
  /** The course an announcement thread with nothing drafted yet would post to. */
  const toAnnounce = thread.kind === "announcement" && thread.focus === null ? thread.course : null;
  /** The submission on screen with no draft open: just opened, or after a draft that failed or a Discard. */
  const toGrade = useWorkspace((state) =>
    selectSubmission(state, thread.focus === null ? (ui.current as LmsRef<"submission">) : null),
  );

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      data-testid="chat"
      className="chat-scroll min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-chat flex-col gap-3 px-4 pt-4 pb-6">
        {lead}
        {items.map((item, index) => {
          switch (item.type) {
            case "earlier":
              return (
                <button
                  key={item.key}
                  type="button"
                  data-testid="earlier"
                  aria-expanded={item.expanded}
                  onClick={() => {
                    holdPosition();
                    setOpenedFor(item.expanded ? undefined : thread.focus);
                  }}
                  className="flex h-btn-sm cursor-pointer items-center gap-1 self-start rounded text-meta text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 transition-transform duration-100",
                      item.expanded && "rotate-90",
                    )}
                  />
                  {item.label}
                </button>
              );
            case "message":
              return <Message key={item.key} message={item.message} thread={thread} />;
            case "work":
              return <WorkLog key={item.key} lines={item.lines} />;
            case "handoffs":
              return <HandoffGroup key={item.key} messages={item.messages} from={thread.id} />;
            case "change":
              return item.change.id === thread.focus ? (
                <div key={item.key} className="focused-slot">
                  <ChangeCard
                    id={item.change.id}
                    panel={panelOpen ? ui.panel : null}
                    quote={
                      !quotedAbove || items.slice(0, index).some((before) => before.type !== "work")
                    }
                  />
                </div>
              ) : (
                <ChangeRow key={item.key} id={item.change.id} />
              );
          }
        })}
        {toAnnounce && !working && (
          <div>
            <Button
              variant="default"
              onClick={() =>
                void workspaceStore().getState().openAnnouncement(thread.id, toAnnounce)
              }
            >
              {ai ? "Draft the announcement" : "Write the announcement"}
            </Button>
          </div>
        )}
        {toGrade && (
          <OpenSubmission
            key={toGrade.ref}
            thread={thread.id}
            submission={toGrade}
            working={working}
          />
        )}
        {working && (
          <div
            data-testid="agent-working"
            className="flex items-center gap-2 text-meta text-muted-foreground"
          >
            <span className="dot-pulse size-1.5 rounded-full bg-current" />
            Working
          </div>
        )}
        {trail}
      </div>
    </div>
  );
}
