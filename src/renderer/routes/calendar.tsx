import { createFileRoute } from "@tanstack/react-router";

import { CalendarScreen } from "~/renderer/components/screens/CalendarScreen";
import { parseCalendarSearch } from "~/renderer/components/screens/calendar.logic";

export const Route = createFileRoute("/calendar")({
  validateSearch: parseCalendarSearch,
  component: CalendarScreen,
});
