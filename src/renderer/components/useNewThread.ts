import { useNavigate } from "@tanstack/react-router";

import type { Course } from "~/shared/domain/lms";
import { useAiOn, workspaceStore } from "~/renderer/stores/workspace";

export const useNewThread = () => {
  const navigate = useNavigate();
  const ai = useAiOn();
  if (!ai) return null;
  return (course: Course) => {
    const id = workspaceStore()
      .getState()
      .createThread({
        kind: "general",
        school: course.school,
        course: course.ref,
        title: `New thread in ${course.code}`,
      });
    void navigate({ to: "/threads/$threadId", params: { threadId: id } });
  };
};
