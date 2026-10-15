import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

/** Persisted immediately after the initiating entry, before any steering can arrive. */
export const turnStartEntryType = "agents-in-the-cloud.turn-start";
export const turnStartValidator = Compile(Type.Object({ turnEntryId: Type.String(), startedAt: Type.Number() }));

export const turnTimingEntryType = "agents-in-the-cloud.turn-timing";
const turnTimingSchema = Type.Object({
  elapsedMs: Type.Number({ minimum: 0 }),
  toolMs: Type.Number({ minimum: 0 }),
  inferenceMs: Type.Number({ minimum: 0 }),
  outputTokens: Type.Number({ minimum: 0 }),
  usageComplete: Type.Boolean(),
});
export type TurnTimingSummary = Static<typeof turnTimingSchema>;

/** Identity/outcome are optional only to read sessions persisted before turn subscriptions. */
export const turnTimingRecordValidator = Compile(Type.Object({
  ...turnTimingSchema.properties,
  turnEntryId: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("stopped")])),
}));
