import { evaluateCheckpoint } from "../adapter/matchers.js";
import { findByRef, frameRefFor, resolveRef, type Snapshot, type SnapshotNode } from "../adapter/snapshotParser.js";
import { LocatorResolutionError, type SurfaceAdapter } from "../adapter/surfaceAdapter.js";
import {
  createControlGate,
  isValidDecisionFor,
  type EscalationHandler,
  type InterventionKind,
  type InterventionRecord,
  type InterventionRequest,
} from "../escalation.js";
import { createAppDetector } from "../executor/appDetection.js";
import { isIrreversibleControl, isWithinAllowlist } from "../executor/policy.js";
import { redactForLog } from "../executor/redact.js";
import type { AppProfile } from "../schema/appProfile.js";
import type { CapabilityArtifact, Sensitivity } from "../schema/capability.js";
import type { Checkpoint } from "../schema/checkpoint.js";
import type { Step } from "../schema/step.js";
import { buildCompactView, redactSecretValuesInView, refKey } from "./compactView.js";
import { deriveCheckpoint } from "./deriveCheckpoint.js";
import type { DiscoveryContext, DiscoveryGoalInfo, DiscoveryModel, TurnHistoryEntry } from "./model.js";
import type { EscalateReasonCode, ToolCall } from "./tools.js";

export interface DiscoveryInputSpec {
  /** The literal runtime value for this one discovery session — known only to the driver, never sent to the model as a value (design decision 3: the model names a declared input, never sees or supplies its value). */
  value: string;
  sensitivity: Sensitivity;
}

export interface DiscoveryGoal {
  capabilityId: string;
  version: string;
  appId: string;
  description: string;
  entryPoint: string;
  inputs: Record<string, DiscoveryInputSpec>;
  outputs: Record<string, { sensitivity: Sensitivity }>;
}

export interface DiscoverOptions {
  /** Total turns (model calls) allowed before stopping with `max_steps`. */
  maxSteps?: number;
  /** Wall-clock budget in ms before stopping with `timeout`. */
  timeoutMs?: number;
  /** Consecutive structurally-unchanged iterations before stopping with `dead_end`. */
  deadEndThreshold?: number;
  /**
   * When set, an escalation pauses instead of ending the run — same control-transfer
   * model as `replay()`'s own `onEscalation` (see `escalation.ts`'s doc comment for the
   * production-scale seam this implies). Discovery's verification is honestly weaker
   * than replay's, though: there's no per-action declared checkpoint to check a
   * `performed`/`skipped`/`resolved` signal against, only a fresh re-observation handed
   * to the model's own next turn to judge — see `attemptHandoff` below. Unset (the
   * default) preserves today's exact behavior: an escalation ends the run immediately.
   */
  onEscalation?: EscalationHandler;
}

export interface DiscoveryTurnLogEntry {
  toolName: string;
  outcome: "executed" | "refused" | "malformed";
  detail: string;
}

interface DiscoveryResultCommon {
  turns: DiscoveryTurnLogEntry[];
  /** Recoveries dismissed in-flight during this run — recorded so a reviewer can see they were detected, same as CLAUDE.md requires of replay. Never a step: an interstitial can appear anywhere, and dismissing one says nothing about how to complete the goal from a clean page. */
  recoveries: string[];
  /** Total wall-clock time for the run, start to finish — for a human-readable evidence summary, not used by the loop itself. */
  durationMs: number;
  /**
   * Every secret/pii-sensitivity value used this run (an input literal
   * typed, or an output value read) that cleared `MIN_SCRUB_PATTERN_LENGTH`
   * — exposed so a caller writing evidence (automation/evidence.ts) can
   * scrub free-text fields the same way the checkpoint safety net already
   * protects `done`. Concretely: the model's own `escalate` reason is free
   * text and may quote page content, including something this list would
   * catch. This module never writes these values anywhere itself — the
   * caller is responsible for using them, same trust model as
   * `ReplayResult.success.outputs` already exposing raw values.
   */
  knownSensitiveValues: readonly string[];
  /** Every escalation handoff cycle this run went through, in order — raised whether or not it ultimately resumed, so evidence shows exactly when control was ceded and returned. Empty unless `onEscalation` was configured. */
  interventions: InterventionRecord[];
}

