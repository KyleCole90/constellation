import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { sendsOnChord } from "~/shared/domain/change";
import type { ChangeId, LmsRef, ThreadId } from "~/shared/domain/ids";
import { selectConversation, selectThreadUi, summarizeFor } from "~/renderer/stores/selectors";
import type { Thread } from "~/renderer/stores/types";
import { useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { isMod } from "../AppShell";
import { approveByChord } from "../ApproveButton";
import type { RationaleLink, ThreadActions } from "./context";
import { batchChanges, moveCursor, nextOpen, runOf, type WorkRow } from "./queue.logic";
import { walkStep } from "./timeline.logic";
import { useChange } from "./useChange";

const store = () => workspaceStore().getState();

/** The last word being mine means it's answered. A reply isn't reused the way a sent grade is, so opening this would draft another. */
const isAnswered = (conversation: LmsRef<"conversation">): boolean =>
  selectConversation(store(), conversation)?.messages.at(-1)?.mine === true;

const openTarget = async (thread: ThreadId, row: WorkRow, focus = true): Promise<unknown> => {
  if (row.kind === "submission") return store().openSubmission(thread, row.key, { focus });
  return isAnswered(row.key) ? null : store().openConversation(thread, row.key, { focus });
};

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const isActivatable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (isTyping(target) || ["BUTTON", "A", "SUMMARY"].includes(target.tagName));

/** Everything a screen needs to work through rows in a thread: opening, batching, sending, and the keyboard. */
export const useThreadWork = (
  thread: Thread,
  rows: readonly WorkRow[],
  shown: readonly WorkRow[],
  onOpen?: (row: WorkRow) => void,
) => {
  const { id } = thread;
  const ui = useWorkspace((state) => selectThreadUi(state, id));
  const working = useWorkspace((state) => state.working[id] ?? false);
  const focused = useChange(thread.focus);
  const [busy, setBusy] = useState<ReadonlySet<ChangeId>>(new Set());
  const [drafting, setDrafting] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const [hover, setHover] = useState<string | null>(null);
  const scrolledTick = useRef(0);
  const claimScroll = useCallback((tick: number) => {
    if (scrolledTick.current === tick) return false;
    scrolledTick.current = tick;
    return true;
  }, []);
  const [selection, setSelection] = useState<{
    key: string | null;
    tick: number;
    from: RationaleLink["from"];
  }>({ key: null, tick: 0, from: null });
  const [selectionFor, setSelectionFor] = useState(thread.focus);
  // The tick keeps counting across the reset, so a fresh selection never matches the one last scrolled to.
  if (selectionFor !== thread.focus) {
    setSelectionFor(thread.focus);
    setSelection((prior) => ({ key: null, tick: prior.tick, from: null }));
    setHover(null);
  }

  const setUi = useCallback(
    (patch: Parameters<ThreadActions["setUi"]>[0]) => store().setThreadUi(id, patch),
    [id],
  );
  const currentKey = focused?.record.content.target ?? ui.current;
  const batch = useMemo(() => batchChanges(rows, ui.selected), [rows, ui.selected]);

  const send = useCallback((ids: readonly ChangeId[]) => {
    setBusy((prior) => new Set([...prior, ...ids]));
    void store()
      .sendChanges(ids)
      .finally(() =>
        setBusy((prior) => {
          const left = new Set(prior);
          for (const done of ids) left.delete(done);
          return left;
        }),
      );
  }, []);

  // The button that opened a row is gone once the row opens, so focus would fall to the body.
  const landOn = useRef<string | null>(null);
  const openRow = useCallback(
    (row: WorkRow) => {
      landOn.current = row.key;
      if (onOpen) onOpen(row);
      else setUi({ queueOpen: false, current: row.key, panel: "source" });
      store().focusChange(id, row.change?.id ?? null);
      void openTarget(id, row);
    },
    [id, setUi, onOpen],
  );

  const messageRow = useCallback(
    (row: WorkRow) => {
      setUi({ queueOpen: false, current: row.key, panel: null });
      store().focusChange(id, null);
      void store().openMessage(id, row.key as LmsRef<"submission">);
    },
    [id, setUi],
  );

  const focusedId = focused?.record.id;
  const focusedTarget = focused?.record.content.target;
  useEffect(() => {
    if (!focusedId || focusedTarget !== landOn.current) return;
    landOn.current = null;
    document
      .querySelector<HTMLInputElement>(`[data-change="${focusedId}"] [data-typed-score]`)
      ?.focus();
  }, [focusedId, focusedTarget]);

  const focus = useCallback(
    (change: ChangeId) => {
      const record = store().changes[change] ?? store().blanks[change];
      if (record) setUi({ current: record.content.target });
      store().focusChange(id, change);
    },
    [id, setUi],
  );

  const draftRows = useCallback(
    async (targets: readonly WorkRow[]) => {
      setDrafting(new Set(targets.map((row) => row.key)));
      for (const row of targets) {
        await openTarget(id, row, false);
        setDrafting((left) => new Set([...left].filter((key) => key !== row.key)));
      }
    },
    [id],
  );

  useEffect(() => {
    if (ui.panel === "batch" && batch.length === 0) setUi({ panel: null });
  }, [ui.panel, batch.length, setUi]);

  const link = useMemo<RationaleLink>(
    () => ({
      hover,
      selected: selection.key,
      tick: selection.tick,
      from: selection.from,
      claimScroll,
      setHover,
      selectFromRow: (key) => {
        setSelection((prior) => ({ key, tick: prior.tick + 1, from: "row" }));
        setUi({ panel: "source" });
      },
      selectFromPassage: (key) =>
        setSelection((prior) => ({ key, tick: prior.tick + 1, from: "passage" })),
    }),
    [hover, selection, setUi, claimScroll],
  );

  // A filter or a tick is the run the teacher chose, so the next row stays inside it.
  const next = useMemo(
    () => nextOpen(runOf(shown, ui.selected), currentKey),
    [shown, ui.selected, currentKey],
  );
  const actions = useMemo<ThreadActions>(
    () => ({
      threadId: id,
      rows,
      batch,
      busy,
      drafting,
      next,
      send,
      openRow,
      messageRow,
      focus,
      draftRows,
      setUi,
    }),
    [id, rows, batch, busy, drafting, next, send, openRow, messageRow, focus, draftRows, setUi],
  );

  const walk = (press: KeyboardEvent) => {
    // A comment still being typed commits on blur, and that can change what the next step is.
    if (
      document.activeElement instanceof HTMLTextAreaElement ||
      document.activeElement instanceof HTMLInputElement
    )
      document.activeElement.blur();
    const state = store();
    const record = thread.focus
      ? (state.changes[thread.focus] ?? state.blanks[thread.focus])
      : undefined;
    const summary = record ? summarizeFor(record, state.connections[record.school]?.status) : null;
    switch (
      walkStep({
        busy: working || (record ? busy.has(record.id) : false),
        summary,
        panel: ui.panel,
        chordSends: record ? sendsOnChord(record) : false,
      })
    ) {
      case "open-next":
        if (next) openRow(next);
        else
          document
            .querySelector<HTMLElement>(`[data-change="${thread.focus}"] [data-card-primary]`)
            ?.click();
        return;
      case "review":
        setUi({ panel: "writeback" });
        return;
      case "focus-approve":
        document.querySelector<HTMLButtonElement>("[data-approve]")?.focus();
        return;
      case "approve-and-send":
        if (record && approveByChord(press, record)) send([record.id]);
        return;
      case "send":
        if (record) send([record.id]);
        return;
      case "none":
        return;
    }
  };

  const toggleWriteback = () => {
    if (thread.focus) setUi({ panel: ui.panel === "writeback" ? null : "writeback" });
  };

  const moveTo = (delta: 1 | -1) => {
    const from = cursor >= 0 ? cursor : shown.findIndex((row) => row.key === currentKey);
    setCursor(moveCursor(from, delta, shown.length));
    if (!ui.queueOpen) setUi({ queueOpen: true });
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
    const key = event.key;
    if (isMod(event) && key === "Enter") {
      // preventDefault also stops a focused Approve button turning this chord into a click.
      event.preventDefault();
      walk(event);
    } else if (isMod(event) && key.toLowerCase() === "d") {
      event.preventDefault();
      toggleWriteback();
    } else if (key === "Escape") {
      if (ui.panel) {
        event.preventDefault();
        setUi({ panel: null });
      }
    } else if (document.querySelector<HTMLElement>('[data-testid="thread-main"]')?.inert) {
      // The queue and the composer are behind the overlay, so their keys wait until it closes.
    } else if (!isMod(event) && !event.altKey && key === "/" && !isTyping(event.target)) {
      event.preventDefault();
      document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus();
    } else if (
      !isMod(event) &&
      !event.altKey &&
      rows.length > 0 &&
      (key === "j" || key === "k") &&
      !isTyping(event.target)
    ) {
      event.preventDefault();
      // Otherwise Enter would activate whatever was last clicked rather than open the row under the cursor.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      moveTo(key === "j" ? 1 : -1);
    } else if (!isMod(event) && key === "Enter" && cursor >= 0 && !isActivatable(event.target)) {
      const row = shown[cursor];
      if (row) {
        event.preventDefault();
        openRow(row);
        setCursor(-1);
      }
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const panelVisible =
    ui.panel === "batch"
      ? batch.length > 0
      : ui.panel !== null && (thread.focus !== null || ui.current !== null);

  return { ui, actions, link, cursor, currentKey, panelVisible };
};
