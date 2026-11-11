import { Link } from "@tanstack/react-router";

import { SchoolBadge } from "../SchoolBadge";
import { DisconnectedNotice } from "../screens/DisconnectedNotice";
import { SECTION_LIST } from "../screens/DueOffers";
import { sittingsOf, stepInstruction } from "../screens/due.logic";
import { StepAction } from "../screens/StepAction";
import { StatusPill } from "../StatusPill";
import { OpensChevron } from "../ui/chevron";
import { usePlan } from "../screens/usePlan";

const SHOWN = 3;
const INSET = "px-4.25";

export function NextUp() {
  const plan = usePlan("all");
  const steps = sittingsOf(plan)
    .flatMap((sitting) => sitting.steps.slice(0, 1))
    .slice(0, SHOWN);
  if (steps.length === 0) return null;
  return (
    <section data-testid="next-up" aria-label="Next up" className="pt-4">
      <div className={`flex items-baseline justify-between pb-1 ${INSET}`}>
        <h2 className="section-title">Next up</h2>
        <Link
          to="/due"
          data-testid="next-up-all"
          className="link flex items-center gap-0.5 rounded text-meta"
        >
          All {plan.steps.length} of what's due
          <OpensChevron />
        </Link>
      </div>
      <DisconnectedNotice className="pb-1" />
      <ol className={`@container ${SECTION_LIST}`}>
        {steps.map((step) => (
          <li key={step.key} data-row={step.key}>
            <StepAction
              step={step}
              className="grid min-h-row-one w-full cursor-pointer grid-cols-[minmax(0,1.3fr)_2.5rem_4rem_minmax(0,1fr)_0.75rem] items-center @max-[560px]:grid-cols-[minmax(0,1fr)_2.5rem_4rem_0.75rem] gap-x-3 pr-3 pl-4 text-left hover:bg-accent focus-inset"
            >
              <span className="truncate text-body">{stepInstruction(step)}</span>
              <span className="flex">
                <SchoolBadge school={step.school} />
              </span>
              <span className="truncate text-meta text-muted-foreground">{step.courseCode}</span>
              <span className="truncate text-meta @max-[560px]:hidden">
                <StatusPill tone={step.detailTone} label={step.detail} />
              </span>
              <OpensChevron />
            </StepAction>
          </li>
        ))}
      </ol>
    </section>
  );
}
