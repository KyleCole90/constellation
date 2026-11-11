import { cx, type CxOptions } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// Without these it reads text-meta as a color and drops it beside text-foreground, and never lets a spacing or width token override another.
export const CLASS_TOKENS = {
  text: ["meta", "body", "chat", "title", "screen", "page", "hero"],
  spacing: [
    "card",
    "card-gap",
    "card-head-x",
    "card-head-y",
    "row-x",
    "row-y",
    "row-end",
    "cell-x",
    "cell-y",
    "cell-end",
    "banner-x",
    "banner-y",
    "pill-x",
    "pill-y",
    "field-x",
    "field-y",
    "field",
    "label-gap",
    "btn-sm",
    "btn-md",
    "btn-lg",
    "btn-gap",
    "row-one",
    "row-two",
    "row-table",
    "grade-total-end",
  ],
  container: ["chat", "setup", "settings"],
  radius: ["control", "card", "bar"],
  shadow: [
    "popover",
    "dialog",
    "drawer",
    "pinned-column-left",
    "pinned-column-right",
    "action-bar",
    "today",
  ],
};

const twMerge = extendTailwindMerge({ extend: { theme: CLASS_TOKENS } });

export const cn = (...inputs: CxOptions): string => twMerge(cx(inputs));

const parts = (iso: string, options: Intl.DateTimeFormatOptions): string =>
  new Date(iso).toLocaleString("en-US", options);
export const formatTime = (iso: string): string =>
  parts(iso, { hour: "numeric", minute: "2-digit" });
export const formatDay = (iso: string): string => parts(iso, { month: "short", day: "numeric" });
export const formatDayTime = (iso: string): string =>
  parts(iso, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
