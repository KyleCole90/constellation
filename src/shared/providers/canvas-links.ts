import type { ContentLink } from "~/shared/domain/content";
import type { SchoolId } from "~/shared/domain/ids";

import { refs } from "./canvas-refs";

export interface LinkContext {
  school: SchoolId;
  host: string;
  courseId: number;
  pages: ReadonlySet<string>;
  files: ReadonlySet<number>;
}

const COURSE_PATH =
  /^(?:https?:\/\/([^/]+))?\/courses\/(\d+)\/(pages|files|external_tools|assignments|discussion_topics|modules)\/([^/?#]+)/;

export const classifyLink = (
  link: { text: string; url: string },
  ctx: LinkContext,
): ContentLink => {
  const match = COURSE_PATH.exec(link.url);
  if (!match) return { ...link, points: "web" };
  const [, host = ctx.host, courseId, kind, slug] = match;
  if (host !== ctx.host || Number(courseId) !== ctx.courseId) {
    const replacement =
      host === ctx.host && kind === "pages" && slug !== undefined && ctx.pages.has(slug)
        ? link.url.replace(`/courses/${courseId}/`, `/courses/${ctx.courseId}/`)
        : null;
    return { ...link, points: "other-course", replacement };
  }
  if (kind === "pages")
    return {
      ...link,
      points: slug !== undefined && ctx.pages.has(slug) ? "this-course" : "missing-page",
    };
  if (kind === "files")
    return { ...link, points: ctx.files.has(Number(slug)) ? "this-course" : "missing-file" };
  if (kind === "external_tools")
    return {
      ...link,
      points: "tool",
      tool: refs.tool({ school: ctx.school, course: ctx.courseId, tool: Number(slug) }),
    };
  return { ...link, points: "this-course" };
};
