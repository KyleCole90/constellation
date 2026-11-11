import { useState } from "react";

import type { School } from "~/domain/lms";
import { selectSchoolCoverage } from "~/stores/selectors";
import { useWorkspace } from "~/stores/workspace";

import { TokenDialog } from "../TokenDialog";
import { StatusGlyph } from "../ui/badge";
import { Button } from "../ui/button";

function DisconnectedLine({ school }: { school: School }) {
  const [connecting, setConnecting] = useState(false);
  return (
    <div
      data-disconnected={school.id}
      className="flex items-center gap-2 rounded-lg bg-error-surface py-1 pr-1 pl-3 text-body text-foreground"
    >
      <StatusGlyph icon="disconnected" tone="danger" className="size-4" />
      <span className="min-w-0 flex-1 truncate">
        {school.name} is disconnected. Its work is not shown.
      </span>
      <Button variant="default" size="sm" onClick={() => setConnecting(true)}>
        Reconnect
      </Button>
      <TokenDialog school={school.id} open={connecting} onOpenChange={setConnecting} />
    </div>
  );
}

export function DisconnectedNotice({
  className = "flex-none border-b border-border px-4 py-1.5",
}: {
  className?: string;
}) {
  const { disconnected } = useWorkspace(selectSchoolCoverage);
  if (disconnected.length === 0) return null;
  return (
    <div data-testid="disconnected-notice" className={`flex flex-col gap-1 ${className}`}>
      {disconnected.map((school) => (
        <DisconnectedLine key={school.id} school={school} />
      ))}
    </div>
  );
}
