import { Link } from "@tanstack/react-router";

import type { SchoolGap } from "~/stores/selectors";

import { EmptyState } from "../EmptyState";
import { buttonVariants } from "../ui/button";

const WORDS: Readonly<Record<SchoolGap, string>> = {
  none: "Add a school to see its work here.",
  disconnected: "Every school is disconnected. Reconnect one to see its work here.",
};

export function NoSchool({ gap }: { gap: SchoolGap }) {
  return (
    <div data-testid="no-school" data-gap={gap} className="flex min-h-0 flex-1 flex-col">
      <EmptyState title={WORDS[gap]}>
        <Link to="/settings" data-slot="button" className={buttonVariants({ size: "sm" })}>
          Open Connections
        </Link>
      </EmptyState>
    </div>
  );
}
