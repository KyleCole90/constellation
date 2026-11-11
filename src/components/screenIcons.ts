import { BookOpen, CalendarDays, ListChecks, MessageSquare, Settings, Star } from "lucide-react";

/** Each screen's icon, shared by its sidebar row and its header so the two always match. */
export const SCREEN_ICON = {
  northStar: Star,
  due: ListChecks,
  inbox: MessageSquare,
  calendar: CalendarDays,
  settings: Settings,
  course: BookOpen,
} as const;
