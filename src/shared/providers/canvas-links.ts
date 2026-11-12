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

/** Canvas's editor writes links into the same course without the origin, so a bare `/courses/...` path is this host. */
const COURSE_PATH =
  /^(?:https?:\/\/([^/]+))?\/courses\/(\d+)\/(pages|files|external_tools|assignments|discussion_topics|modules)\/([^/?#]+)/;

/**
 * Canvas's URL grammar, read here and nowhere above. Same host and this course: a page or file is checked against what
 * the course holds, and a tool link stays a tool link for the scan to check against configured tools. Another course
 * gets a replacement only when it is on the same host and the same page exists here. Anything else is the open web.
 */
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
    return { ...link, points: "tool", tool: refs.tool(ctx.school, ctx.courseId, Number(slug)) };
  return { ...link, points: "this-course" };
};
