import type { IsoTime, ThreadId } from "~/shared/domain/ids";

import { GRADING_LIST_THREAD, INBOX_THREAD, NORTH_STAR_THREAD } from "./selectors";
import type { Thread } from "./types";

/** The threads every workspace has, demo or not. Routes and links point at them, so none may be missing. */
export const builtInThreads = (at: IsoTime): Readonly<Record<ThreadId, Thread>> => {
  const thread = (
    id: ThreadId,
    kind: "north-star" | "queue" | "messages",
    title: string,
  ): Thread => ({
    id,
    school: null,
    course: null,
    kind,
    title,
    focus: null,
    updatedAt: at,
    messages: [],
  });
  return {
    [NORTH_STAR_THREAD]: thread(NORTH_STAR_THREAD, "north-star", "North Star"),
    [GRADING_LIST_THREAD]: thread(GRADING_LIST_THREAD, "queue", "Grading list"),
    [INBOX_THREAD]: thread(INBOX_THREAD, "messages", "Messages"),
  };
};
