import { createFileRoute } from "@tanstack/react-router";

import { AnnouncementsScreen } from "~/renderer/components/screens/AnnouncementsScreen";
import type { LmsRef } from "~/shared/domain/ids";

const Screen = () => (
  <AnnouncementsScreen courseId={Route.useParams().courseId as LmsRef<"course">} />
);

export const Route = createFileRoute("/courses/$courseId/announcements")({ component: Screen });
