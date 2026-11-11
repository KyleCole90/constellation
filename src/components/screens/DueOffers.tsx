import { X } from "lucide-react";

import type { LmsRef } from "~/domain/ids";
import { cn } from "~/lib/utils";
import { selectSetupOffers } from "~/stores/selectors";
import { useWorkspace, workspaceStore } from "~/stores/workspace";

import { SchoolBadge } from "../SchoolBadge";
import { showUndoToast } from "../SettleAction";
import { useStartSetup } from "../setup/Offers";
import { Button } from "../ui/button";
import type { SchoolFilter } from "./due.logic";

/** The boxed lists' 1px border, kept transparent where there is no box, so every heading and row on What's due starts on the card's text edge. */
const EDGE = "border-x border-transparent";
/** Every section on What's due: the section title with more room above than below, over one bordered list. */
export const SECTION_LABEL = `${EDGE} px-row-x pt-5 pb-2 section-title`;
export const SECTION_LIST =
  "divide-y divide-border overflow-hidden rounded-lg border border-border";

export function DueOffers({ school = "all" }: { school?: SchoolFilter }) {
  const all = useWorkspace(selectSetupOffers);
  const dismissed = useWorkspace((state) => state.prefs.offersDismissed);
  const start = useStartSetup();
  const offers = all.filter(
    (offer) =>
      (offer.thread !== null || !dismissed?.[offer.shell.ref]) &&
      (school === "all" || offer.shell.school === school),
  );
  if (offers.length === 0) return null;
  const dismiss = (course: LmsRef<"course">, code: string) => {
    workspaceStore()
      .getState()
      .setPrefs({ offersDismissed: { ...dismissed, [course]: true } });
    showUndoToast(`Dismissed ${code}`, () => {
      const { prefs, setPrefs } = workspaceStore().getState();
      const { [course]: _undone, ...rest } = prefs.offersDismissed ?? {};
      setPrefs({ offersDismissed: rest });
    });
  };
  const cancel = (course: LmsRef<"course">, code: string) => {
    const cancelled = workspaceStore().getState().cancelSetup(course);
    if (cancelled.ok)
      showUndoToast(`Cancelled setup of ${code}`, () => {
        workspaceStore().getState().restoreSetup(cancelled.value);
      });
  };
  return (
    <section data-testid="offer-banner" data-due-group="offers">
      <h2 className={SECTION_LABEL}>
        {offers.length} new {offers.length === 1 ? "course" : "courses"} for{" "}
        {[...new Set(offers.map(({ shell }) => shell.termName))].join(" and ")}
      </h2>
      <ul className={SECTION_LIST}>
        {offers.map(({ shell, words, thread, cancellable }) => (
          <li
            key={shell.ref}
            data-row={shell.ref}
            data-testid="setup-offer"
            data-surface="due"
            data-course={shell.ref}
            className={cn(
              "flex min-h-row-one items-center gap-2 pl-row-x",
              thread === null ? "pr-1" : "pr-row-x",
            )}
          >
            <SchoolBadge school={shell.school} />
            <span className="w-[68px] flex-none truncate text-meta text-secondary-label">
              {shell.code}
            </span>
            <p className="min-w-0 flex-1 truncate text-body text-secondary-label">
              {shell.title}. <span className="text-muted-foreground">{words}.</span>
            </p>
            <Button
              variant="ghost-muted"
              size="sm"
              data-offer-start
              onClick={() => start(shell.ref)}
            >
              {thread ? "Continue setup" : "Set up this course"}
            </Button>
            {/* Keyed apart, so Cancel setup leaves the page and hands focus on, rather than turning into Dismiss under it. */}
            {thread === null ? (
              <Button
                key="dismiss"
                variant="ghost-muted"
                size="icon"
                aria-label={`Dismiss ${shell.code}`}
                onClick={() => dismiss(shell.ref, shell.code)}
              >
                <X />
              </Button>
            ) : (
              cancellable && (
                <Button
                  key="cancel"
                  variant="ghost-muted"
                  size="sm"
                  data-lands="[data-offer-start]"
                  onClick={() => cancel(shell.ref, shell.code)}
                >
                  Cancel setup
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
