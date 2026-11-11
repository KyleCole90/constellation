import * as v from "valibot";

import {
  FieldKeySchema,
  FieldKeysSchema,
  IsoTimeSchema,
  LmsErrorSchema,
  SchoolIdSchema,
  lmsRef,
} from "../schemas";

import {
  DEMO_FAULTS,
  type ArmedFaults,
  type DemoFault,
  type FaultLab,
  type NoiseConfig,
  type WriteRecord,
} from "./faults";

const count = v.number();
const LatencySchema: v.GenericSchema<NoiseConfig["latencyMs"]> = v.tuple([count, count]);

const NoiseSchema: v.GenericSchema<NoiseConfig> = v.object({
  rate429: count,
  rate5xx: count,
  rateLost: count,
  latencyMs: LatencySchema,
});

/**
 * Everything the failure lab can see, as main sends it to the renderer whenever it moves. The Settings screen reads it
 * synchronously, so the renderer keeps the latest one.
 */
export interface LabSnapshot {
  noise: NoiseConfig;
  defaultNoise: NoiseConfig;
  demoScript: { enabled: boolean; fired: readonly DemoFault[] };
  armed: ArmedFaults;
  writes: readonly WriteRecord[];
}

export const LabSnapshotSchema: v.GenericSchema<LabSnapshot> = v.object({
  noise: NoiseSchema,
  defaultNoise: NoiseSchema,
  demoScript: v.object({ enabled: v.boolean(), fired: v.array(v.picklist(DEMO_FAULTS)) }),
  armed: v.object({ failedFields: FieldKeysSchema, lostResponses: count, throttles: count }),
  writes: v.array(
    v.object({
      at: IsoTimeSchema,
      school: SchoolIdSchema,
      target: v.string(),
      fields: FieldKeysSchema,
    }),
  ),
});

export const labSnapshot = (lab: FaultLab): LabSnapshot => ({
  noise: lab.noise(),
  defaultNoise: lab.defaultNoise(),
  demoScript: lab.demoScript(),
  armed: lab.armed(),
  writes: lab.writes(),
});

/**
 * One FaultLab call, plus the controls only a fake LMS in another process needs: its reset, its clock, and a reload,
 * which starts it over from storage the way a page reload does in the web demo, so faults armed but not fired are gone.
 */
export const LabCommandSchema = v.variant("do", [
  v.object({
    do: v.literal("setNoise"),
    patch: v.object({
      rate429: v.exactOptional(count),
      rate5xx: v.exactOptional(count),
      rateLost: v.exactOptional(count),
      latencyMs: v.exactOptional(LatencySchema),
    }),
  }),
  v.object({ do: v.literal("resetNoise") }),
  v.object({ do: v.literal("expireToken"), school: SchoolIdSchema }),
  v.object({
    do: v.literal("changeGradeOutOfBand"),
    submission: lmsRef<"submission">(),
    newGrade: count,
    by: v.string(),
  }),
  v.object({ do: v.literal("studentResubmits"), submission: lmsRef<"submission">() }),
  v.object({ do: v.literal("failNextWrite"), field: FieldKeySchema, error: LmsErrorSchema }),
  v.object({ do: v.literal("loseNextResponse"), applied: v.boolean() }),
  v.object({ do: v.literal("lateLanding"), delayMs: count }),
  v.object({
    do: v.literal("throttleNext"),
    retryAfterMs: count,
    on: v.picklist(["any", "write"]),
  }),
  v.object({ do: v.literal("holdReads"), held: v.boolean() }),
  v.object({ do: v.literal("holdWrites"), held: v.boolean() }),
  v.object({
    do: v.literal("failNextMigration"),
    stage: v.picklist(["pre_processing", "running"]),
    message: v.string(),
  }),
  v.object({ do: v.literal("enrollStudents"), course: lmsRef<"course">(), count }),
  v.object({ do: v.literal("setDemoScript"), enabled: v.boolean() }),
  v.object({ do: v.literal("reset") }),
  v.object({ do: v.literal("reload") }),
  /** The demo clock's lead over real time, since the app's clock decides what time the fake LMS thinks it is. */
  v.object({ do: v.literal("clock"), offsetMs: count }),
]);
export type LabCommand = v.InferOutput<typeof LabCommandSchema>;
