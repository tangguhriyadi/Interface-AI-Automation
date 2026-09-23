import { z } from "zod";
import { CheckpointSchema } from "./checkpoint.js";
import { StepSchema } from "./step.js";

export const InputSensitivitySchema = z.enum(["secret", "pii", "none"]);
export type InputSensitivity = z.infer<typeof InputSensitivitySchema>;

/**
 * Declared inputs carry a sensitivity flag from the start (see redact.ts in
 * the executor phase) — `secret`/`pii` values must never reach a log, a
 * step record, or a thrown error.
 */
export const InputSpecSchema = z.object({
  type: z.literal("string"),
  sensitivity: InputSensitivitySchema,
  description: z.string().min(1).optional(),
});
export type InputSpec = z.infer<typeof InputSpecSchema>;

export const OutputSpecSchema = z.object({
  type: z.literal("string"),
  description: z.string().min(1).optional(),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

const capabilityShape = {
  schemaVersion: z.string().min(1),
  capabilityId: z.string().min(1),
  version: z.string().min(1),
  appId: z.string().min(1),
  description: z.string().min(1).optional(),
  /**
   * A path (e.g. "/login"), resolved against the tenant overlay's baseUrl
   * at replay time. This is the artifact's only navigation entry — there is
   * deliberately no free "navigate" step kind in step.ts. Every other
   * transition happens by acting on the page (click/type/select), so the
   * allowlist's route prefixes bound everywhere the run can ever go; a
   * general navigate-to-arbitrary-path step would let an artifact step
   * around that boundary.
   */
  entryPoint: z.string().min(1),
  inputs: z.record(z.string(), InputSpecSchema),
  outputs: z.record(z.string(), OutputSpecSchema),
  steps: z.array(StepSchema).min(1),
  successCheckpoint: CheckpointSchema,
  businessOutcomes: z.array(z.string().min(1)).default([]),
};

export const CapabilityArtifactSchema = z.object(capabilityShape).superRefine((artifact, ctx) => {
  const inputNames = new Set(Object.keys(artifact.inputs));
  const outputNames = new Set(Object.keys(artifact.outputs));
  const writtenOutputs = new Set<string>();

  artifact.steps.forEach((step, index) => {
    if ((step.action === "type" || step.action === "select") && !inputNames.has(step.value.fromInput)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Step "${step.id}" (index ${index}) references undeclared input "${step.value.fromInput}".`,
        path: ["steps", index, "value", "fromInput"],
      });
    }
    if (step.action === "read") {
      if (!outputNames.has(step.outputName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step "${step.id}" (index ${index}) references undeclared output "${step.outputName}".`,
          path: ["steps", index, "outputName"],
        });
      } else {
        writtenOutputs.add(step.outputName);
      }
    }
  });

  for (const name of outputNames) {
    if (!writtenOutputs.has(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Declared output "${name}" is never written by any read step — a typo here would otherwise yield a "successful" replay with a missing output.`,
        path: ["outputs", name],
      });
    }
  }
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

/**
 * Builds the runtime validator for a replay call's actual `inputs` object,
 * from a capability's declared input specs. Deliberately permissive: every
 * declared input becomes a required `z.string()` and nothing more — no
 * regex, no length bound. Throwing here means "missing input" or "wrong JS
 * type," never "value the app itself should be allowed to reject" (see
 * design decision 7 — a malformed-but-well-typed memberId must reach the
 * browser so target-app's own Invalid Input / Member Not Found pages can be
 * exercised).
 */
export function buildInputsSchema(inputs: Record<string, InputSpec>): z.ZodObject<Record<string, z.ZodString>> {
  const shape: Record<string, z.ZodString> = {};
  for (const name of Object.keys(inputs)) {
    shape[name] = z.string();
  }
  return z.object(shape);
}
