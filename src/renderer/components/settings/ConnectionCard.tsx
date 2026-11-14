import { VAULT_PLACE } from "~/renderer/desktop";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { School } from "~/shared/domain/lms";
import { cn } from "~/renderer/lib/utils";
import { hasChanges, useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { SchoolBadge } from "../SchoolBadge";
import { TokenDialog } from "../TokenDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { RemoveSchoolDialog } from "./RemoveSchoolDialog";
import {
  ACTION_LABEL,
  STATUS_VIEW,
  cardActions,
  connectionStatus,
  savedWords,
  scopeSummary,
  syncFailureWords,
  syncWords,
  waitingCount,
  waitingWords,
  type ConnectionAction,
} from "./connection.logic";
import { useNow } from "./useNow";

const ACTION_VARIANT: Readonly<
  Record<ConnectionAction, "default" | "outline" | "destructive-outline">
> = {
  connect: "default",
  reconnect: "default",
  sync: "outline",
  replace: "outline",
  disconnect: "destructive-outline",
  remove: "destructive-outline",
};

export function ConnectionCard({ school }: { school: School }) {
  const record = useWorkspace((state) => state.connections[school.id]);
  const status = useWorkspace((state) =>
    connectionStatus(state.connections[school.id], Boolean(state.syncing[school.id]), state.online),
  );
  const scopes = useWorkspace(useShallow((state) => state.scopeWordsFor(school.id)));
  const waiting = useWorkspace((state) =>
    waitingCount(
      Object.values(state.changes),
      school.id,
      state.connections[school.id]?.status ?? "disconnected",
    ),
  );
  const hasDrafts = useWorkspace((state) => hasChanges(state, school.id));
  const now = useNow();
  const [entering, setEntering] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showScopes, setShowScopes] = useState(false);
  const view = STATUS_VIEW[status];

  const act = (action: ConnectionAction) => {
    if (action === "disconnect") setConfirming(true);
    else if (action === "remove") setRemoving(true);
    else if (action === "sync") void workspaceStore().getState().syncSchool(school.id);
    else setEntering(true);
  };

  return (
    <article
      data-school={school.id}
      data-connection={status}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <header className="flex items-center gap-2">
        <SchoolBadge school={school} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-title">{school.name}</h3>
          {school.host !== school.name && (
            <p data-school-host className="truncate text-meta text-muted-foreground">
              {school.host}
            </p>
          )}
        </div>
        <Badge tone={view.badge} icon={view.icon} data-testid="connection-status">
          {view.label}
        </Badge>
      </header>

      {status === "expired" && (
        <p
          data-testid="waiting-words"
          className="rounded-lg bg-warning-surface px-3 py-2 text-meta text-warning-foreground"
        >
          {waitingWords(waiting)}
        </p>
      )}
      {status === "sync-failed" && (
        <p className="rounded-lg bg-error-surface px-3 py-2 text-meta text-error-foreground">
          {syncFailureWords(record?.syncError ?? null, now, record?.lastSyncedAt ?? null)}
        </p>
      )}

      {record?.status === "disconnected" ? (
        <p className="text-meta text-muted-foreground">
          No token saved. Your drafts stay here until you connect.
        </p>
      ) : (
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta">
          <dt className="text-muted-foreground">Account</dt>
          <dd>{record?.accountName}</dd>
          <dt className="text-muted-foreground">Can do</dt>
          <dd>
            <button
              type="button"
              data-text-link
              data-testid="scope-toggle"
              aria-expanded={showScopes}
              onClick={() => setShowScopes(!showScopes)}
              className="flex cursor-pointer items-center gap-1 rounded text-left"
            >
              {scopeSummary(scopes)}
              <span className="link ml-1 flex items-center gap-1">
                <ChevronRight
                  className={cn("size-3 flex-none transition-transform", showScopes && "rotate-90")}
                />
                Details
              </span>
            </button>
            {showScopes && (
              <ul
                data-testid="scope-list"
                className="mt-2 flex flex-col gap-1 text-secondary-label"
              >
                {scopes.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
            )}
          </dd>
          <dt className="text-muted-foreground">Token</dt>
          <dd data-testid="token-words">
            {record?.connectedAt ? savedWords(record.connectedAt) : "Saved"}
          </dd>
          <dt className="text-muted-foreground">Last sync</dt>
          <dd>{syncWords(now, record?.lastSyncedAt ?? null)}</dd>
        </dl>
      )}

      <footer className="flex flex-wrap justify-end gap-2">
        {cardActions(status, hasDrafts).map((action) => (
          <Button
            key={action}
            data-action={action}
            variant={ACTION_VARIANT[action]}
            size="sm"
            disabled={action === "sync" && status === "syncing"}
            onClick={() => act(action)}
          >
            {action === "sync" && status === "syncing" ? "Syncing" : ACTION_LABEL[action]}
          </Button>
        ))}
      </footer>

      <TokenDialog school={school.id} open={entering} onOpenChange={setEntering} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Disconnect ${school.name}?`}
        confirmLabel="Disconnect"
        onConfirm={() => workspaceStore().getState().disconnect(school.id)}
      >
        <p>
          This forgets the token in {VAULT_PLACE} and the course data read from {school.host}.
        </p>
        <p>
          Your unsent work and approvals are kept, and nothing is deleted from the LMS. Connect
          again at any time to pick up where you left off.
        </p>
      </ConfirmDialog>
      <RemoveSchoolDialog
        school={school}
        open={removing}
        onOpenChange={setRemoving}
        onConfirm={async () => {
          await workspaceStore().getState().removeSchool(school.id);
        }}
      />
    </article>
  );
}
