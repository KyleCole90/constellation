import { cn } from "~/renderer/lib/utils";
import { NOT_STARTED, type ThreadStatus } from "~/renderer/stores/selectors";

import { Badge, type BadgeTone, type StatusIcon } from "./ui/badge";

// Amber is anything waiting on the teacher, blue is unread or in progress, red is something that went wrong.
export const STATUS_TONE: Readonly<Record<ThreadStatus["tone"], BadgeTone>> = {
  todo: "neutral",
  approval: "warning",
  ready: "success",
  working: "info",
  attention: "danger",
  done: "success",
  unread: "info",
};

const DOT: Readonly<Record<BadgeTone, string>> = {
  neutral: "text-secondary-label",
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-error-foreground",
};

// Only a state beyond "there is work here" earns a dot, so the dot itself is the news. To do and unread stay a plain count.
const DOT_MEANING: Readonly<Partial<Record<ThreadStatus["tone"], string>>> = {
  approval: "needs your approval",
  ready: "ready to send",
  working: "working",
  attention: "needs attention",
};

export function CompactStatus({ tone, label, className }: ThreadStatus & { className?: string }) {
  const count = label.match(/^\d+/)?.[0];
  const meaning = DOT_MEANING[tone];
  return (
    <span
      data-slot="badge"
      title={meaning ? `${label}\nDot: ${meaning}` : label}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-meta text-secondary-label tabular-nums",
        className,
      )}
    >
      {count}
      {meaning && (
        <span
          data-status-dot
          className={cn(
            "size-1.5 rounded-full bg-current",
            DOT[STATUS_TONE[tone]],
            tone === "working" && "dot-pulse",
          )}
        />
      )}
    </span>
  );
}

const ICON: Readonly<Partial<Record<ThreadStatus["tone"], StatusIcon>>> = {
  approval: "draft",
  ready: "ready",
  attention: "error",
  done: "sent",
};

export function StatusPill({ tone, label, className }: ThreadStatus & { className?: string }) {
  // The default state repeats down every list, so it shows nothing; the words stay for screen readers and checks. The relative box keeps the sr-only text from widening a scroller.
  if (label === NOT_STARTED.label)
    return (
      <span className={cn("relative", className)}>
        <span className="sr-only">{label}</span>
      </span>
    );
  return (
    <Badge tone={STATUS_TONE[tone]} icon={ICON[tone]} className={className}>
      {tone === "working" && (
        <span className="dot-pulse size-1.5 flex-none rounded-full bg-current" />
      )}
      {label}
    </Badge>
  );
}
