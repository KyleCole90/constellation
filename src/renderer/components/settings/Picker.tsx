import { Select } from "@base-ui/react/select";
import { ChevronDown } from "lucide-react";

import { cn } from "~/renderer/lib/utils";

export interface PickerItem {
  value: string;
  label: string;
}

export function Picker({
  label,
  items,
  value,
  onChange,
  disabled,
  className,
}: {
  label: string;
  items: readonly PickerItem[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const shown = items.find((item) => item.value === value)?.label ?? "Nothing to pick";
  return (
    <Select.Root
      value={value}
      onValueChange={(next) => next !== null && onChange(next)}
      disabled={Boolean(disabled) || items.length === 0}
    >
      <Select.Trigger
        aria-label={label}
        className={cn(
          "inline-flex h-btn-md max-w-[240px] min-w-[120px] cursor-pointer items-center justify-between gap-2 rounded-control border border-input bg-accent px-2.5 text-body hover:bg-foreground/7 disabled:pointer-events-none disabled:opacity-55",
          className,
        )}
      >
        <span className="truncate">{shown}</span>
        <ChevronDown className="size-3 flex-none text-muted-foreground" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          sideOffset={4}
          alignItemWithTrigger={false}
          className="z-50 outline-none"
        >
          <Select.Popup
            data-testid="picker-popup"
            className="max-h-64 min-w-(--anchor-width) overflow-y-auto rounded-lg border border-input bg-popover p-1 shadow-popover outline-none"
          >
            {items.map((item) => (
              <Select.Item
                key={item.value}
                value={item.value}
                className="flex h-7 cursor-pointer items-center rounded-md px-2 text-body outline-none select-none data-highlighted:bg-foreground/7"
              >
                <Select.ItemText>{item.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
