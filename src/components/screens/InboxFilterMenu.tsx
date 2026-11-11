import { Menu } from "@base-ui/react/menu";
import { Check } from "lucide-react";

import { cn } from "~/lib/utils";

import { CHIP, toggleState } from "../ui/toggle";
import type { InboxStatus } from "./inbox.logic";

export const OVERFLOW_STATUS: InboxStatus = "waiting";

const ITEM =
  "flex h-btn-sm cursor-pointer items-center gap-2 rounded-md px-2 text-body outline-none data-[highlighted]:bg-accent";

/** The list column holds one row of chips, so the rarer filter lives here. A choice in the menu lights the trigger, so it can't be forgotten. */
export function FilterMenu({
  status,
  onStatus,
  waiting,
}: {
  status: InboxStatus;
  onStatus: (next: InboxStatus) => void;
  waiting: number;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="More filters"
        className={cn(CHIP, "px-1.5", toggleState(status === OVERFLOW_STATUS))}
      >
        More
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="start" className="z-50">
          <Menu.Popup
            data-testid="inbox-filter-menu"
            className="flex w-[220px] flex-col gap-2 rounded-lg border border-input bg-popover p-2 shadow-dialog outline-none"
          >
            <Menu.CheckboxItem
              closeOnClick
              data-testid="filter-waiting"
              checked={status === OVERFLOW_STATUS}
              onCheckedChange={(on) => onStatus(on ? OVERFLOW_STATUS : "all")}
              className={ITEM}
            >
              <span className="min-w-0 flex-1 truncate">Waiting on approval</span>
              <span className="text-meta text-muted-foreground tabular-nums">{waiting}</span>
              <Menu.CheckboxItemIndicator>
                <Check className="size-3.5" />
              </Menu.CheckboxItemIndicator>
            </Menu.CheckboxItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
