import { evaluateCheckpoint, headingText } from "../adapter/matchers.js";
import { LocatorResolutionError, type SurfaceAdapter } from "../adapter/surfaceAdapter.js";
import type { Snapshot } from "../adapter/snapshotParser.js";
import {
  createControlGate,
  isValidDecisionFor,
  type EscalationHandler,
  type InterventionKind,
  type InterventionRecord,
  type InterventionRequest,
} from "../escalation.js";
import type { AppProfile } from "../schema/appProfile.js";
import { buildInputsSchema, type CapabilityArtifact } from "../schema/capability.js";
import type { Checkpoint } from "../schema/checkpoint.js";
import type { LocatorChain, LocatorStrategy } from "../schema/locator.js";
import type { Step } from "../schema/step.js";
import type { TenantOverlay } from "../schema/tenantOverlay.js";
import { createAppDetector } from "./appDetection.js";
import { isWithinAllowlist } from "./policy.js";
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
  | "step_checkpoint_not_met"
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
  /** True when an operator, not automation, is responsible for this step's completion (or explicit non-completion) — set only via the escalation handoff. */
  handledByOperator?: boolean;
  /** Only present when handledByOperator is true — the closed-set signal the operator gave, never free text, so evidence says who did what. */
  operatorSignal?: "performed" | "skipped";
}

interface ReplayResultCommon {
  steps: StepRecord[];
  recoveries: string[];
  /** Total wall-clock time for the run, start to finish — for a human-readable evidence summary, not used by replay() itself. */
  durationMs: number;
  /** Every escalation handoff cycle this run went through, in order — raised whether or not it ultimately resumed, so evidence shows exactly when control was ceded and returned. Empty unless `onEscalation` was configured. */
  interventions: InterventionRecord[];
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
  /**
   * When set, an escalation pauses instead of ending the run: the same
   * live `SurfaceAdapter` session stays open, control is ceded to this
   * handler (see `escalation.ts`'s own doc comment for the production-scale
   * seam this implies), and the operator's closed-set decision determines
   * how — or whether — the run continues. Unset (the default) preserves
   * today's exact behavior: an escalation ends the run immediately.
   */
  onEscalation?: EscalationHandler;
}

type TerminalOutcome = Exclude<ResultShape, { status: "success" }>;

