import { createFileRoute } from "@tanstack/react-router";

import { CourseRoute } from "~/renderer/components/screens/CourseHeader";
import { GradebookScreen } from "~/renderer/components/screens/GradebookScreen";

const Screen = () => (
  <CourseRoute courseId={Route.useParams().courseId}>
    {(courseId) => <GradebookScreen courseId={courseId} />}
  </CourseRoute>
);

export const Route = createFileRoute("/courses/$courseId/gradebook")({ component: Screen });