type DiscoveryResultShape =
  | { status: "done"; capability: CapabilityArtifact }
  | { status: "max_steps"; stepsTaken: number }
  | { status: "timeout"; elapsedMs: number }
  | { status: "dead_end"; repeatedTurns: number }
  | { status: "escalated"; reason: string }
  /** A declared app-profile outcome matched for the specific inputs this session used — a recognized, understood condition (e.g. "Member Not Found" for this memberId), not a system failure. A re-run with different inputs might succeed; this run's goal wasn't reachable with these. */
  | { status: "business_outcome"; outcome: string }
  /** The app profile's session-expiry signal matched mid-run. Discovery has no re-authentication flow — this just ends the run rather than letting the model flail against a login wall it can't get past. */
  | { status: "session_expired" }
  /**
   * A model-chosen click/type/select landed the main frame outside the app
   * profile's allowlist. Discovery needs this even more than replay does:
   * replay runs a fixed, human-reviewed artifact, but discovery is
   * model-driven and can click any link on the page — without this check,
   * an off-allowlist navigation could get recorded straight into the
   * artifact as a permanent step.
   */
  | { status: "allowlist_violation"; url: string }
  /** The main frame's last navigation returned a 5xx — checked before any page content is read, same as replay(). */
  | { status: "http_error"; httpStatus: number };

// `Omit`/intersection do not distribute over a union on their own — same trick executor/replay.ts uses for ReplayResult.
type AddCommon<T> = T extends unknown ? T & DiscoveryResultCommon : never;
export type DiscoveryResult = AddCommon<DiscoveryResultShape>;

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_DEAD_END_THRESHOLD = 3;

/** Thrown by `withTimeout` — distinguished from a genuine model-call error so the loop can turn only this into `status: "timeout"`, not swallow a real failure. */
class ModelCallTimeoutError extends Error {}

/**
 * Bounds a single model call to `ms` — without this, `timeoutMs` is only
 * ever checked at the top of each loop iteration, so a model call that
 * simply hangs (never resolves, never rejects) would block `discover()`
 * forever regardless of the configured budget. Races the call against a
 * timer; the timer is always cleared, whichever settles first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelCallTimeoutError(`Model call exceeded its ${ms}ms budget.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function attrsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => a[key] === b[key]);
}

function nodesStructurallyEqual(a: SnapshotNode[], b: SnapshotNode[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.role !== y.role || x.name !== y.name || x.text !== y.text) {
      return false;
    }
    if (!attrsEqual(x.attrs, y.attrs)) {
      return false;
    }
    if (!nodesStructurallyEqual(x.children, y.children)) {
      return false;
    }
  }
  return true;
}

/** Ignores `ref`/`ordinal` (stable-but-arbitrary bookkeeping, not observable page content) — the dead-end signal CLAUDE.md describes: "several actions in a row with no change in the snapshot." */
export function snapshotsStructurallyEqual(a: Snapshot, b: Snapshot): boolean {
  if (a.frames.length !== b.frames.length) {
    return false;
  }
  for (let i = 0; i < a.frames.length; i++) {
    const fa = a.frames[i]!;
    const fb = b.frames[i]!;
    if (fa.frameId !== fb.frameId || fa.title !== fb.title || fa.name !== fb.name || fa.url !== fb.url) {
      return false;
    }
    if (!nodesStructurallyEqual(fa.nodes, fb.nodes)) {
      return false;
    }
  }
  return true;
}

