import { createFileRoute } from "@tanstack/react-router";

import { CourseOverviewScreen } from "~/renderer/components/screens/CourseOverviewScreen";
import type { LmsRef } from "~/shared/domain/ids";

const Screen = () => (
  <CourseOverviewScreen courseId={Route.useParams().courseId as LmsRef<"course">} />
);

export const Route = createFileRoute("/courses/$courseId/")({ component: Screen });
