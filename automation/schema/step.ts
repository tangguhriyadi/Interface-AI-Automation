import { z } from "zod";
import { CheckpointSchema } from "./checkpoint.js";
import { FrameRefSchema } from "./frame.js";
import { LocatorChainSchema } from "./locator.js";

/**
 * A typed value always references a declared input by name — never a
 * literal. This is enforced structurally: there is no literal-value variant
 * in this schema, so a step can't bake in a runtime value even by mistake.
 */
export const InputValueRefSchema = z.object({
  fromInput: z.string().min(1),
});
export type InputValueRef = z.infer<typeof InputValueRefSchema>;

const baseStepFields = {
  id: z.string().min(1),
  classification: z.enum(["safe", "irreversible"]),
  frame: FrameRefSchema.optional(),
  /**
   * Per-step timeout override, in milliseconds. Exists specifically for
   * steps whose response time varies by the data they act on and has no
   * detectable in-page "loading" state for a recovery rule to match against
   * — target-app's slow-load member (10004) is exactly this: the response
   * just arrives late, with no spinner or interim page to detect. That case
   * belongs here, on the step that triggers the slow request, recorded by
   * whoever authored the artifact (discovery would have observed the delay
   * directly). It does NOT belong in the app profile's `wait` recovery
   * action (appProfile.ts) — that mechanism is for a genuinely detectable
   * "still loading" page state, which this scenario doesn't have. The
   * executor must read this field rather than hardcode a slow-scenario
   * constant of its own; when absent, it falls back to the adapter's own
   * generic default timeout, not to any capability-specific number.
   */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * An optional condition verified right after this specific step's own
   * transition, independent of the capability's overall `successCheckpoint`
   * (which is only ever checked on the final step). Exists because a
   * mid-flow step landing on the wrong page — one that happens to
   * incidentally satisfy the final checkpoint too — would otherwise go
   * undetected until the end, or not at all. Same `Checkpoint` shape as
   * `successCheckpoint`; evaluated by the same `evaluateCheckpoint`.
   */
  checkpoint: CheckpointSchema.optional(),
};

export const ClickStepSchema = z.object({
  ...baseStepFields,
  action: z.literal("click"),
  target: LocatorChainSchema,
});

export const TypeStepSchema = z.object({
  ...baseStepFields,
  action: z.literal("type"),
  target: LocatorChainSchema,
  value: InputValueRefSchema,
});

export const SelectStepSchema = z.object({
  ...baseStepFields,
  action: z.literal("select"),
  target: LocatorChainSchema,
  value: InputValueRefSchema,
});

/** Reads a value into a declared output by name. */
export const ReadStepSchema = z.object({
  ...baseStepFields,
  action: z.literal("read"),
  target: LocatorChainSchema,
  outputName: z.string().min(1),
});

export const StepSchema = z.discriminatedUnion("action", [
  ClickStepSchema,
  TypeStepSchema,
  SelectStepSchema,
  ReadStepSchema,
]);
export type Step = z.infer<typeof StepSchema>;