function buildCapabilityArtifact(goal: DiscoveryGoal, steps: Step[], successCheckpoint: Checkpoint): CapabilityArtifact {
  const inputs: CapabilityArtifact["inputs"] = {};
  for (const [name, spec] of Object.entries(goal.inputs)) {
    inputs[name] = { type: "string", sensitivity: spec.sensitivity };
  }
  const outputs: CapabilityArtifact["outputs"] = {};
  for (const [name, spec] of Object.entries(goal.outputs)) {
    outputs[name] = { type: "string", sensitivity: spec.sensitivity };
  }
  return {
    schemaVersion: "1.0.0",
    capabilityId: goal.capabilityId,
    version: goal.version,
    appId: goal.appId,
    description: goal.description,
    entryPoint: goal.entryPoint,
    inputs,
    outputs,
    steps,
    successCheckpoint,
    businessOutcomes: [],
    // A discovered artifact has not been looked at by a human yet, however clean the run was —
    // only a human ever flips this to "approved" (schema/capability.ts).
    approvalState: "draft",
  };
}

interface KnownValue {
  value: string;
  sensitivity: Sensitivity;
}

/**
 * A value must be at least this many characters to be used as a scrub/block
 * pattern — compact-view redaction (`secretValuesForRedaction`) and the
 * checkpoint-derivation safety net (`sensitiveValuesForSafetyNet`) alike.
 * Blocking a genuine PII/secret value is right; blocking every incidental
 * short value too is a real side effect worth guarding against — an output
 * happening to read back something generic and short (a status like
 * "active", an enum like "Open") would otherwise become a blocked string
 * everywhere for the rest of the run, redacting or refusing unrelated
 * content that just happens to contain the same short word. 7 is short
 * enough to still protect a real name ("Elena Cho", 9) or a real
 * credential, long enough to exclude common short status/enum words.
 */
export const MIN_SCRUB_PATTERN_LENGTH = 7;

function valuesOfSensitivity(known: KnownValue[], sensitivities: Sensitivity[]): string[] {
  return known
    .filter((v) => sensitivities.includes(v.sensitivity) && v.value.length >= MIN_SCRUB_PATTERN_LENGTH)
    .map((v) => v.value);
}

/**
 * Builds the human-readable escalation reason entirely from facts the
 * driver already holds and already redacts — never from anything the model
 * wrote. `escalate` takes a closed `reasonCode` plus an optional pointer to
 * the element the model considers blocking (never interpolated into this
 * text — see `EscalateArgsSchema`'s own doc comment). `lastEntry.result` is
 * safe to include verbatim: every `TurnHistoryEntry.result` this loop
 * constructs is already either a generic structural description (a ref, a
 * role, a control name from the app profile or the page's own stable UI
 * labels) or redacted by declared sensitivity — never raw page content.
 */
function composeEscalationReason(
  reasonCode: EscalateReasonCode,
  turnsTaken: number,
  url: string | undefined,
  lastEntry: TurnHistoryEntry | undefined,
): string {
  const parts = [`reasonCode=${reasonCode}`, `afterTurns=${turnsTaken}`, `url=${url ?? "(unknown)"}`];
  if (lastEntry) {
    parts.push(`lastAction=${lastEntry.toolCall.tool}`, `lastResult="${lastEntry.result}"`);
  }
  return parts.join("; ");
}

/**
 * Runs the observe -> decide -> act discovery loop against a live surface,
 * emitting a draft capability artifact on success. Every action passes the
 * policy gate (an irreversible-classified control is never executed —
 * only escalation can get past it) before it executes, and the model
 * never sees or supplies a literal input value, writes a locator, or
 * authors its own success condition — it only ever names a ref from the
 * compact view it was just shown (design decisions 1-4,
 * docs/plans/03-discovery-loop.md).
 */
