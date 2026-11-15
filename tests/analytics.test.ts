import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import { AnalyticsEventSchema, type AnalyticsEvent } from "../src/shared/analytics";

import { telemetryMain } from "./fixtures/telemetry-main";

/** What a teacher's Mac holds and PostHog must never see (issue #3, Never sent). */
const PLANTED = {
  name: "Maria Garcia",
  id: "student-48213",
  email: "maria.garcia@lakeshore.edu",
  grade: "B+ 87/100",
  comment: "Great thesis, Maria, but cite your sources",
  url: "https://lakeshore.instructure.com/courses/12/users/34",
  token: "7~SENTINELtokenAbCdEfGhIjKlMnOpQrStUvWxYz",
};
const STRINGS = Object.values(PLANTED);

/** One of each event the app sends. */
const VALID: readonly AnalyticsEvent[] = [
  { event: "app_opened" },
  { event: "onboarding_step_completed", step: "welcome", ai_source: "none" },
  { event: "onboarding_step_completed", step: "setup", ai_source: "claude-code" },
  { event: "onboarding_finished" },
  { event: "ai_source_changed", from: "none", to: "key" },
  { event: "draft_requested", kind: "message" },
  { event: "draft_outcome", kind: "grade", outcome: "edited" },
  { event: "grade_posted", count: 3 },
];

/** Each valid event with student data riding along, and each slot given student data in place of its value. */
const planted = (): unknown[] =>
  VALID.flatMap((event) => [
    ...STRINGS.map((value) => ({ ...event, student: value })),
    { ...event, $set: { name: PLANTED.name, email: PLANTED.email } },
    { ...event, properties: { url: PLANTED.url } },
    ...Object.keys(event).flatMap((slot) =>
      [...STRINGS, 87.5, -1, { name: PLANTED.name }].map((value) => ({ ...event, [slot]: value })),
    ),
  ]);

describe("usage events never carry student data", () => {
  it("main rejects every event carrying anything but fixed words and counts, and sends only the valid ones", async () => {
    const main = telemetryMain();
    const attempts = planted();
    expect(attempts.length).toBeGreaterThan(200);
    for (const attempt of attempts)
      await expect(main.call("analytics.track", attempt)).rejects.toThrow();
    for (const event of VALID) await main.call("analytics.track", event);
    for (const value of STRINGS)
      await main.call("error.report", {
        type: "TypeError",
        stack: `\n    at ${PLANTED.name} (${PLANTED.url}?access_token=${PLANTED.token}:1:1)\n    at grade (/Users/mgarcia/${value}:2:2)`,
      });
    await main.telemetry.flush();
    await main.telemetry.flush();

    const bodies = main.sent.join("\n");
    for (const value of [...STRINGS, "lakeshore", "SENTINEL", "Maria", "mgarcia", "student-"])
      expect(bodies).not.toContain(value);
    const sent = main.sent.flatMap((body): unknown[] => {
      const parsed: unknown = JSON.parse(body);
      return v.parse(v.object({ batch: v.array(v.unknown()) }), parsed).batch;
    });
    expect(
      sent.filter((event) => v.is(v.object({ event: v.literal("$exception") }), event)),
    ).toHaveLength(STRINGS.length);
    expect(
      sent.flatMap((event) => {
        const parsed = v.safeParse(
          v.object({ event: v.string(), properties: v.record(v.string(), v.unknown()) }),
          event,
        );
        if (!parsed.success || parsed.output.event === "$exception") return [];
        const { $lib, $lib_version, $process_person_profile, $geoip_disable, ...properties } =
          parsed.output.properties;
        expect([$lib, $process_person_profile, $geoip_disable]).toEqual([
          "constellation-desktop",
          false,
          true,
        ]);
        expect($lib_version).toBe("0.0.1");
        return [{ event: parsed.output.event, ...properties }];
      }),
    ).toEqual(VALID);
  });

  it("main drops an event its own code builds with more than the schema allows", async () => {
    const main = telemetryMain();
    // Not an object literal, so the compiler lets the extra property through. The schema doesn't.
    const spread = { event: "app_opened" as const, student: PLANTED.name };
    main.telemetry.track(spread);
    await main.telemetry.flush();
    expect(main.sent).toEqual([]);
  });

  it("fail to compile with an extra property, a misspelled event or a free string, and fail to parse too", () => {
    const wrong = [
      // @ts-expect-error an event names only its own properties
      { event: "draft_requested", kind: "grade", student: PLANTED.name },
      // @ts-expect-error no such event
      { event: "draft_requsted", kind: "grade" },
      // @ts-expect-error a kind is one of four words, never free text
      { event: "draft_requested", kind: PLANTED.name },
    ] satisfies AnalyticsEvent[];
    for (const event of wrong) expect(v.is(AnalyticsEventSchema, event)).toBe(false);
  });
});
