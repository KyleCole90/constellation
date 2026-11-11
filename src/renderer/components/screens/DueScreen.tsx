import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/renderer/lib/utils";
import {
  GRADING_LIST_THREAD,
  selectSchoolCoverage,
  selectSchoolGap,
  type DueItem,
} from "~/renderer/stores/selectors";
import { useWorkspace } from "~/renderer/stores/workspace";

import { EmptyState } from "../EmptyState";
import { SchoolBadge } from "../SchoolBadge";
import { ScreenHeader } from "../ScreenHeader";
import { SCREEN_ICON } from "../screenIcons";
import { StatusPill } from "../StatusPill";
import { Button, buttonVariants } from "../ui/button";
import { OpensChevron } from "../ui/chevron";
import { DisconnectedNotice } from "./DisconnectedNotice";
import { NoSchool } from "./NoSchool";
import { DueOffers, SECTION_LABEL, SECTION_LIST } from "./DueOffers";
import {
  dueSummary,
  nothingDueWords,
  sittingLoad,
  sittingName,
  sittingsOf,
  sittingWhen,
  stepInstruction,
  stepReason,
  whenWords,
  type PlannedWork,
  type SchoolFilter,
  type Sitting,
} from "./due.logic";
import { SchoolChips } from "./SchoolChips";
import { StepAction } from "./StepAction";
import { usePlan } from "./usePlan";
import { useWorkLinks } from "./workLinks";

const COLUMN = "mx-auto w-full max-w-chat px-4";
const ROW =
  "flex w-full min-w-0 cursor-pointer items-center gap-2 pr-row-end pl-row-x text-left hover:bg-accent focus-inset rounded-md";
const CODE = "w-[68px] flex-none truncate text-meta text-secondary-label";
const ACTION: Readonly<Record<PlannedWork["verb"], string>> = {
  Reconnect: "Reconnect",
  Grade: "Start grading",
  Write: "Start writing",
  Post: "Open draft",
  "Reply to": "Open messages",
  Fix: "See what failed",
  Review: "Review and approve",
};

const titleCase = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);
const inTrouble = (step: PlannedWork): boolean => step.verb === "Fix" || step.verb === "Reconnect";

function NextStep({ step }: { step: PlannedWork | undefined }) {
  return (
    <section
      data-due-group="next"
      data-row={step?.key}
      className="flex flex-col items-start gap-1 rounded-lg border border-border bg-card px-row-x py-card"
    >
      <h2 className="section-title">Do this next</h2>
      {step ? (
        <>
          <p className="text-hero">{stepInstruction(step)}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-body text-secondary-label">
            <SchoolBadge school={step.school} />
            {step.courseCode && <span className="text-meta">{step.courseCode}</span>}
            <StatusPill tone={step.detailTone} label={step.detail} />
          </p>
          <p className="text-body">{step.why}</p>
          <StepAction
            step={step}
            slot="button"
            className={cn(buttonVariants({ variant: "default", size: "md" }), "mt-2")}
          >
            {ACTION[step.verb]}
          </StepAction>
        </>
      ) : (
        <p className="text-title">Nothing needs you right now.</p>
      )}
    </section>
  );
}

function StepRow({ step, reason }: { step: PlannedWork; reason: string | null }) {
  return (
    <li data-row={step.key}>
      <StepAction step={step} className={`${ROW} min-h-row-one`}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body">{stepInstruction(step)}</span>
          {reason && (
            <span
              className={cn(
                "truncate text-meta",
                inTrouble(step) ? "text-error-foreground" : "text-muted-foreground",
              )}
            >
              {reason}
            </span>
          )}
        </span>
        <SchoolBadge school={step.school} />
        <span className={CODE}>{step.courseCode}</span>
        <span className="max-w-[200px] flex-none truncate text-right text-meta">
          <StatusPill tone={step.detailTone} label={step.detail} />
        </span>
        <OpensChevron />
      </StepAction>
    </li>
  );
}

