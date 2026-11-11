import { Link } from "@tanstack/react-router";
import { ChevronRight, CircleCheck, Undo2 } from "lucide-react";
import { useEffect, type MouseEvent } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type { ThreadId } from "~/shared/domain/ids";
import { cn } from "~/renderer/lib/utils";
import { canSettle, isSettled, selectThreadName } from "~/renderer/stores/selectors";
import type { Thread } from "~/renderer/stores/types";
import { useAiOn, useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { SchoolStar } from "./Brand";
import { pendingAfterResume, pendingAfterSettle, toastBottomOver } from "./settle.logic";
import { ROW, settledNewestFirst } from "./sidebar.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type Verb = "settle" | "resume";

const VERB_VIEW: Readonly<
  Record<Verb, { icon: typeof CircleCheck; label: string; title: string }>
> = {
  settle: { icon: CircleCheck, label: "Settle", title: "Settle thread" },
  resume: { icon: Undo2, label: "Resume", title: "Resume thread" },
};

interface Toast {
  text: string;
  undo: () => void;
  /** The threads a settle toast's Undo resumes. */
  settled?: readonly ThreadId[];
}

const useSettleUi = create<{
  sweep: { verb: Verb; ids: readonly ThreadId[] } | null;
  toast: Toast | null;
  settledOpen: boolean;
}>(() => ({ sweep: null, toast: null, settledOpen: false }));

export const openSettled = () => useSettleUi.setState({ settledOpen: true });

/** Shows the bottom-right toast whose Undo button runs `undo`. */
export const showUndoToast = (text: string, undo: () => void) =>
  useSettleUi.setState({ toast: { text, undo } });

const settleToast = (settled: readonly ThreadId[]): Toast | null => {
  const [only] = settled;
  if (!only) return null;
  const text =
    settled.length === 1
      ? `Settled “${selectThreadName(workspaceStore().getState(), only)}”`
      : `Settled ${settled.length} threads`;
  return { text, undo: () => resume(settled), settled };
};

const settle = (ids: readonly ThreadId[]) => {
  workspaceStore().getState().settleThreads(ids);
  const pending = useSettleUi.getState().toast?.settled ?? [];
  useSettleUi.setState({ toast: settleToast(pendingAfterSettle(pending, ids)) });
};

const resume = (ids: readonly ThreadId[]) => {
  workspaceStore().getState().resumeThreads(ids);
  const pending = useSettleUi.getState().toast?.settled ?? [];
  useSettleUi.setState({ toast: settleToast(pendingAfterResume(pending, ids)) });
};

/** The open thread's settled sign, with Resume to put it back in the sidebar. */
export function SettledMark({ thread }: { thread: Thread }) {
  if (!isSettled(thread)) return null;
  return (
    <>
      <Badge data-testid="settled-mark">Settled</Badge>
      <Button variant="ghost" size="sm" onClick={() => resume([thread.id])}>
        <Undo2 />
        Resume
      </Button>
    </>
  );
}

const run = (verb: Verb, ids: readonly ThreadId[]) => (verb === "settle" ? settle : resume)(ids);

const startSweep = (verb: Verb, first: ThreadId) => {
  useSettleUi.setState({ sweep: { verb, ids: [first] } });
  const move = (event: PointerEvent) => {
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-settle-row]");
    const id = row?.dataset["settleRow"] as ThreadId | undefined;
    const sweep = useSettleUi.getState().sweep;
    if (!id || !sweep || row?.dataset["settleVerb"] !== verb || sweep.ids.includes(id)) return;
    useSettleUi.setState({ sweep: { verb, ids: [...sweep.ids, id] } });
  };
  const end = (event: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    const ids = useSettleUi.getState().sweep?.ids ?? [];
    useSettleUi.setState({ sweep: null });
    if (event.type === "pointerup") run(verb, ids);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
};

export const useRowAction = (thread: Thread, verb: Verb) => {
  const swept = useSettleUi(
    (state) => state.sweep?.verb === verb && state.sweep.ids.includes(thread.id),
  );
  const on = canSettle(thread);
  return {
    on,
    swept,
    li: on ? { "data-settle-row": thread.id, "data-settle-verb": verb } : {},
    link: on
      ? cn(
          "group-hover/row:bg-accent group-hover/row:text-foreground",
          !swept && "group-hover/row:pr-19 [@media(hover:none)]:pr-19",
        )
      : "",
    status: on ? cn("group-hover/row:hidden [@media(hover:none)]:hidden", swept && "hidden") : "",
  };
};

const isKeyboardClick = (event: MouseEvent<HTMLButtonElement>) => event.detail === 0;

export function RowAction({ thread, verb }: { thread: Thread; verb: Verb }) {
  const { on, swept } = useRowAction(thread, verb);
  if (!on || swept) return null;
  const { icon: Icon, label, title } = VERB_VIEW[verb];
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      data-lands="[data-settle-row] > a"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        startSweep(verb, thread.id);
      }}
      onClick={(event) => {
        if (isKeyboardClick(event)) run(verb, [thread.id]);
      }}
      className="absolute inset-y-0 right-1 flex touch-none items-center gap-1 rounded-md px-1.5 text-meta text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