/** Bounded the same way the recovery loop is (executor/appDetection.ts) — a genuinely broken situation must eventually stop asking, not loop forever. */
const MAX_INTERVENTION_CYCLES = 3;

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
  const startedAt = Date.now();
  const parsedInputs = buildInputsSchema(capability.inputs).parse(inputs);
  const allowIrreversible = options.allowIrreversible ?? false;
  const allowlistOrigin = options.tenantOverlay?.baseUrl ?? appProfile.allowlist.originPattern;
  // Every adapter operation this function performs — including the recovery loop's own
  // dismiss clicks inside createAppDetector — goes through the gate, so control ownership
  // is enforced everywhere, not just at the call sites this function writes directly.
  const gate = createControlGate(adapter);
  const appDetector = createAppDetector(appProfile, gate.adapter, options.recoveryLimits);

  const stepRecords: StepRecord[] = [];
  const recoveriesSeen = new Set<string>();
  const interventions: InterventionRecord[] = [];
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
    /**
     * Defaults to true. Set false after an escalation-handoff `skipped`
     * signal: the operator declared the step's action never happened, so
     * checking the step's *own* checkpoint (which asserts that action's
     * effect) would only ever fail — not a meaningful signal, just a
     * restatement that nothing happened. General safety checks (hard
     * failure, allowlist, session-expiry, business outcome, recovery) and
     * the capability's overall `successCheckpoint` still run regardless.
     */
    checkStepCheckpoint?: boolean;
  }): Promise<{ terminal?: TerminalOutcome; recoveriesFired: string[] }> {
    const status = gate.adapter.lastNavigationStatus();
    if (status !== undefined && status >= 500) {
      return {
        terminal: classify(params.step, {
          stepId: params.step?.id ?? "(entry)",
          expected: "a 2xx/3xx response",
          observed: `HTTP ${status}`,
          errorClass: "http_error",
        }),
        recoveriesFired: [],
      };
    }

    const rawSnapshot = await gate.adapter.snapshot();
    const mainFrame = rawSnapshot.frames.find((f) => f.frameId === "main");

    if (mainFrame && !isWithinAllowlist(appProfile.allowlist, allowlistOrigin, mainFrame.url)) {
      return {
        terminal: classify(params.step, {
          stepId: params.step?.id ?? "(entry)",
          expected: `a URL within the allowlist (origin "${allowlistOrigin}", routes ${appProfile.allowlist.routePrefixes.join(", ")})`,
          observed: "landed outside the allowlisted origin/routes",
          errorClass: "allowlist_violation",
        }),
        recoveriesFired: [],
      };
    }

    const currentPath = mainFrame ? new URL(mainFrame.url).pathname : undefined;
    if (currentPath !== capability.entryPoint) {
      hasLeftEntryPoint = true;
    }

    const detection = await appDetector.detect(rawSnapshot, capability.businessOutcomes, hasLeftEntryPoint);

    if (detection.kind === "session_expired") {
      return {
        terminal: classify(params.step, {
          stepId: params.step?.id ?? "(entry)",
          expected: "the app profile's session-expiry signal not to match",
          observed: "the app profile's session-expiry signal matched",
          errorClass: "session_expired",
        }),
        recoveriesFired: detection.recoveriesFired,
      };
    }
    if (detection.kind === "business_outcome") {
      return { terminal: { status: "business_outcome", outcome: detection.outcome }, recoveriesFired: detection.recoveriesFired };
    }
    if (detection.kind === "recovery_exhausted") {
      return {
        terminal: classify(params.step, {
          stepId: params.step?.id ?? "(entry)",
          expected: `recovery "${detection.ruleName}" to clear the condition`,
          observed: `recovery "${detection.ruleName}" fired repeatedly without clearing`,
          errorClass: "recovery_exhausted",
        }),
        recoveriesFired: detection.recoveriesFired,
      };
    }
    if (detection.kind === "recovery_action_failed") {
      return {
        terminal: classify(params.step, {
          stepId: params.step?.id ?? "(entry)",
          expected: `recovery "${detection.ruleName}"'s dismiss action to resolve`,
          observed: `recovery "${detection.ruleName}"'s dismiss locator did not resolve`,
          errorClass: "recovery_action_failed",
        }),
        recoveriesFired: detection.recoveriesFired,
      };
    }

    // detection.kind === "settled" — recoveries (if any) already dismissed; this is the
    // final, settled snapshot to check the checkpoint(s) against.
    const snapshot = detection.snapshot;

    // A step's own checkpoint (if declared) is checked for every transition, not just
    // the final one — independent of `capability.successCheckpoint`, which only ever
    // runs on the last step. Without this, a mid-flow step that lands on the wrong
    // page would go undetected as long as the *final* page happened to still satisfy
    // the overall checkpoint.
    if ((params.checkStepCheckpoint ?? true) && params.step?.checkpoint && !evaluateCheckpoint(params.step.checkpoint, snapshot)) {
      return {
        terminal: classify(params.step, {
          stepId: params.step.id,
          expected: `step "${params.step.id}"'s own checkpoint (${params.step.checkpoint.kind})`,
          observed: describeCheckpointMiss(params.step.checkpoint, snapshot),
          errorClass: "step_checkpoint_not_met",
        }),
        recoveriesFired: detection.recoveriesFired,
      };
    }

    if (params.checkCheckpoint && !evaluateCheckpoint(capability.successCheckpoint, snapshot)) {
      return {
        terminal: classify(params.step, {
          stepId: params.step?.id ?? "(entry)",
          expected: `the declared successCheckpoint (${capability.successCheckpoint.kind})`,
          observed: describeCheckpointMiss(capability.successCheckpoint, snapshot),
          errorClass: "checkpoint_not_met",
        }),
        recoveriesFired: detection.recoveriesFired,
      };
    }

    return { recoveriesFired: detection.recoveriesFired };
  }

  /**
   * Shared by both escalation points below. Every `escalated` result in
   * `replay()` follows from a step classified `irreversible` (see `classify`
   * above — it's the only path that produces `status: "escalated"`), so the
   * intervention is always `kind: "irreversible_action"` here; the `"other"`
   * kind belongs to discovery's non-action escalations instead.
   *
   * Captures URL/screenshot *before* ceding control (the gated adapter
   * refuses `screenshot()`/`snapshot()` once ceded), hands the request to
   * `options.onEscalation` through `gate.withOperatorControl` (so control
   * can't get stuck on "operator" even if the handler throws), then acts on
   * the closed-set decision:
   *
   * - `aborted` → the run ends now.
   * - an otherwise-invalid signal for this kind → treated as an abort rather
   *   than guessed at.
   * - `performed` → re-runs `checkTransition` for the *same* step, exactly
   *   as automation would after its own action — never trusted on the
   *   operator's word alone. A clean re-check resumes; a re-escalation loops
   *   (bounded by `MAX_INTERVENTION_CYCLES`) with the fresh expected-vs-observed
   *   reason; any other terminal (hard failure, business outcome, …) ends
   *   the run with that terminal directly.
   * - `skipped` → only continues past a non-last step when it declares
   *   `continuesAfterSkip` (the last step is always safe to skip, per
   *   `continuesAfterSkip`'s own doc comment). Either way, general safety
   *   conditions — and, on the last step, the overall `successCheckpoint` —
   *   still get checked (`checkStepCheckpoint: false` suppresses only the
   *   skipped step's *own* checkpoint, which could only ever fail once its
   *   action is declared not to have happened).
   */
  async function attemptHandoff(params: {
    terminal: Extract<TerminalOutcome, { status: "escalated" }>;
    step: Step;
    isLastStep: boolean;
  }): Promise<
    | { outcome: "resumed"; signal: "performed" | "skipped"; check: { recoveriesFired: string[] } }
    | { outcome: "terminal"; terminal: TerminalOutcome }
  > {
    const handler = options.onEscalation;
    if (!handler) {
      return { outcome: "terminal", terminal: params.terminal };
    }

    const kind: InterventionKind = "irreversible_action";
    let terminal = params.terminal;

    for (let cycle = 0; cycle < MAX_INTERVENTION_CYCLES; cycle++) {
      const raisedAt = new Date().toISOString();
      // Captured before ceding control — the gated adapter refuses these once ceded.
      const snapshot = await gate.adapter.snapshot();
      const mainFrame = snapshot.frames.find((f) => f.frameId === "main");
      const screenshot = await gate.adapter.screenshot();

      const request: InterventionRequest = {
        kind,
        runKind: "replay",
        subject: capability.capabilityId,
        location: params.step.id,
        reason: terminal.reason,
        url: mainFrame?.url,
        screenshot,
      };

      const decision = await gate.withOperatorControl(handler, request);
      const resumedAt = new Date().toISOString();
      interventions.push({ request, decision, raisedAt, resumedAt });

      if (!isValidDecisionFor(kind, decision.signal)) {
        return {
          outcome: "terminal",
          terminal: {
            status: "escalated",
            reason: `${terminal.reason} Operator gave signal "${decision.signal}", which is not valid for an irreversible-action escalation; ending the run rather than guessing intent.`,
          },
        };
      }

      if (decision.signal === "aborted") {
        return {
          outcome: "terminal",
          terminal: { status: "escalated", reason: `${terminal.reason} Operator aborted the run during handoff.` },
        };
      }

      if (decision.signal === "skipped") {
        if (!params.isLastStep && !params.step.continuesAfterSkip) {
          return {
            outcome: "terminal",
            terminal: {
              status: "escalated",
              reason: `${terminal.reason} Operator skipped step "${params.step.id}", but it does not declare continuesAfterSkip and this is not the last step — later steps may depend on its effect, so the run ends here rather than risk continuing on an unmet dependency.`,
            },
          };
        }
        // The skipped step's own checkpoint is deliberately not checked — the operator
        // just declared its action never happened, so it could only ever fail. General
        // safety conditions, and (on the last step) the capability's overall
        // successCheckpoint, still run: "safe to skip" isn't the same as "the goal was
        // reached without it."
        const check = await checkTransition({ step: params.step, checkCheckpoint: params.isLastStep, checkStepCheckpoint: false });
        if (check.terminal) {
          return { outcome: "terminal", terminal: check.terminal };
        }
        check.recoveriesFired.forEach((r) => recoveriesSeen.add(r));
        return { outcome: "resumed", signal: "skipped", check };
      }

      // performed — never trust, always verify: re-run the exact same check automation
      // would run after its own action, against the same step.
      const check = await checkTransition({ step: params.step, checkCheckpoint: params.isLastStep });
      if (!check.terminal) {
        check.recoveriesFired.forEach((r) => recoveriesSeen.add(r));
        return { outcome: "resumed", signal: "performed", check };
      }
      if (check.terminal.status !== "escalated") {
        return { outcome: "terminal", terminal: check.terminal };
      }
      // Still escalated after "performed" — loop again with the fresh expected-vs-observed
      // reason, bounded rather than asking forever.
      terminal = check.terminal;
    }

    return {
      outcome: "terminal",
      terminal: {
        status: "escalated",
        reason: `Escalation handoff for step "${params.step.id}" did not resolve after ${MAX_INTERVENTION_CYCLES} attempts; ending the run rather than looping indefinitely.`,
      },
    };
  }

  function finalize(outcome: ResultShape): ReplayResult {
    return {
      ...outcome,
      steps: stepRecords,
      recoveries: [...recoveriesSeen],
      durationMs: Date.now() - startedAt,
      interventions: [...interventions],
    } as ReplayResult;
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
  await gate.adapter.goto(capability.entryPoint);
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
      const terminal: TerminalOutcome = {
        status: "escalated",
        reason: `Step "${step.id}" is classified irreversible and allowIrreversible was not set on this replay call; stopping before it is attempted.`,
      };
      const handoff = await attemptHandoff({ terminal, step, isLastStep });
      if (handoff.outcome === "terminal") {
        stepRecords.push({
          stepId: step.id,
          action: step.action,
          outcome: "skipped",
          durationMs: 0,
          recoveriesFired: [],
          irreversibleExecutionAuthorized: false,
        });
        markRemainingSkipped(i + 1);
        return finalize(handoff.terminal);
      }
      stepRecords.push({
        stepId: step.id,
        action: step.action,
        outcome: "ok",
        durationMs: 0,
        recoveriesFired: handoff.check.recoveriesFired,
        irreversibleExecutionAuthorized: handoff.signal === "performed",
        handledByOperator: true,
        operatorSignal: handoff.signal,
      });
      continue;
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
          const result = await gate.adapter.click(target, step.frame);
          matchedStrategy = result.matchedStrategy.kind;
          break;
        }
        case "type": {
          const rawValue = parsedInputs[step.value.fromInput]!;
          const sensitivity = capability.inputs[step.value.fromInput]!.sensitivity;
          attemptedValue = redactForLog(rawValue, sensitivity);
          const result = await gate.adapter.type(target, rawValue, step.frame);
          matchedStrategy = result.matchedStrategy.kind;
          break;
        }
        case "select": {
          const rawValue = parsedInputs[step.value.fromInput]!;
          const sensitivity = capability.inputs[step.value.fromInput]!.sensitivity;
          attemptedValue = redactForLog(rawValue, sensitivity);
          const result = await gate.adapter.select(target, rawValue, step.frame);
          matchedStrategy = result.matchedStrategy.kind;
          break;
        }
        case "read": {
          const result = await gate.adapter.read(target, step.frame);
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
      if (check.terminal.status === "escalated") {
        const handoff = await attemptHandoff({ terminal: check.terminal, step, isLastStep });
        if (handoff.outcome === "terminal") {
          stepRecords.push({ ...baseRecord, outcome: "failed" });
          markRemainingSkipped(i + 1);
          return finalize(handoff.terminal);
        }
        stepRecords.push({
          ...baseRecord,
          outcome: "ok",
          recoveriesFired: handoff.check.recoveriesFired,
          handledByOperator: true,
          operatorSignal: handoff.signal,
        });
        continue;
      }
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
