import { createFileRoute } from "@tanstack/react-router";

import { AnnouncementsScreen } from "~/renderer/components/screens/AnnouncementsScreen";
import { CourseRoute } from "~/renderer/components/screens/CourseHeader";

const Screen = () => (
  <CourseRoute courseId={Route.useParams().courseId}>
    {(courseId) => <AnnouncementsScreen courseId={courseId} />}
  </CourseRoute>
);

export const Route = createFileRoute("/courses/$courseId/announcements")({ component: Screen });
