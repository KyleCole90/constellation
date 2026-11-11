import { createFileRoute } from "@tanstack/react-router";

import { CourseOverviewScreen } from "~/components/screens/CourseOverviewScreen";
import type { LmsRef } from "~/domain/ids";

const Screen = () => (
  <CourseOverviewScreen courseId={Route.useParams().courseId as LmsRef<"course">} />
);

export const Route = createFileRoute("/courses/$courseId/")({ component: Screen });
