import { createFileRoute } from "@tanstack/react-router";

import { GradebookScreen } from "~/renderer/components/screens/GradebookScreen";
import type { LmsRef } from "~/shared/domain/ids";

const Screen = () => <GradebookScreen courseId={Route.useParams().courseId as LmsRef<"course">} />;

export const Route = createFileRoute("/courses/$courseId/gradebook")({ component: Screen });
