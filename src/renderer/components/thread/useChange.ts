import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";

import type { ChangePatch, ChangeRecord, ChangeSummary } from "~/shared/domain/change";
import { isoTime, type ChangeId, type ThreadId } from "~/shared/domain/ids";
import type { PreviewField } from "~/shared/domain/preview";
import { NOT_STARTED, selectThreadUi, summarizeFor } from "~/renderer/stores/selectors";
import { REJECTION_TEXT, useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { showUndoToast } from "../SettleAction";
import { useThreadActions } from "./context";

export interface ChangeView {
  record: ChangeRecord;
  summary: ChangeSummary;
  preview: readonly PreviewField[];
}

export const useChange = (id: ChangeId | null): ChangeView | null => {
  const record = useWorkspace((state) =>
    id ? (state.changes[id] ?? state.blanks[id] ?? null) : null,
  );
  const saved = useWorkspace((state) => (id ? state.changes[id] !== undefined : false));
  const status = useWorkspace((state) =>
    record ? state.connections[record.school]?.status : undefined,
  );
  const online = useWorkspace((state) => state.online);
  return useMemo(() => {
    if (!record) return null;
    const preview = workspaceStore().getState().previewFor(record.id);
    if (!preview) return null;
    const summary = summarizeFor(record, status, online);
    return {
      record,
      summary: saved ? summary : { ...summary, label: NOT_STARTED.label, canDiscard: false },
      preview,
    };
  }, [record, status, online, saved]);
};

const nowIso = () => isoTime(workspaceStore().getState().now());

/** Returns why it was refused, in words, or null when the edit went through. */
export const editChange = (id: ChangeId, patch: ChangePatch): string | null => {
  const result = workspaceStore()
    .getState()
    .dispatchUser(id, { type: "edit", by: "you", patch, at: nowIso() });
  return result.ok ? null : REJECTION_TEXT[result.error];
};
export const revokeApproval = (id: ChangeId) =>
  workspaceStore().getState().dispatchUser(id, { type: "revoke", at: nowIso() });

/**
 * The thread lets go of it too, so nothing stays open on a change that no longer exists. Its item stays on screen
 * with a way to start again: a conversation with its history, a submission undrafted with Draft with Claude and Grade it yourself.
 */
export const discardChange = (thread: ThreadId, id: ChangeId) => {
  const state = workspaceStore().getState();
  const record = state.changes[id];
  const ui = selectThreadUi(state, thread);
  if (!record || !state.dispatchUser(id, { type: "discard", at: nowIso() }).ok) return;
  state.focusChange(thread, null);
  // Only the preview showed the change. The student's work beside it stays open for whatever the teacher does next.
  const panel = ui.panel === "writeback" ? null : ui.panel;
  state.setThreadUi(
    thread,
    record.content.kind === "grade" ? { panel, current: record.content.target } : { panel },
  );
  showUndoToast(`Discarded “${record.subject}”`, () => {
    const now = workspaceStore().getState();
    if (!now.restoreChange(record)) return;
    now.focusChange(thread, id);
    now.setThreadUi(thread, { panel: ui.panel, current: ui.current, queueOpen: ui.queueOpen });
  });
};

/** Puts the cursor in the draft's text, scrolled to the middle of the chat. */
export const focusDraftField = () => {
  const field = document.querySelector<HTMLElement>("[data-edit-field]");
  field?.scrollIntoView({ block: "center" });
  field?.focus();
};

/** The card is collapsed while the preview is open, so closing the preview comes first and brings the field back. */
export const useEditDraft = (): (() => void) => {
  const { setUi } = useThreadActions();
  return () => {
    flushSync(() => setUi({ panel: null }));
    focusDraftField();
  };
};

const FLASH_MS = 1400;

/** True briefly after the agent moved this value. A change you made yourself needs no pointing out. */
export const useAgentFlash = (value: unknown, record: ChangeRecord): boolean => {
  const [previous, setPrevious] = useState(value);
  const [flash, setFlash] = useState<{ value: unknown } | null>(null);
  if (previous !== value) {
    setPrevious(value);
    if (record.activity.at(-1)?.actor === "agent") setFlash({ value });
  }
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  return flash !== null;
};
