import { z } from "zod";
import { FrameRefSchema } from "./frame.js";
import { LocatorChainSchema } from "./locator.js";

/**
 * One recognizable "shape" a business outcome or recovery condition can
 * take on a page — e.g. a full page titled "Invalid Input" vs an inline
 * alert on the search page render as two different shapes of the same
 * outcome (CLAUDE.md's own example). A shape is an AND of whichever signals
 * it declares; at least one is required, and `roleAlertContains` is always
 * optional even when present, since real legacy apps often render errors as
 * plain text with no `role="alert"` at all. Shared verbatim by outcomes and
 * recoveries so there is exactly one shape-matching implementation, not two
 * that could drift (design decision 6).
 */
export const DetectorShapeSchema = z
  .object({
    frame: FrameRefSchema.optional(),
    headingEquals: z.string().min(1).optional(),
    headingStartsWith: z.string().min(1).optional(),
    textContains: z.string().min(1).optional(),
    roleAlertContains: z.string().min(1).optional(),
  })
  .refine(
    (shape) =>
      shape.headingEquals !== undefined ||
      shape.headingStartsWith !== undefined ||
      shape.textContains !== undefined ||
      shape.roleAlertContains !== undefined,
    {
      message:
        "A detector shape must declare at least one signal (headingEquals, headingStartsWith, textContains, or roleAlertContains).",
    },
  );
export type DetectorShape = z.infer<typeof DetectorShapeSchema>;

export const OutcomeDetectorSchema = z.object({
  name: z.string().min(1),
  shapes: z.array(DetectorShapeSchema).min(1),
});
export type OutcomeDetector = z.infer<typeof OutcomeDetectorSchema>;

export const RecoveryActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dismiss"), locator: LocatorChainSchema }),
  /**
   * For a recovery condition with a genuinely detectable "still in
   * progress" page state (a spinner, a "Loading..." message) that the
   * `detect` shapes below can match — wait up to `timeoutMs` for it to
   * clear on its own, no dismiss action needed. This is NOT the mechanism
   * for a response that's simply slow with no visible interim state (see
   * the comment on `timeoutMs` in step.ts) — that case has nothing for
   * `detect` to match against and belongs on the step itself instead.
   */
  z.object({ kind: z.literal("wait"), timeoutMs: z.number().int().positive() }),
]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

/** Recovery rules are global and checked at every transition — an interstitial can appear anywhere. */
export const RecoveryRuleSchema = z.object({
  name: z.string().min(1),
  detect: z.array(DetectorShapeSchema).min(1),
  action: RecoveryActionSchema,
});
export type RecoveryRule = z.infer<typeof RecoveryRuleSchema>;

export const AllowlistSchema = z.object({
  originPattern: z.string().min(1),
  routePrefixes: z.array(z.string().min(1)).min(1),
});
export type Allowlist = z.infer<typeof AllowlistSchema>;

/**
 * Business-outcome detectors and recovery rules are properties of the app,
 * not of one capability — authored and reviewed by a human, per appId.
 */
export const AppProfileSchema = z.object({
  schemaVersion: z.string().min(1),
  appId: z.string().min(1),
  outcomes: z.record(z.string(), OutcomeDetectorSchema),
  recoveries: z.array(RecoveryRuleSchema).default([]),
  /**
   * How this app signals an expired session — an app-level property, same
   * as outcomes and recoveries, matched the same way (shapes OR'd
   * together). Deliberately NOT inferred from a capability's `entryPoint`:
   * that only works by coincidence when entryPoint happens to be the login
   * page, and a capability starting anywhere else (e.g. "/search") would
   * never detect an expiry redirect at all. Optional because not every app
   * has sessions; when absent, the executor simply never detects expiry
   * structurally (an unexplained state still surfaces as some other error).
   */
  sessionExpiry: z.array(DetectorShapeSchema).min(1).optional(),
  allowlist: AllowlistSchema,
});
export type AppProfile = z.infer<typeof AppProfileSchema>;