export function SweepChip({ verb }: { verb: Verb }) {
  const { icon: Icon, label } = VERB_VIEW[verb];
  return (
    <span className="pointer-events-none ml-auto inline-flex h-5 flex-none items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-meta font-medium text-primary-ink">
      <Icon className="size-3" />
      {label}
    </span>
  );
}

function SettledRow({ thread, active }: { thread: Thread; active: boolean }) {
  const name = useWorkspace((state) => selectThreadName(state, thread.id));
  const row = useRowAction(thread, "resume");
  return (
    <li className="group/row relative" {...row.li}>
      <Link
        to="/threads/$threadId"
        params={{ threadId: thread.id }}
        aria-current={active ? "true" : undefined}
        className={cn(ROW, "text-muted-foreground", active && "row-selected", row.link)}
      >
        {thread.school && <SchoolStar school={thread.school} />}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {row.swept && <SweepChip verb="resume" />}
      </Link>
      <RowAction thread={thread} verb="resume" />
    </li>
  );
}

export function SettledArea({ activeThread }: { activeThread: ThreadId | null }) {
  const ai = useAiOn();
  const settled = useWorkspace(
    useShallow((state) => settledNewestFirst(Object.values(state.threads), ai)),
  );
  const open = useSettleUi((state) => state.settledOpen);
  const setOpen = (settledOpen: boolean) => useSettleUi.setState({ settledOpen });
  return (
    <section
      data-testid="settled-area"
      className="flex-none border-t border-border px-2 py-1 rail:hidden"
    >
      <button
        type="button"
        aria-expanded={open && settled.length > 0}
        disabled={settled.length === 0}
        onClick={() => setOpen(!open)}
        className={cn(
          ROW,
          "text-muted-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        )}
      >
        <ChevronRight
          className={cn(
            "size-3 flex-none transition-transform duration-100",
            open && settled.length > 0 && "rotate-90",
          )}
        />
        <span className="flex-1">Settled</span>
        <span className="tabular-nums">{settled.length}</span>
      </button>
      {open && settled.length > 0 && (
        <ul className="max-h-[40vh] overflow-y-auto">
          {settled.map((thread) => (
            <SettledRow key={thread.id} thread={thread} active={thread.id === activeThread} />
          ))}
        </ul>
      )}
    </section>
  );
}

const TOAST_MS = 6000;

export function SettleToast() {
  const toast = useSettleUi((state) => state.toast);
  const place = (el: HTMLDivElement | null) => {
    const shell = document.querySelector(".composer-shell");
    if (!el || !shell) return;
    const lift = () => {
      el.style.bottom = "";
      const bottom = toastBottomOver(
        el.getBoundingClientRect(),
        shell.getBoundingClientRect(),
        window.innerHeight,
      );
      if (bottom !== null) el.style.bottom = `${bottom}px`;
    };
    lift();
    const observer = new ResizeObserver(lift);
    observer.observe(el);
    observer.observe(shell);
    window.addEventListener("resize", lift);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", lift);
    };
  };
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => useSettleUi.setState({ toast: null }), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div
      ref={place}
      role="status"
      data-testid="undo-toast"
      data-toast
      className="fade-in fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-3 py-2 text-body shadow-lg"
    >
      <CircleCheck className="size-3.5 flex-none text-muted-foreground" />
      <span className="max-w-[320px] truncate">{toast.text}</span>
      <Button
        variant="link"
        size="sm"
        onClick={() => {
          useSettleUi.setState({ toast: null });
          toast.undo();
        }}
      >
        <Undo2 />
        Undo
      </Button>
    </div>
  );
}