function SittingRow({ sitting }: { sitting: Sitting }) {
  return (
    <li>
      <details data-due-course={sitting.key} className="group">
        <summary
          data-row={sitting.key}
          className={`${ROW} min-h-row-one list-none [&::-webkit-details-marker]:hidden`}
        >
          <ChevronRight className="size-3 flex-none text-muted-foreground transition-transform group-open:rotate-90" />
          <SchoolBadge school={sitting.school} />
          <span className={CODE}>{sittingName(sitting)}</span>
          <span className="min-w-0 flex-1 truncate text-body text-foreground">
            {sittingWhen(sitting)}
          </span>
          <span className="flex-none text-meta text-secondary-label tabular-nums">
            {sittingLoad(sitting)}
          </span>
        </summary>
        <ul className="divide-y divide-border border-t border-border">
          {sitting.steps.map((step) => (
            <StepRow key={step.key} step={step} reason={stepReason(step, sitting)} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function NotYetRow({ item }: { item: DueItem }) {
  const links = useWorkLinks();
  return (
    <li data-row={item.assignment.ref}>
      <button
        type="button"
        data-due-row={item.assignment.ref}
        onClick={() => links.assignment(item.assignment)}
        className={`${ROW} min-h-row-one`}
      >
        <span className="w-[72px] flex-none text-meta text-muted-foreground">
          {titleCase(whenWords(item.days, item.assignment.dueAt))}
        </span>
        <SchoolBadge school={item.school} />
        <span className={CODE}>{item.course.code}</span>
        <span className="min-w-0 flex-1 truncate text-body text-secondary-label">
          {item.assignment.title}
        </span>
        {item.submitted > 0 && (
          <span className="flex-none text-meta text-muted-foreground tabular-nums">
            {item.submitted} submitted
          </span>
        )}
        <OpensChevron />
      </button>
    </li>
  );
}

export function DueScreen() {
  const [school, setSchool] = useState<SchoolFilter>("all");
  const plan = usePlan(school);
  const { disconnected } = useWorkspace(selectSchoolCoverage);
  const gap = useWorkspace(selectSchoolGap);
  const [current, ...later] = useMemo(() => sittingsOf(plan), [plan]);
  const [next, ...alongside] = current?.steps ?? [];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ScreenHeader
        icon={SCREEN_ICON.due}
        title="What's due"
        actions={
          <>
            <Link
              to="/threads/$threadId"
              params={{ threadId: GRADING_LIST_THREAD }}
              data-testid="grading-list-link"
              data-slot="button"
              className={buttonVariants({ variant: "ghost-muted", size: "sm" })}
            >
              Grading list
              <OpensChevron />
            </Link>
            {/* No fill and a hairline with room either side keep the one action from reading as a fourth filter chip. */}
            {!gap && <span aria-hidden className="mx-2 h-4 w-px bg-border" />}
            <SchoolChips value={school} onChange={setSchool} />
          </>
        }
      />
      <DisconnectedNotice />
      {gap ? (
        <NoSchool gap={gap} />
      ) : plan.steps.length === 0 && plan.notYet.length === 0 ? (
        <>
          <EmptyState title={nothingDueWords(school, disconnected.length > 0)}>
            {school !== "all" && (
              <Button size="sm" onClick={() => setSchool("all")}>
                Show all schools
              </Button>
            )}
          </EmptyState>
          <div className={`${COLUMN} flex-none pb-4`}>
            <DueOffers school={school} />
          </div>
        </>
      ) : (
        <div data-testid="due-list" className="min-h-0 flex-1 overflow-y-auto pb-4">
          <div className={`${COLUMN} flex flex-col pt-3`}>
            <p data-testid="due-summary" className="pb-2 text-body text-secondary-label">
              {dueSummary(plan.totals)}
            </p>
            <NextStep step={next} />
            {alongside.length > 0 && current && (
              <section data-due-group="alongside">
                <h2 className={SECTION_LABEL}>Also {sittingWhen(current)}</h2>
                <ul className={SECTION_LIST}>
                  {alongside.map((step) => (
                    <StepRow key={step.key} step={step} reason={stepReason(step, current)} />
                  ))}
                </ul>
              </section>
            )}
            {later.length > 0 && (
              <section data-due-group="steps">
                <h2 className={SECTION_LABEL}>Then, in this order</h2>
                <ol className={SECTION_LIST}>
                  {later.map((sitting) => (
                    <SittingRow key={sitting.key} sitting={sitting} />
                  ))}
                </ol>
              </section>
            )}
            {plan.notYet.length > 0 && (
              <section data-due-group="not-yet">
                <h2 className={SECTION_LABEL}>Not yet. Students are still working on these.</h2>
                <ul className={SECTION_LIST}>
                  {plan.notYet.map((item) => (
                    <NotYetRow key={item.assignment.ref} item={item} />
                  ))}
                </ul>
              </section>
            )}
            <DueOffers school={school} />
          </div>
        </div>
      )}
    </div>
  );
}
