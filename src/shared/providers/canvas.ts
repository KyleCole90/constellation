import type { Capabilities, LmsProvider, ProviderDescriptor } from "./provider";

const MIN_TOKEN_LENGTH = 20;

/** Writes ship in step 12 (docs/electron-spec.md), so Canvas claims none of the write capabilities yet. */
const CAPABILITIES: Capabilities = {
  messaging: true,
  rubricWrite: false,
  attachments: false,
  excuse: false,
  commentEffect: "append",
};

const SCOPE_WORDS: Readonly<Record<string, string>> = {
  "url:GET|/api/v1/courses": "Read your courses, rosters, and submissions",
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
