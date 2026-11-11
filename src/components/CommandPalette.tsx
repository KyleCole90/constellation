import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import {
  selectSetupOffers,
  selectThreadName,
  selectThreadStatus,
  withoutChatThreads,
} from "~/stores/selectors";
import { useAiOn, useWorkspace, workspaceStore } from "~/stores/workspace";

import { SchoolBadge } from "./SchoolBadge";
import { useWorkLinks } from "./screens/workLinks";
import { ResetDemoDialog } from "./settings/ResetDemoDialog";
import { useStartSetup } from "./setup/Offers";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { buildEntries, filterEntries, type PaletteEntry } from "./palette.logic";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const links = useWorkLinks();
  const threads = useWorkspace((state) => state.threads);
  const ai = useAiOn();
  const cache = useWorkspace((state) => state.cache);
  const schools = useWorkspace((state) => state.schools);
  const connections = useWorkspace((state) => state.connections);
  const offers = useWorkspace(selectSetupOffers);
  const startSetup = useStartSetup();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  // Read before the input's autoFocus takes focus, which would otherwise leave the dialog nothing to hand focus back to.
  const [opener, setOpener] = useState<Element | null>(null);
  const list = useRef<HTMLDivElement>(null);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setOpener(document.activeElement);
      setQuery("");
      setIndex(0);
    }
  }

  const entries = useMemo(() => {
    const caches = Object.values(cache);
    const state = workspaceStore().getState();
    return buildEntries({
      threads: withoutChatThreads(Object.values(threads), ai).map((thread) => ({
        ...thread,
        title: selectThreadName(state, thread.id),
        toApprove: selectThreadStatus(state, thread.id)?.tone === "approval",
      })),
      schools,
      connections,
      courses: caches.flatMap((c) => c.courses),
      shells: offers.map((offer) => offer.shell),
      students: caches.flatMap((c) => c.students),
      submissions: caches.flatMap((c) => c.submissions),
    });
    // oxlint-disable-next-line react/memo-dependencies -- names and approval state come from a store snapshot, so each opening rebuilds them
  }, [threads, cache, offers, ai, schools, connections, open]);
  const shown = useMemo(() => filterEntries(entries, query), [entries, query]);

  useEffect(() => {
    list.current?.querySelectorAll("[data-on]")[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const go = (entry: PaletteEntry) => {
    const { target } = entry;
    // A result that opens another screen leaves focus to that screen's own arrival.
    if (target.kind !== "sync" && target.kind !== "reset-demo") setOpener(null);
    onOpenChange(false);
    switch (target.kind) {
      case "thread":
        return void navigate({ to: "/threads/$threadId", params: { threadId: target.id } });
      case "course":
        return void navigate({ to: "/courses/$courseId", params: { courseId: target.course.ref } });
      case "setup":
        return startSetup(target.course);
      case "course-page":
        return void navigate({
          to:
            target.page === "gradebook"
              ? "/courses/$courseId/gradebook"
              : "/courses/$courseId/announcements",
          params: { courseId: target.course.ref },
        });
      case "screen":
        return void navigate({ to: target.to });
      case "reset-demo":
        return setResetting(true);
      case "sync":
        return void workspaceStore().getState().syncSchool(target.school);
      case "student": {
        const { submission } = target;
        if (!submission)
          return void navigate({
            to: "/courses/$courseId",
            params: { courseId: target.student.course },
          });
        return links.submission(submission.ref);
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => Math.min(i + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = shown[index];
      if (entry) go(entry);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup
          variant="bare"
          className="w-[min(560px,90vw)] overflow-hidden"
          data-testid="palette"
          finalFocus={() => (opener instanceof HTMLElement && opener.isConnected ? opener : false)}
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
          <div className="flex h-10 items-center gap-2 border-b border-border px-4 text-muted-foreground">
            <Search className="size-3.5 flex-none" />
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search threads, courses, students, screens, and actions"
              className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div ref={list} className="max-h-[50vh] overflow-y-auto p-1">
            {shown.length === 0 && (
              <p className="p-3 text-center text-meta text-muted-foreground">
                Nothing matches that.
              </p>
            )}
            {shown.map((entry, i) => (
              <div key={entry.key}>
                {entry.group !== shown[i - 1]?.group && (
                  <div className="px-3 pt-2 pb-1 text-meta text-muted-foreground">
                    {entry.group}
                  </div>
                )}
                <button
                  type="button"
                  data-on={i === index}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => go(entry)}
                  className={cn(
                    "flex h-btn-md w-full min-w-0 items-center gap-2 rounded-md px-3 text-body",
                    i === index && "bg-foreground/7",
                  )}
                >
                  {entry.school && <SchoolBadge school={entry.school} />}
                  <span className="truncate">{entry.title}</span>
                  <span className="ml-auto text-meta whitespace-nowrap text-muted-foreground">
                    {entry.hint}
                  </span>
                </button>
              </div>
            ))}
          </div>
        </DialogPopup>
      </Dialog>
      <ResetDemoDialog open={resetting} onOpenChange={setResetting} />
    </>
  );
}