export async function discover(
  goal: DiscoveryGoal,
  appProfile: AppProfile,
  adapter: SurfaceAdapter,
  model: DiscoveryModel,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadEndThreshold = options.deadEndThreshold ?? DEFAULT_DEAD_END_THRESHOLD;
  // Every adapter operation this function performs — including the recovery loop's own
  // dismiss clicks inside createAppDetector — goes through the gate, so control ownership
  // is enforced everywhere, not just at the call sites this function writes directly.
  const controlGate = createControlGate(adapter);

  await controlGate.adapter.goto(goal.entryPoint);

  const startedAt = Date.now();
  const steps: Step[] = [];
  const modelHistory: TurnHistoryEntry[] = [];
  const turnLog: DiscoveryTurnLogEntry[] = [];
  const writtenOutputs = new Set<string>();
  const redactedRefs = new Set<string>();
  const knownValues: KnownValue[] = [];
  const recoveriesSeen = new Set<string>();
  const interventions: InterventionRecord[] = [];
  const appDetector = createAppDetector(appProfile, controlGate.adapter);
  const allOutcomeNames = Object.keys(appProfile.outcomes);
  // No tenant-overlay concept in discovery (out of scope) — the app profile's own
  // originPattern is always the authoritative allowlist origin here, unlike replay()
  // which lets a tenant overlay's baseUrl override it.
  const allowlistOrigin = appProfile.allowlist.originPattern;
  let stepCounter = 0;
  let previousSnapshot: Snapshot | undefined;
  let previousWrittenOutputsCount = 0;
  let noOpStreak = 0;
  // False-positive guard for session-expiry detection, same as replay() — only treat the
  // app profile's sessionExpiry shape as meaningful once we've actually left entryPoint.
  let hasLeftEntryPoint = false;

  const goalInfo: DiscoveryGoalInfo = {
    description: goal.description,
    declaredInputs: Object.entries(goal.inputs).map(([name, spec]) => ({ name, sensitivity: spec.sensitivity })),
    declaredOutputs: Object.entries(goal.outputs).map(([name, spec]) => ({ name, sensitivity: spec.sensitivity })),
  };

  function finalize(shape: DiscoveryResultShape): DiscoveryResult {
    return {
      ...shape,
      turns: turnLog,
      recoveries: [...recoveriesSeen],
      durationMs: Date.now() - startedAt,
      knownSensitiveValues: valuesOfSensitivity(knownValues, ["secret", "pii"]),
      interventions: [...interventions],
    } as DiscoveryResult;
  }

  function nextStepId(action: string): string {
    stepCounter += 1;
    return `${action}-${stepCounter}`;
  }

  /**
   * Shared by all three of discover()'s escalation points. Captures URL/screenshot
   * *before* ceding control (the gated adapter refuses `screenshot()`/`snapshot()` once
   * ceded), hands the request to `options.onEscalation` through `controlGate.withOperatorControl`
   * (so control can't get stuck on "operator" even if the handler throws), then acts on
   * the closed-set decision:
   *
   * - `aborted`, or a signal invalid for `kind` → the run ends now.
   * - any valid signal otherwise (`resolved`, or `performed`/`skipped` for an
   *   `action_refused_irreversible` escalation) → resumes. Unlike `replay()`, there is no
   *   per-action declared checkpoint to verify a `performed`/`skipped` signal against —
   *   discovery is exploring, not executing a fixed script — so nothing here re-checks
   *   anything. The loop just re-observes on its next iteration and, for the `escalate`
   *   call site, hands the model a plain note that a human resolved the escalation,
   *   leaving it to the model's own next turn to judge whether its intended action
   *   visibly succeeded. This asymmetry with replay's real verification is deliberate,
   *   not an oversight (design decision 6, docs/plans/04-escalation-handoff-cli.md) — and
   *   it's why repeated escalations aren't specially bounded here the way replay's
   *   `MAX_INTERVENTION_CYCLES` bounds them: a handoff that doesn't actually fix anything
   *   just re-triggers the same detection next iteration, and the loop's own existing
   *   `maxSteps`/`timeoutMs` bound that exactly like any other non-progress.
   */
  async function attemptHandoff(params: {
    kind: InterventionKind;
    reason: string;
    location: string;
  }): Promise<{ outcome: "resumed"; signal: "performed" | "skipped" | "resolved" } | { outcome: "terminal"; reason: string }> {
    const handler = options.onEscalation;
    if (!handler) {
      return { outcome: "terminal", reason: params.reason };
    }

    const raisedAt = new Date().toISOString();
    // Captured before ceding control — the gated adapter refuses these once ceded.
    const currentSnapshot = await controlGate.adapter.snapshot();
    const mainFrame = currentSnapshot.frames.find((f) => f.frameId === "main");
    const screenshot = await controlGate.adapter.screenshot();

    const request: InterventionRequest = {
      kind: params.kind,
      runKind: "discovery",
      subject: goal.description,
      location: params.location,
      reason: params.reason,
      url: mainFrame?.url,
      screenshot,
    };

    const decision = await controlGate.withOperatorControl(handler, request);
    const resumedAt = new Date().toISOString();
    interventions.push({ request, decision, raisedAt, resumedAt });

    if (!isValidDecisionFor(params.kind, decision.signal)) {
      return {
        outcome: "terminal",
        reason: `${params.reason} Operator gave signal "${decision.signal}", which is not valid for this escalation; ending the run rather than guessing intent.`,
      };
    }
    if (decision.signal === "aborted") {
      return { outcome: "terminal", reason: `${params.reason} Operator aborted the run during handoff.` };
    }
    return { outcome: "resumed", signal: decision.signal };
  }

  /** Resolves frameId+ref to its node and applies the irreversible-control policy gate — shared by click/type/select. Returns a refusal reason, or the resolved node + locator chain to proceed with. */
  function resolveAndGate(
    snapshot: Snapshot,
    frameId: string,
    ref: string,
  ): { ok: true; node: SnapshotNode; locator: ReturnType<typeof resolveRef> } | { ok: false; reason: string } {
    const frame = snapshot.frames.find((f) => f.frameId === frameId);
    if (!frame) {
      return { ok: false, reason: `no frame "${frameId}" in the current snapshot` };
    }
    const node = findByRef(frame.nodes, ref);
    if (!node) {
      return { ok: false, reason: `no node with ref "${ref}" in frame "${frameId}" — use a ref from the current snapshot` };
    }
    if (isIrreversibleControl(appProfile, node.role, node.name ?? "")) {
      return {
        ok: false,
        reason: `ref "${ref}" (role "${node.role}", name "${node.name ?? ""}") is classified irreversible — cannot execute during discovery; call escalate if this action is required`,
      };
    }
    try {
      const locator = resolveRef(snapshot, frameId, ref);
      return { ok: true, node, locator };
    } catch (cause) {
      return { ok: false, reason: (cause as Error).message };
    }
  }

  function frameFieldFor(snapshot: Snapshot, frameId: string): { frame?: ReturnType<typeof frameRefFor> } {
    if (frameId === "main") {
      return {};
    }
    const frame = snapshot.frames.find((f) => f.frameId === frameId);
    return frame ? { frame: frameRefFor(frame) } : {};
  }

  for (let iteration = 1; ; iteration++) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return finalize({ status: "timeout", elapsedMs: Date.now() - startedAt });
    }
    if (iteration > maxSteps) {
      return finalize({ status: "max_steps", stepsTaken: iteration - 1 });
    }

    // Hard failure, checked before any page content is read — same as replay().
    const navigationStatus = controlGate.adapter.lastNavigationStatus();
    if (navigationStatus !== undefined && navigationStatus >= 500) {
      return finalize({ status: "http_error", httpStatus: navigationStatus });
    }

    const rawSnapshot = await controlGate.adapter.snapshot();
    const mainFrame = rawSnapshot.frames.find((f) => f.frameId === "main");

    // Discovery needs this even more than replay does: replay runs a fixed, human-reviewed
    // artifact, but discovery is model-driven and can click any link on the page — without
    // this, an off-allowlist navigation could get recorded straight into the artifact as a
    // permanent step.
    if (mainFrame && !isWithinAllowlist(appProfile.allowlist, allowlistOrigin, mainFrame.url)) {
      return finalize({ status: "allowlist_violation", url: mainFrame.url });
    }

    const currentPath = mainFrame ? new URL(mainFrame.url).pathname : undefined;
    if (currentPath !== goal.entryPoint) {
      hasLeftEntryPoint = true;
    }

    // Recovery is handled here, before the compact view is built, and never becomes a
    // step: reusing the same detection replay() uses (executor/appDetection.ts) rather
    // than a second implementation. Without this, the model would see a recoverable
    // interstitial directly in its compact view and likely dismiss it itself — a dismiss
    // that would then get recorded as a permanent step, producing an artifact that only
    // works when that interstitial happens to appear. A business outcome or session
    // expiry mid-run ends discovery with its own distinct result rather than letting the
    // model flail against it until dead_end.
    const detection = await appDetector.detect(rawSnapshot, allOutcomeNames, hasLeftEntryPoint);
    detection.recoveriesFired.forEach((r) => recoveriesSeen.add(r));

    if (detection.kind === "business_outcome") {
      return finalize({ status: "business_outcome", outcome: detection.outcome });
    }
    if (detection.kind === "session_expired") {
      return finalize({ status: "session_expired" });
    }
    if (detection.kind === "recovery_exhausted") {
      const reason = `Recovery "${detection.ruleName}" fired repeatedly without clearing the condition — cannot safely proceed unattended.`;
      const handoff = await attemptHandoff({ kind: "other", reason, location: `turn ${iteration}` });
      if (handoff.outcome === "terminal") {
        return finalize({ status: "escalated", reason: handoff.reason });
      }
      continue; // re-observe next iteration — no per-action checkpoint to verify a recovery-condition handoff against
    }
    if (detection.kind === "recovery_action_failed") {
      const reason = `Recovery "${detection.ruleName}"'s dismiss action did not resolve — cannot safely proceed unattended.`;
      const handoff = await attemptHandoff({ kind: "other", reason, location: `turn ${iteration}` });
      if (handoff.outcome === "terminal") {
        return finalize({ status: "escalated", reason: handoff.reason });
      }
      continue;
    }

    // detection.kind === "settled" — this is the snapshot the model actually sees.
    const snapshot = detection.snapshot;
    // A successful `read` never changes the page — it's not supposed to — so a run of
    // several reads in a row (a completely ordinary way to finish a goal with multiple
    // declared outputs) would otherwise look identical to the model being stuck, purely
    // because nothing in the DOM moved. Real progress is "the snapshot changed" OR "a new
    // output got written since the last check" — either counts, not just the first.
    const unchangedPage = previousSnapshot !== undefined && snapshotsStructurallyEqual(previousSnapshot, snapshot);
    const noNewOutputs = writtenOutputs.size === previousWrittenOutputsCount;
    if (unchangedPage && noNewOutputs) {
      noOpStreak += 1;
    } else {
      noOpStreak = 0;
    }
    if (noOpStreak >= deadEndThreshold) {
      return finalize({ status: "dead_end", repeatedTurns: noOpStreak });
    }
    previousSnapshot = snapshot;
    previousWrittenOutputsCount = writtenOutputs.size;

    const secretValuesForRedaction = valuesOfSensitivity(knownValues, ["secret"]);
    const sensitiveValuesForSafetyNet = valuesOfSensitivity(knownValues, ["secret", "pii"]);
    const compactSnapshot = redactSecretValuesInView(
      buildCompactView(snapshot, { redactedRefs }),
      secretValuesForRedaction,
    );

    const context: DiscoveryContext = {
      goal: goalInfo,
      writtenOutputs: [...writtenOutputs],
      compactSnapshot,
      history: modelHistory,
    };

    // Bounded against whatever's left of the overall budget, computed fresh here (not
    // reused from the top of the iteration) — recovery detection above can itself take
    // time. Without this, a model call that simply hangs would block discover() forever
    // regardless of timeoutMs, since that option was otherwise only ever checked between
    // iterations, never during one.
    const modelCallBudget = timeoutMs - (Date.now() - startedAt);
    if (modelCallBudget <= 0) {
      return finalize({ status: "timeout", elapsedMs: Date.now() - startedAt });
    }
    let turn;
    try {
      turn = await withTimeout(model.chooseNextAction(context), modelCallBudget);
    } catch (cause) {
      if (cause instanceof ModelCallTimeoutError) {
        return finalize({ status: "timeout", elapsedMs: Date.now() - startedAt });
      }
      throw cause;
    }

    if (turn.kind === "malformed") {
      // Not fed back into modelHistory — the model is forced to emit a tool call every turn
      // (tool_choice: "any"), so a malformed one is a rare formatting slip, not something to
      // spend conversation state reconstructing; it just consumes a step, and an unchanged
      // page repeats next turn, which dead_end/max_steps still bound.
      turnLog.push({ toolName: turn.toolName, outcome: "malformed", detail: turn.error });
      continue;
    }

    const call: ToolCall = turn.call;

    if (call.tool === "escalate") {
      const mainFrame = snapshot.frames.find((f) => f.frameId === "main");
      const lastEntry = modelHistory[modelHistory.length - 1];
      const reason = composeEscalationReason(call.args.reasonCode, modelHistory.length, mainFrame?.url, lastEntry);
      turnLog.push({ toolName: "escalate", outcome: "executed", detail: reason });

      // Only a refusal to run an irreversible action has a concrete action to have
      // performed or skipped; every other reasonCode ("stuck", "unexpected_state",
      // "cannot_complete") describes the model being unable to proceed, not a specific
      // action — so it offers only resolved/aborted (isValidDecisionFor enforces this).
      const kind: InterventionKind = call.args.reasonCode === "action_refused_irreversible" ? "irreversible_action" : "other";
      const handoff = await attemptHandoff({ kind, reason, location: `turn ${modelHistory.length + 1}` });
      if (handoff.outcome === "terminal") {
        return finalize({ status: "escalated", reason: handoff.reason });
      }
      modelHistory.push({
        toolCall: call,
        result: `an operator resolved this escalation with signal "${handoff.signal}"; the page has been re-observed since — judge for yourself whether the action you were concerned about actually happened before deciding what to do next`,
      });
      continue;
    }

    if (call.tool === "done") {
      const missing = Object.keys(goal.outputs).filter((name) => !writtenOutputs.has(name));
      if (missing.length > 0) {
        const detail = `refused: declared output(s) not yet written: ${missing.join(", ")}`;
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: "done", outcome: "refused", detail });
        continue;
      }

      const derived = deriveCheckpoint(snapshot, call.args.proof, sensitiveValuesForSafetyNet);
      if (!derived.ok) {
        const detail = `refused: ${derived.error}`;
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: "done", outcome: "refused", detail });
        continue;
      }

      // Re-verify against a freshly-taken snapshot, not the one the proof was derived from —
      // never assume a click worked (CLAUDE.md's artifact rules), and never trust a proof
      // chosen a moment ago without confirming reality still matches right before finalizing.
      const freshSnapshot = await controlGate.adapter.snapshot();
      if (!evaluateCheckpoint(derived.checkpoint, freshSnapshot)) {
        const detail = "refused: the derived checkpoint is not true against a freshly-taken snapshot";
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: "done", outcome: "refused", detail });
        continue;
      }

      const capability = buildCapabilityArtifact(goal, steps, derived.checkpoint);
      turnLog.push({ toolName: "done", outcome: "executed", detail: "goal complete" });
      return finalize({ status: "done", capability });
    }

    // click / type / select all share: resolve + policy gate, then execute-or-refuse.
    if (call.tool === "click") {
      const gate = resolveAndGate(snapshot, call.args.frameId, call.args.ref);
      if (!gate.ok) {
        const detail = `refused: ${gate.reason}`;
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: "click", outcome: "refused", detail });
        continue;
      }
      try {
        const frameField = frameFieldFor(snapshot, call.args.frameId);
        await controlGate.adapter.click(gate.locator, frameField.frame);
        steps.push({
          id: nextStepId("click"),
          action: "click",
          classification: "safe",
          continuesAfterSkip: false,
          target: gate.locator,
          ...frameField,
        });
        const detail = `clicked ref "${call.args.ref}" in frame "${call.args.frameId}"`;
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: "click", outcome: "executed", detail });
      } catch (cause) {
        const detail = `refused: ${(cause as LocatorResolutionError).message}`;
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: "click", outcome: "refused", detail });
      }
      continue;
    }

    if (call.tool === "type" || call.tool === "select") {
      const inputName = call.args.inputName;
      const inputSpec = goal.inputs[inputName];
      if (!inputSpec) {
        const detail = `refused: "${inputName}" is not a declared input`;
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: call.tool, outcome: "refused", detail });
        continue;
      }
      const gate = resolveAndGate(snapshot, call.args.frameId, call.args.ref);
      if (!gate.ok) {
        const detail = `refused: ${gate.reason}`;
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: call.tool, outcome: "refused", detail });
        continue;
      }
      try {
        const frameField = frameFieldFor(snapshot, call.args.frameId);
        if (call.tool === "type") {
          await controlGate.adapter.type(gate.locator, inputSpec.value, frameField.frame);
        } else {
          await controlGate.adapter.select(gate.locator, inputSpec.value, frameField.frame);
        }
        if (inputSpec.sensitivity === "secret") {
          redactedRefs.add(refKey(call.args.frameId, call.args.ref));
        }
        knownValues.push({ value: inputSpec.value, sensitivity: inputSpec.sensitivity });
        steps.push({
          id: nextStepId(call.tool),
          action: call.tool,
          classification: "safe",
          continuesAfterSkip: false,
          target: gate.locator,
          value: { fromInput: inputName },
          ...frameField,
        });
        const detail = `${call.tool === "type" ? "typed" : "selected"} the declared input "${inputName}" into ref "${call.args.ref}" in frame "${call.args.frameId}"`;
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: call.tool, outcome: "executed", detail });
      } catch (cause) {
        const detail = `refused: ${(cause as LocatorResolutionError).message}`;
        modelHistory.push({ toolCall: call, result: detail });
        turnLog.push({ toolName: call.tool, outcome: "refused", detail });
      }
      continue;
    }

    // call.tool === "read"
    const outputName = call.args.outputName;
    const outputSpec = goal.outputs[outputName];
    if (!outputSpec) {
      const detail = `refused: "${outputName}" is not a declared output`;
      modelHistory.push({ toolCall: call, result: detail });
      turnLog.push({ toolName: "read", outcome: "refused", detail });
      continue;
    }
    if (writtenOutputs.has(outputName)) {
      const detail = `refused: output "${outputName}" is already written`;
      modelHistory.push({ toolCall: call, result: detail });
      turnLog.push({ toolName: "read", outcome: "refused", detail });
      continue;
    }
    const gate = resolveAndGate(snapshot, call.args.frameId, call.args.ref);
    if (!gate.ok) {
      const detail = `refused: ${gate.reason}`;
      modelHistory.push({ toolCall: call, result: detail });
      turnLog.push({ toolName: "read", outcome: "refused", detail });
      continue;
    }
    try {
      const frameField = frameFieldFor(snapshot, call.args.frameId);
      const readResult = await controlGate.adapter.read(gate.locator, frameField.frame);
      writtenOutputs.add(outputName);
      knownValues.push({ value: readResult.value, sensitivity: outputSpec.sensitivity });
      steps.push({
        id: nextStepId("read"),
        action: "read",
        classification: "safe",
        continuesAfterSkip: false,
        target: gate.locator,
        outputName,
        ...frameField,
      });
      const detail = `read into "${outputName}": ${redactForLog(readResult.value, outputSpec.sensitivity)}`;
      modelHistory.push({ toolCall: call, result: detail });
      turnLog.push({ toolName: "read", outcome: "executed", detail });
    } catch (cause) {
      const detail = `refused: ${(cause as LocatorResolutionError).message}`;
      modelHistory.push({ toolCall: call, result: detail });
      turnLog.push({ toolName: "read", outcome: "refused", detail });
    }
  }
}
