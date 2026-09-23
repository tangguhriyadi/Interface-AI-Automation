import { evaluateCheckpoint, headingText, matchesAnyShape } from "../adapter/matchers.js";
import { LocatorResolutionError, type SurfaceAdapter } from "../adapter/surfaceAdapter.js";
import type { Snapshot } from "../adapter/snapshotParser.js";
import type { AppProfile } from "../schema/appProfile.js";
import { buildInputsSchema, type CapabilityArtifact } from "../schema/capability.js";
import type { Checkpoint } from "../schema/checkpoint.js";
import type { LocatorChain, LocatorStrategy } from "../schema/locator.js";
import type { Step } from "../schema/step.js";
import type { TenantOverlay } from "../schema/tenantOverlay.js";
import { redactForLog } from "./redact.js";

/** Raw page content (headings, alert text) is treated as PII by default in diagnostics — it's never quoted verbatim, since headings can carry a member's name. */
function redactPageText(text: string): string {
  return redactForLog(text, "pii");
}

/**
 * A debuggable "observed" string for a failed checkpoint — what was actually
 * on the page, not just "condition not met". Raw text goes through
 * `redactPageText`; frame ids are structural (not page content) and safe as-is.
 */
function describeCheckpointMiss(checkpoint: Checkpoint, snapshot: Snapshot): string {
  switch (checkpoint.kind) {
    case "heading_starts_with": {
      const heading = headingText(snapshot, checkpoint.frame);
      return heading !== undefined
        ? `a heading was present but did not start with "${checkpoint.text}" (heading: ${redactPageText(heading)})`
        : "no heading was present";
    }
    case "frame_present": {
      const frameIds = snapshot.frames.map((f) => f.frameId).join(", ") || "none";
      return `frame not present (frames seen: ${frameIds})`;
    }
    case "text_contains":
      return `expected text "${checkpoint.text}" was not found anywhere in visible text`;
  }
}

export type ErrorClass =
  | "allowlist_violation"
  | "http_error"
  | "session_expired"
  | "locator_not_found"
  | "checkpoint_not_met"
  | "recovery_exhausted"
  | "recovery_action_failed";

export type StepOutcome = "ok" | "failed" | "skipped";

export interface StepRecord {
  stepId: string;
  action: Step["action"];
  matchedStrategy?: LocatorStrategy["kind"];
  outcome: StepOutcome;
  durationMs: number;
  recoveriesFired: string[];
  /** Only for type/select steps; always passed through redactForLog first, per the input's sensitivity. */
  attemptedValue?: string;
  /** Only for read steps; always passed through redactForLog first, per the output's sensitivity. Unrelated to the unredacted value returned in a success result's `outputs`. */
  observedValue?: string;
  /** Only present for steps classified irreversible. */
  irreversibleExecutionAuthorized?: boolean;
}

interface ReplayResultCommon {
  steps: StepRecord[];
  recoveries: string[];
}

/** The status-specific fields only — `ReplayResultCommon` (steps/recoveries) is added separately by `finalize`. */
type ResultShape =
  | { status: "success"; outputs: Record<string, string> }
  | { status: "business_outcome"; outcome: string }
  | { status: "escalated"; reason: string }
  | {
      status: "failed";
      stepId: string;
      locatorUsed?: LocatorChain;
      expected: string;
      observed: string;
      errorClass: ErrorClass;
    };

// `Omit`/intersection do not distribute over a union on their own; this conditional-type
// trick forces per-variant distribution so each status keeps only its own fields.
type AddCommon<T> = T extends unknown ? T & ReplayResultCommon : never;
export type ReplayResult = AddCommon<ResultShape>;

export interface ReplayOptions {
  tenantOverlay?: TenantOverlay;
  /** Default false. Discovery never sets this — only replay, and only when the caller has actually authorised it. */
  allowIrreversible?: boolean;
  recoveryLimits?: { perRule?: number; overall?: number };
}

type TerminalOutcome = Exclude<ResultShape, { status: "success" }>;

const DEFAULT_RECOVERY_LIMIT_PER_RULE = 3;
const DEFAULT_RECOVERY_LIMIT_OVERALL = 10;
/** Pure safety net — the recovery limits above should always trip first. */
const MAX_TRANSITION_ITERATIONS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Translates a locator chain's control names through the tenant overlay
 * before it ever reaches the adapter — e.g. a chain recorded against the
 * default tenant's "Member ID" label resolves correctly against the beta
 * tenant's "Account Number" rendering. CSS/XPath strategies are untouched;
 * they're raw selectors, not control names.
 */
