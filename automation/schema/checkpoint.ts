import { z } from "zod";
import { FrameRefSchema } from "./frame.js";

/**
 * Checkpoints are conditions, not text snapshots — CLAUDE.md's artifact
 * rules explicitly forbid a literal full-text checkpoint (it breaks
 * parameterisation and persists PII). `frame` names the frame the way a
 * human would (see frame.ts); omitted means the main frame.
 */
export const HeadingStartsWithCheckpointSchema = z.object({
  kind: z.literal("heading_starts_with"),
  text: z.string().min(1),
  frame: FrameRefSchema.optional(),
});

export const FramePresentCheckpointSchema = z.object({
  kind: z.literal("frame_present"),
  frame: FrameRefSchema,
});

export const TextContainsCheckpointSchema = z.object({
  kind: z.literal("text_contains"),
  text: z.string().min(1),
  frame: FrameRefSchema.optional(),
});

export const CheckpointSchema = z.discriminatedUnion("kind", [
  HeadingStartsWithCheckpointSchema,
  FramePresentCheckpointSchema,
  TextContainsCheckpointSchema,
]);
export type Checkpoint = z.infer<typeof CheckpointSchema>;
