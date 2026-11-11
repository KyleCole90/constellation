/** The one selected look for every tab, filter pill, segmented choice and toggle chip: the raised neutral fill with full-strength text. Blue stays for primary buttons, today, links and unread counts. */
export const toggleState = (on: boolean): string =>
  on ? "bg-selected text-foreground" : "text-muted-foreground hover:text-foreground";

export const TAB = "inline-flex h-btn-sm cursor-pointer items-center rounded-md px-2.5 text-meta";

/** A pane's own tab row sits under the content header, so it stays quieter than the toggles: no fill, a primary underline on the open tab. */
export const paneTab = (on: boolean): string =>
  `inline-flex h-btn-sm cursor-pointer items-center border-b-2 px-1 text-meta ${
    on
      ? "border-primary text-foreground"
      : "border-transparent text-muted-foreground hover:text-foreground"
  }`;

export const CHIP =
  "inline-flex h-btn-sm cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 text-meta whitespace-nowrap";
