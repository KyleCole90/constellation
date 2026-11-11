import { ChevronRight } from "lucide-react";

/** The trailing mark on a row that opens another screen. A row that expands in place leads with its own chevron, which turns as it opens. */
export function OpensChevron() {
  return <ChevronRight aria-hidden className="size-3 flex-none text-muted-foreground" />;
}
