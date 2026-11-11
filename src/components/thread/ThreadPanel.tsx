import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type UIEvent } from "react";

import { cn } from "~/lib/utils";
import type { Thread, ThreadUi } from "~/stores/types";

import { SchoolBadge } from "../SchoolBadge";
import { Button } from "../ui/button";
import { paneTab } from "../ui/toggle";
import { BatchPanel } from "./BatchPanel";
import { useThreadActions } from "./context";
import { SourcePane, useSourceTabName } from "./SourcePane";
import { useChange } from "./useChange";
import { WriteBackPanel } from "./WriteBackPanel";
import { focusIsFree } from "~/lib/lostFocus";

export function ThreadPanel({ thread, ui }: { thread: Thread; ui: ThreadUi }) {
  const { setUi, rows } = useThreadActions();
  const view = useChange(thread.focus);
  const record = view?.record ?? null;
  const sourceName = useSourceTabName(record, ui.current);
  const row = rows.find((candidate) => candidate.key === (record?.content.target ?? ui.current));
  const panel = sourceName === null && ui.panel === "source" ? "writeback" : ui.panel;
  const tabs = [
    ...(sourceName === null
      ? []
      : [{ panel: "source", label: sourceName, enabled: true } as const]),
    { panel: "writeback", label: "Preview", enabled: view !== null } as const,
  ];

  // Each tab keeps its own place, so switching back to the submission doesn't lose the paragraph you were reading.
  const scrollTops = useRef<Partial<Record<NonNullable<ThreadUi["panel"]>, number>>>({});
  useLayoutEffect(() => {
    const scroller = document.querySelector("[data-panel-scroll]");
    if (scroller && ui.panel) scroller.scrollTop = scrollTops.current[ui.panel] ?? 0;
  }, [ui.panel]);
  const remember = (event: UIEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (ui.panel && target.hasAttribute("data-panel-scroll"))
      scrollTops.current[ui.panel] = target.scrollTop;
  };

  // The scrim stops the mouse. This stops the keyboard from landing on what's behind it, which only applies at widths where the panel overlays.
  const scrim = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = scrim.current;
    const host = el?.parentElement;
    const main = host?.querySelector<HTMLElement>('[data-testid="thread-main"]');
    if (!el || !host || !main) return;
    const sync = () => {
      const overlaid = getComputedStyle(el).display !== "none";
      if (overlaid && !main.inert)
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      main.inert = overlaid;
      if (overlaid && !aside.current?.contains(document.activeElement)) aside.current?.focus();
    };
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    sync();
    return () => observer.disconnect();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a panel switch needs a fresh focus and inert sync, and the host may not resize to report it
  }, [ui.panel]);
  useEffect(() => {
    const main = scrim.current?.parentElement?.querySelector<HTMLElement>(
      '[data-testid="thread-main"]',
    );
    return () => {
      if (main) main.inert = false;
      opener.current?.focus();
    };
  }, []);
  useEffect(() => {
    if (ui.panel === "writeback" && focusIsFree()) aside.current?.focus({ preventScroll: true });
  }, [ui.panel]);

  return (
    <>
      <div ref={scrim} data-scrim className="thread-scrim" onClick={() => setUi({ panel: null })} />
      <aside
        ref={aside}
        tabIndex={-1}
        aria-label={
          panel === "writeback"
            ? "Preview"
            : panel === "batch"
              ? "Batch review"
              : (sourceName ?? "Preview")
        }
        data-testid="thread-panel"
        data-wide={panel === "batch"}
        className="thread-panel flex h-full min-w-0 flex-col border-l border-border bg-card outline-none"
      >
        {panel === "batch" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <BatchPanel selected={ui.selected} />
          </div>
        ) : (
          <>
            <div className="flex min-h-10 flex-none items-center gap-2 border-b border-border px-2 py-1">
              <div role="tablist" className="flex flex-none gap-3 px-1">
                {tabs.map((tab) => (
                  <button
                    key={tab.panel}
                    type="button"
                    role="tab"
                    aria-selected={panel === tab.panel}
                    title={tab.panel === "writeback" ? "Preview (⌘D)" : undefined}
                    disabled={!tab.enabled}
                    onClick={() => setUi({ panel: tab.panel })}
                    className={cn(
                      paneTab(panel === tab.panel),
                      !tab.enabled && "pointer-events-none text-tertiary-label",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {/* The preview opens on its own header naming the school and subject, so the tab row only names them for the source. */}
              <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                {panel !== "writeback" && (
                  <>
                    {record && <SchoolBadge school={record.school} />}
                    <span className="min-w-0 wrap-anywhere text-right text-meta text-secondary-label">
                      {row?.title ?? record?.subject}
                    </span>
                  </>
                )}
              </div>
              <Button
                variant="ghost-muted"
                size="icon"
                aria-label="Close preview"
                title="Close preview"
                onClick={() => setUi({ panel: null })}
              >
                <X />
              </Button>
            </div>
            <div
              key={panel}
              onScrollCapture={remember}
              className="fade-in flex min-h-0 flex-1 flex-col"
            >
              {panel === "writeback" && view ? (
                <WriteBackPanel view={view} />
              ) : (
                <div
                  data-testid="source-scroll"
                  data-panel-scroll
                  className="min-h-0 flex-1 overflow-y-auto"
                >
                  <SourcePane key={record?.id ?? ui.current} record={record} current={ui.current} />
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
