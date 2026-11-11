import { Link } from "@tanstack/react-router";

import { sittingsOf, stepInstruction } from "../screens/due.logic";
import { StepAction } from "../screens/StepAction";
import { usePlan } from "../screens/usePlan";
import { cn } from "~/renderer/lib/utils";

import { buttonVariants } from "../ui/button";
import { Kbd } from "../ui/kbd";

/** The receipt's way on once its queue is clear: the step What's due would put first, or What's due itself when nothing is left. */
export function AfterQueue({ describedBy }: { describedBy: string }) {
  const step = sittingsOf(usePlan("all"))[0]?.steps[0];
  const look = cn(buttonVariants({ variant: "default", size: "md" }), "ml-auto min-w-0 shrink");
  if (!step)
    return (
      <Link to="/due" data-card-primary aria-describedby={describedBy} className={look}>
        Back to What's due
        <Kbd variant="on-primary">⌘↵</Kbd>
      </Link>
    );
  const label = `Next${step.courseCode ? ` in ${step.courseCode}` : ""}: ${stepInstruction(step)}`;
  return (
    <StepAction
      step={step}
      slot="button"
      data-card-primary
      aria-describedby={describedBy}
      className={look}
    >
      <span title={label} className="truncate">
        {label}
      </span>
      <Kbd variant="on-primary">⌘↵</Kbd>
    </StepAction>
  );
}
