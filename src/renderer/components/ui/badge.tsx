import { cva, type VariantProps } from "class-variance-authority";
import {
  Check,
  Circle,
  CircleAlert,
  CircleSlash,
  Clock,
  FileUp,
  PenLine,
  Send,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import type { HTMLAttributes } from "react";

import { cn } from "~/renderer/lib/utils";

/** One icon per meaning, so a status reads the same on every screen. */
const STATUS_ICON = {
  late: Clock,
  resubmitted: FileUp,
  missing: CircleSlash,
  ungraded: Circle,
  draft: PenLine,
  ready: Send,
  sent: Check,
  connected: Check,
  error: CircleAlert,
  disconnected: Unplug,
} as const satisfies Record<string, LucideIcon>;

export type StatusIcon = keyof typeof STATUS_ICON;

const TONE_TEXT = {
  neutral: "text-secondary-label",
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-error-foreground",
} as const;

export function StatusGlyph({
  icon,
  tone,
  className,
}: {
  icon: StatusIcon;
  tone?: keyof typeof TONE_TEXT;
  className?: string;
}) {
  const Icon = STATUS_ICON[icon];
  return (
    <Icon aria-hidden className={cn("size-3 flex-none", tone && TONE_TEXT[tone], className)} />
  );
}

// A badge is a status, never a control. It is coloured text with no fill, so the names in a row stay louder than their statuses.
const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 text-meta font-medium whitespace-nowrap",
  {
    variants: { tone: TONE_TEXT },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

/** One icon, word and tone per submission status, so the grading list, the gradebook and the roster all say it the same way. */
export const SUBMISSION_STATUS = {
  ungraded: { icon: "ungraded", tone: "neutral", word: "Ungraded" },
  // Lateness is a fact about the work, not something waiting on the teacher, so it stays out of amber.
  late: { icon: "late", tone: "neutral", word: "Late" },
  missing: { icon: "missing", tone: "danger", word: "Missing" },
  resubmitted: { icon: "resubmitted", tone: "neutral", word: "Resubmitted" },
} as const satisfies Record<string, { icon: StatusIcon; tone: BadgeTone; word: string }>;

export type SubmissionStatus = keyof typeof SUBMISSION_STATUS;

export function Badge({
  className,
  tone,
  icon,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants> & { icon?: StatusIcon | undefined }) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props}>
      {icon && <StatusGlyph icon={icon} />}
      {children}
    </span>
  );
}

/** A submission status in its shared look. The children replace the plain word when the status carries a number, as in "2d late". */
export function SubmissionBadge({
  status,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { status: SubmissionStatus }) {
  const { icon, tone, word } = SUBMISSION_STATUS[status];
  return (
    <Badge tone={tone} icon={icon} {...props}>
      {children ?? word}
    </Badge>
  );
}
