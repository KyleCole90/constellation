import { createFileRoute } from "@tanstack/react-router";

import { CourseRoute } from "~/renderer/components/screens/CourseHeader";
import { CourseOverviewScreen } from "~/renderer/components/screens/CourseOverviewScreen";

const Screen = () => (
  <CourseRoute courseId={Route.useParams().courseId}>
    {(courseId) => <CourseOverviewScreen courseId={courseId} />}
  </CourseRoute>
);

export const Route = createFileRoute("/courses/$courseId/")({ component: Screen });
