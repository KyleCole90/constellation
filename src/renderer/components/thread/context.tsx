import { createContext, useContext } from "react";

import type { ChangeId, ThreadId } from "~/shared/domain/ids";
import type { ThreadUi } from "~/renderer/stores/types";

import type { WorkRow } from "./queue.logic";

/** The pairing between rubric rows in the chat and passages in the panel, which live far apart in the tree. */
export interface RationaleLink {
  hover: string | null;
  selected: string | null;
  /** Bumps on every selection, so choosing the same criterion twice scrolls to it again. */
  tick: number;
  /** Which side was clicked. The other side is the one that scrolls. */
  from: "row" | "passage" | null;
  /** True once per selection, so returning to the source tab keeps your place instead of scrolling again. */
  claimScroll(tick: number): boolean;
  setHover(key: string | null): void;
  selectFromRow(key: string): void;
  selectFromPassage(key: string): void;
}

export const RationaleContext = createContext<RationaleLink | null>(null);

export const useRationale = (): RationaleLink => {
  const link = useContext(RationaleContext);
  if (!link) throw new Error("useRationale outside a thread");
  return link;
};

export interface ThreadActions {
  threadId: ThreadId;
  rows: readonly WorkRow[];
  batch: readonly ChangeId[];
  /** The first read of a send happens before the change says it's sending, so the screen tracks that gap itself. */
  busy: ReadonlySet<ChangeId>;
  drafting: ReadonlySet<string>;
  next: WorkRow | null;
  send(ids: readonly ChangeId[]): void;
  openRow(row: WorkRow): void;
  /** Drafts a message to a missing row's student, leaving the grade alone. */
  messageRow(row: WorkRow): void;
  focus(id: ChangeId): void;
  draftRows(rows: readonly WorkRow[]): Promise<void>;
  setUi(patch: Partial<ThreadUi>): void;
}

export const ThreadActionsContext = createContext<ThreadActions | null>(null);

export const useThreadActions = (): ThreadActions => {
  const actions = useContext(ThreadActionsContext);
  if (!actions) throw new Error("useThreadActions outside a thread");
  return actions;
};
