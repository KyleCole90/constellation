import { createFileRoute } from "@tanstack/react-router";

import { GradebookScreen } from "~/components/screens/GradebookScreen";
import type { LmsRef } from "~/domain/ids";

const Screen = () => <GradebookScreen courseId={Route.useParams().courseId as LmsRef<"course">} />;

export const Route = createFileRoute("/courses/$courseId/gradebook")({ component: Screen });