function translateLocatorChain(chain: LocatorChain, overlay: TenantOverlay | undefined): LocatorChain {
  if (!overlay) {
    return chain;
  }
  return chain.map((strategy) => {
    if (strategy.kind === "role" && strategy.name in overlay.controlNameOverrides) {
      return { ...strategy, name: overlay.controlNameOverrides[strategy.name]! };
    }
    if (strategy.kind === "label" && strategy.text in overlay.controlNameOverrides) {
      return { ...strategy, text: overlay.controlNameOverrides[strategy.text]! };
    }
    if (strategy.kind === "structural" && strategy.rowHeader in overlay.controlNameOverrides) {
      return { ...strategy, rowHeader: overlay.controlNameOverrides[strategy.rowHeader]! };
    }
    return strategy;
  });
}

function isWithinAllowlist(allowlist: AppProfile["allowlist"], url: string): boolean {
  if (!url.startsWith(allowlist.originPattern)) {
    return false;
  }
  const pathname = new URL(url).pathname;
  return allowlist.routePrefixes.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Runs a capability artifact against typed inputs and returns the four-way
 * result. Detection order at every transition (checkTransition, below) is
 * fixed and lives in exactly one place: hard failure (HTTP status, checked
 * before any content is read) → allowlist boundary → session-expiry →
 * business outcome → recovery (bounded, looping) → checkpoint (only on the
 * final transition). Any condition that would otherwise be `failed` is
 * escalated instead when the step it followed is irreversible — never
 * retried.
 */
export async function replay(
  capability: CapabilityArtifact,
  appProfile: AppProfile,
  adapter: SurfaceAdapter,
  inputs: Record<string, string>,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const parsedInputs = buildInputsSchema(capability.inputs).parse(inputs);
  const allowIrreversible = options.allowIrreversible ?? false;
  const perRuleLimit = options.recoveryLimits?.perRule ?? DEFAULT_RECOVERY_LIMIT_PER_RULE;
  const overallLimit = options.recoveryLimits?.overall ?? DEFAULT_RECOVERY_LIMIT_OVERALL;

  const stepRecords: StepRecord[] = [];
  const recoveriesSeen = new Set<string>();
  const recoveryFireCounts = new Map<string, number>();
  let overallRecoveryCount = 0;
  const outputs: Record<string, string> = {};
  // False-positive guard for session-expiry detection (below): only treat the app
  // profile's sessionExpiry shape as meaningful once we've actually left entryPoint at
  // least once. Set true the first time a transition lands somewhere other than
  // entryPoint.
  let hasLeftEntryPoint = false;

  function classify(
    step: Step | undefined,
    detail: Omit<Extract<TerminalOutcome, { status: "failed" }>, "status">,
  ): TerminalOutcome {
    if (step && step.classification === "irreversible") {
      return {
        status: "escalated",
        reason: `Step "${step.id}" is irreversible; its action was sent and then a "${detail.errorClass}" condition occurred (${detail.observed}). The effect may already have taken place. Escalating rather than assuming failure or retrying.`,
      };
    }
    return { status: "failed", ...detail };
  }

  async function checkTransition(params: {
    step?: Step;
    checkCheckpoint: boolean;
  }): Promise<{ terminal?: TerminalOutcome; recoveriesFired: string[] }> {
    const recoveriesFired: string[] = [];

    for (let iteration = 0; iteration < MAX_TRANSITION_ITERATIONS; iteration++) {
      const status = adapter.lastNavigationStatus();
      if (status !== undefined && status >= 500) {
        return {
          terminal: classify(params.step, {
            stepId: params.step?.id ?? "(entry)",
            expected: "a 2xx/3xx response",
            observed: `HTTP ${status}`,
            errorClass: "http_error",
          }),
          recoveriesFired,
        };
      }

      const snapshot = await adapter.snapshot();
      const mainFrame = snapshot.frames.find((f) => f.frameId === "main");

      if (mainFrame && !isWithinAllowlist(appProfile.allowlist, mainFrame.url)) {
        return {
          terminal: classify(params.step, {
            stepId: params.step?.id ?? "(entry)",
            expected: `a URL within the allowlist (origin "${appProfile.allowlist.originPattern}", routes ${appProfile.allowlist.routePrefixes.join(", ")})`,
            observed: "landed outside the allowlisted origin/routes",
            errorClass: "allowlist_violation",
          }),
          recoveriesFired,
        };
      }

      const currentPath = mainFrame ? new URL(mainFrame.url).pathname : undefined;
      if (currentPath !== capability.entryPoint) {
        hasLeftEntryPoint = true;
      }

      // Detected the same way as any outcome/recovery — an app-level detector shape,
      // never inferred from entryPoint (that only worked here by coincidence, since
      // this capability happens to start at /login; a capability starting at /search
      // would never have detected an expiry redirect that way). The "have we left
      // entryPoint" check stays as a false-positive guard, not the primary signal.
      if (hasLeftEntryPoint && appProfile.sessionExpiry && matchesAnyShape(appProfile.sessionExpiry, snapshot)) {
        return {
          terminal: classify(params.step, {
            stepId: params.step?.id ?? "(entry)",
            expected: "the app profile's session-expiry signal not to match",
            observed: "the app profile's session-expiry signal matched",
            errorClass: "session_expired",
          }),
          recoveriesFired,
        };
      }

      for (const outcomeName of capability.businessOutcomes) {
        const detector = appProfile.outcomes[outcomeName];
        if (detector && matchesAnyShape(detector.shapes, snapshot)) {
          return { terminal: { status: "business_outcome", outcome: outcomeName }, recoveriesFired };
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
          return {
            terminal: classify(params.step, {
              stepId: params.step?.id ?? "(entry)",
              expected: `recovery "${rule.name}" to clear the condition within ${perRuleLimit} attempt(s)`,
              observed: `recovery "${rule.name}" fired ${ruleCount} time(s) without clearing`,
              errorClass: "recovery_exhausted",
            }),
            recoveriesFired,
          };
        }

        try {
          if (rule.action.kind === "dismiss") {
            await adapter.click(rule.action.locator);
          } else {
            await sleep(rule.action.timeoutMs);
          }
        } catch {
          return {
            terminal: classify(params.step, {
              stepId: params.step?.id ?? "(entry)",
              expected: `recovery "${rule.name}"'s dismiss action to resolve`,
              observed: `recovery "${rule.name}"'s dismiss locator did not resolve`,
              errorClass: "recovery_action_failed",
            }),
            recoveriesFired,
          };
        }
        recoveriesFired.push(rule.name);
        recovered = true;
        break;
      }
      if (recovered) {
        continue;
      }

      if (params.checkCheckpoint && !evaluateCheckpoint(capability.successCheckpoint, snapshot)) {
        return {
          terminal: classify(params.step, {
            stepId: params.step?.id ?? "(entry)",
            expected: `the declared successCheckpoint (${capability.successCheckpoint.kind})`,
            observed: describeCheckpointMiss(capability.successCheckpoint, snapshot),
            errorClass: "checkpoint_not_met",
          }),
          recoveriesFired,
        };
      }

      return { recoveriesFired };
    }

    throw new Error("internal: transition check exceeded its safety iteration cap");
  }

  function finalize(outcome: ResultShape): ReplayResult {
    return { ...outcome, steps: stepRecords, recoveries: [...recoveriesSeen] } as ReplayResult;
  }

  function markRemainingSkipped(fromIndex: number): void {
    for (let i = fromIndex; i < capability.steps.length; i++) {
      const s = capability.steps[i]!;
      stepRecords.push({
        stepId: s.id,
        action: s.action,
        outcome: "skipped",
        durationMs: 0,
        recoveriesFired: [],
        ...(s.classification === "irreversible" ? { irreversibleExecutionAuthorized: false } : {}),
      });
    }
  }

  // --- entry navigation ---
  await adapter.goto(capability.entryPoint);
  const entryCheck = await checkTransition({ checkCheckpoint: false });
  entryCheck.recoveriesFired.forEach((r) => recoveriesSeen.add(r));
  if (entryCheck.terminal) {
    return finalize(entryCheck.terminal);
  }

  // --- step loop ---
  for (let i = 0; i < capability.steps.length; i++) {
    const step = capability.steps[i]!;
    const isLastStep = i === capability.steps.length - 1;

    if (step.classification === "irreversible" && !allowIrreversible) {
      stepRecords.push({
        stepId: step.id,
        action: step.action,
        outcome: "skipped",
        durationMs: 0,
        recoveriesFired: [],
        irreversibleExecutionAuthorized: false,
      });
      markRemainingSkipped(i + 1);
      return finalize({
        status: "escalated",
        reason: `Step "${step.id}" is classified irreversible and allowIrreversible was not set on this replay call; stopping before it is attempted.`,
      });
    }

    const target = translateLocatorChain(step.target, options.tenantOverlay);
    const startedAt = Date.now();
    let matchedStrategy: LocatorStrategy["kind"] | undefined;
    let attemptedValue: string | undefined;
    let observedValue: string | undefined;
    let actionFailed = false;
    let resolutionAttempts: string[] | undefined;

    try {
      switch (step.action) {
        case "click": {
          const result = await adapter.click(target, step.frame);
          matchedStrategy = result.matchedStrategy.kind;
          break;
        }
        case "type": {
          const rawValue = parsedInputs[step.value.fromInput]!;
          const sensitivity = capability.inputs[step.value.fromInput]!.sensitivity;
          attemptedValue = redactForLog(rawValue, sensitivity);
          const result = await adapter.type(target, rawValue, step.frame);
          matchedStrategy = result.matchedStrategy.kind;
          break;
        }
        case "select": {
          const rawValue = parsedInputs[step.value.fromInput]!;
          const sensitivity = capability.inputs[step.value.fromInput]!.sensitivity;
          attemptedValue = redactForLog(rawValue, sensitivity);
          const result = await adapter.select(target, rawValue, step.frame);
          matchedStrategy = result.matchedStrategy.kind;
          break;
        }
        case "read": {
          const result = await adapter.read(target, step.frame);
          matchedStrategy = result.matchedStrategy.kind;
          outputs[step.outputName] = result.value;
          observedValue = redactForLog(result.value, capability.outputs[step.outputName]!.sensitivity);
          break;
        }
      }
    } catch (err) {
      actionFailed = true;
      if (err instanceof LocatorResolutionError) {
        resolutionAttempts = err.attempts;
      }
    }

    const durationMs = Date.now() - startedAt;
    const check = await checkTransition({ step, checkCheckpoint: isLastStep });
    check.recoveriesFired.forEach((r) => recoveriesSeen.add(r));

    const baseRecord: StepRecord = {
      stepId: step.id,
      action: step.action,
      outcome: "ok",
      durationMs,
      recoveriesFired: check.recoveriesFired,
      ...(matchedStrategy ? { matchedStrategy } : {}),
      ...(attemptedValue !== undefined ? { attemptedValue } : {}),
      ...(observedValue !== undefined ? { observedValue } : {}),
      ...(step.classification === "irreversible" ? { irreversibleExecutionAuthorized: true } : {}),
    };

    if (check.terminal) {
      // A clean business_outcome means the step's own action succeeded — the resulting
      // page just turned out to be a legitimate answer, not a problem with this step.
      // Every other terminal reason (hard failure, session-expiry, exhausted recovery,
      // unmet checkpoint) means this transition genuinely didn't land where expected.
      const outcome: StepOutcome = check.terminal.status === "business_outcome" ? "ok" : "failed";
      stepRecords.push({ ...baseRecord, outcome });
      markRemainingSkipped(i + 1);
      return finalize(check.terminal);
    }

    if (actionFailed) {
      const terminal = classify(step, {
        stepId: step.id,
        locatorUsed: target,
        expected: `the target element for step "${step.id}" to resolve to exactly one element`,
        observed:
          resolutionAttempts && resolutionAttempts.length > 0
            ? `no known outcome or recovery explains it; strategies tried — ${resolutionAttempts.join("; ")}`
            : "no locator strategy in the chain resolved uniquely, and no known outcome or recovery explains it",
        errorClass: "locator_not_found",
      });
      stepRecords.push({ ...baseRecord, outcome: "failed" });
      markRemainingSkipped(i + 1);
      return finalize(terminal);
    }

    stepRecords.push(baseRecord);
  }

  return finalize({ status: "success", outputs });
}
