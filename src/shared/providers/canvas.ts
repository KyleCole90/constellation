import type { Capabilities, LmsProvider, ProviderDescriptor } from "./provider";

const MIN_TOKEN_LENGTH = 20;

/** A draft's attachment is a name and a size, not a file, so Canvas takes no attachments until there is one to upload. */
const CAPABILITIES: Capabilities = {
  messaging: true,
  rubricWrite: true,
  attachments: false,
  excuse: true,
  commentEffect: "append",
};

const SCOPE_WORDS: Readonly<Record<string, string>> = {
  "url:GET|/api/v1/courses": "Read your courses, rosters, and submissions",
  "url:PUT|/api/v1/courses/:course_id/assignments/:assignment_id/submissions/:user_id":
    "Post grades and comments",
  "url:POST|/api/v1/conversations/:id/add_message": "Reply to messages",
  "url:POST|/api/v1/conversations": "Message students",
  "url:POST|/api/v1/courses/:course_id/discussion_topics": "Post announcements",
  "url:POST|/api/v1/courses/:course_id/content_migrations": "Copy content into a course",
  "url:GET|/api/v1/courses/:course_id/content_migrations": "Check on a copy",
  "url:GET|/api/v1/progress/:id": "Read how far a copy has gone",
  "url:GET|/api/v1/courses/:course_id/content_migrations/:id/migration_issues":
    "Read a copy's report",
  "url:PUT|/api/v1/courses/:id": "Publish a course and edit its syllabus",
  "url:PUT|/api/v1/courses/:course_id/pages/:url_or_id": "Edit pages",
  "url:PUT|/api/v1/courses/:course_id/assignments/:id": "Edit assignments",
  "url:PUT|/api/v1/courses/:course_id/discussion_topics/:topic_id": "Edit announcements",
  "url:DELETE|/api/v1/courses/:course_id/discussion_topics/:topic_id": "Delete an announcement",
  "url:PUT|/api/v1/files/:id": "Show files to students",
};
/** A personal access token carries all its owner's rights. These are the ones the app uses so far. */
export const CANVAS_SCOPES = Object.keys(SCOPE_WORDS);

/** What the app knows about real Canvas without asking it. Main runs the provider; the renderer shows this face. */
export const CANVAS_FACE = {
  vendorLabel: "Canvas",
  capabilities: CAPABILITIES,
  describeScope: (scope: string) => SCOPE_WORDS[scope] ?? scope,
} satisfies Pick<LmsProvider, "vendorLabel" | "capabilities" | "describeScope">;

/** Paste-token enrolment: a school's address and a personal access token (docs/electron-spec.md, D7). */
export const CANVAS: Omit<ProviderDescriptor, "create"> = {
  kind: "canvas",
  label: "Canvas",
  enrollment: {
    kind: "paste-token",
    fieldLabel: "Canvas access token",
    steps: [
      "In Canvas, open Account, then Settings.",
      "Under Approved Integrations, choose New Access Token.",
      'Give it a purpose such as "Constellation" and generate it.',
      "Copy the token and paste it here. It is shown once, and this app never displays it again.",
    ],
    validate: (raw) =>
      raw.trim().length < MIN_TOKEN_LENGTH
        ? `That does not look like a Canvas access token. Tokens are at least ${MIN_TOKEN_LENGTH} characters.`
        : null,
    addressPlaceholder: "school.instructure.com",
    tokenPageUrl: (host) => `https://${host}/profile/settings`,
  },
};
