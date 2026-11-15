import * as v from "valibot";

/**
 * Every usage event the desktop app may send, and every property each may carry (issue #3). Values are only fixed
 * words and counts: every free string in this app could be a student's, so none has a slot here. Strict, so an event
 * carrying anything more is rejected rather than trimmed.
 */
const AiSourceSchema = v.picklist(["none", "key", "on-device", "claude-code"]);
const DraftKindSchema = v.picklist(["grade", "reply", "announcement", "message"]);
export type DraftKind = v.InferOutput<typeof DraftKindSchema>;

export const AnalyticsEventSchema = v.variant("event", [
  v.strictObject({ event: v.literal("app_opened") }),
  v.strictObject({
    event: v.literal("onboarding_step_completed"),
    step: v.picklist(["welcome", "setup"]),
    ai_source: AiSourceSchema,
  }),
  v.strictObject({ event: v.literal("onboarding_finished") }),
  v.strictObject({
    event: v.literal("ai_source_changed"),
    from: AiSourceSchema,
    to: AiSourceSchema,
  }),
  v.strictObject({ event: v.literal("draft_requested"), kind: DraftKindSchema }),
  v.strictObject({
    event: v.literal("draft_outcome"),
    kind: DraftKindSchema,
    outcome: v.picklist(["accepted", "edited", "discarded", "invalid", "limited"]),
  }),
  v.strictObject({
    event: v.literal("grade_posted"),
    count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000)),
  }),
]);
export type AnalyticsEvent = v.InferOutput<typeof AnalyticsEventSchema>;
