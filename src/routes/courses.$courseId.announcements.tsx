import { createFileRoute } from "@tanstack/react-router";

import { AnnouncementsScreen } from "~/components/screens/AnnouncementsScreen";
import type { LmsRef } from "~/domain/ids";

const Screen = () => (
  <AnnouncementsScreen courseId={Route.useParams().courseId as LmsRef<"course">} />
);

export const Route = createFileRoute("/courses/$courseId/announcements")({ component: Screen });
