import { createFileRoute } from "@tanstack/react-router";

import { CalendarScreen } from "~/components/screens/CalendarScreen";
import { parseCalendarSearch } from "~/components/screens/calendar.logic";

export const Route = createFileRoute("/calendar")({
  validateSearch: parseCalendarSearch,
  component: CalendarScreen,
});
