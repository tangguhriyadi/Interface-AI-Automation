import { matchesAnyShape } from "../adapter/matchers.js";
import type { Snapshot } from "../adapter/snapshotParser.js";
import type { SurfaceAdapter } from "../adapter/surfaceAdapter.js";
import type { AppProfile } from "../schema/appProfile.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type AppDetectionResult =
  | { kind: "settled"; snapshot: Snapshot; recoveriesFired: string[] }
  | { kind: "business_outcome"; outcome: string; recoveriesFired: string[] }
  | { kind: "session_expired"; recoveriesFired: string[] }
  | { kind: "recovery_exhausted"; ruleName: string; recoveriesFired: string[] }
  | { kind: "recovery_action_failed"; ruleName: string; recoveriesFired: string[] };

export interface AppDetector {
  /**
   * Detects and resolves app-level conditions at one transition: session
   * expiry, a declared business outcome, or a recoverable interstitial —
   * dismissed in a bounded loop, re-snapshotting after each dismiss, and
   * never surfaced to a caller as a step/action of its own. Returns
   * `settled` with the final (possibly recovery-advanced) snapshot once
   * nothing more applies. `businessOutcomeNames` narrows which app-profile
   * outcomes to check for — a replay checks only the ones its capability
   * declared plausible; discovery, with no capability yet, checks every
   * outcome the app profile declares.
   */
  detect(snapshot: Snapshot, businessOutcomeNames: readonly string[], hasLeftEntryPoint: boolean): Promise<AppDetectionResult>;
}

const DEFAULT_RECOVERY_LIMIT_PER_RULE = 3;
const DEFAULT_RECOVERY_LIMIT_OVERALL = 10;
/** Pure safety net — the recovery limits above should always trip first. */
const MAX_DETECTION_ITERATIONS = 50;

/**
 * Shared by `replay()` and `discover()` — this app-level detection
 * (session-expiry/business-outcome/recovery, all human-authored per-appId
 * knowledge in schema/appProfile.ts) is exactly the kind of thing this
 * project's standing rule says gets one implementation, not two that could
 * drift (adapter/matchers.ts's shared checkpoint/outcome tree-walker;
 * executor/policy.ts's shared allowlist/irreversible-control checks — same
 * reasoning here). Counters for the bounded recovery loop live in the
 * returned closure, persisting across repeated `detect()` calls for one run.
 */
export function createAppDetector(
  appProfile: AppProfile,
  adapter: SurfaceAdapter,
  recoveryLimits?: { perRule?: number; overall?: number },
): AppDetector {
  const perRuleLimit = recoveryLimits?.perRule ?? DEFAULT_RECOVERY_LIMIT_PER_RULE;
  const overallLimit = recoveryLimits?.overall ?? DEFAULT_RECOVERY_LIMIT_OVERALL;
  const recoveryFireCounts = new Map<string, number>();
  let overallRecoveryCount = 0;

  return {
    async detect(initialSnapshot, businessOutcomeNames, hasLeftEntryPoint) {
      let snapshot = initialSnapshot;
      const recoveriesFired: string[] = [];

      for (let iteration = 0; iteration < MAX_DETECTION_ITERATIONS; iteration++) {
        // Detected the same way as any outcome/recovery — an app-level detector shape,
        // never inferred from entryPoint (see the AppProfileSchema comment on
        // sessionExpiry). `hasLeftEntryPoint` stays a false-positive guard, not the
        // primary signal, and is the caller's responsibility to compute — it depends
        // on the capability's/goal's own entryPoint, which this module doesn't know.
        if (hasLeftEntryPoint && appProfile.sessionExpiry && matchesAnyShape(appProfile.sessionExpiry, snapshot)) {
          return { kind: "session_expired", recoveriesFired };
        }

        for (const outcomeName of businessOutcomeNames) {
          const detector = appProfile.outcomes[outcomeName];
          if (detector && matchesAnyShape(detector.shapes, snapshot)) {
            return { kind: "business_outcome", outcome: outcomeName, recoveriesFired };
          }
        }

        let recovered = false;
        for (const rule of appProfile.recoveries) {
          if (!matchesAnyShape(rule.detect, snapshot)) {
            continue;
          }
          const ruleCount = (recoveryFireCounts.get(rule.name) ?? 0) + 1;
          recoveryFireCounts.set(rule.name, ruleCount);
          overallRecoveryCount += 1;

          if (ruleCount > perRuleLimit || overallRecoveryCount > overallLimit) {
            return { kind: "recovery_exhausted", ruleName: rule.name, recoveriesFired };
          }

          try {
            if (rule.action.kind === "dismiss") {
              await adapter.click(rule.action.locator);
            } else {
              await sleep(rule.action.timeoutMs);
            }
          } catch {
            return { kind: "recovery_action_failed", ruleName: rule.name, recoveriesFired };
          }
          recoveriesFired.push(rule.name);
          recovered = true;
          break;
        }

        if (!recovered) {
          return { kind: "settled", snapshot, recoveriesFired };
        }
        snapshot = await adapter.snapshot();
      }

      throw new Error("internal: app-condition detection exceeded its safety iteration cap");
    },
  };
}
