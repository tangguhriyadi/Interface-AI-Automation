import { evaluateCheckpoint } from "../adapter/matchers.js";
import { findByRef, frameRefFor, resolveRef, type Snapshot, type SnapshotNode } from "../adapter/snapshotParser.js";
import { LocatorResolutionError, type SurfaceAdapter } from "../adapter/surfaceAdapter.js";
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
import type { ToolCall } from "./tools.js";

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
const MIN_SCRUB_PATTERN_LENGTH = 7;

function valuesOfSensitivity(known: KnownValue[], sensitivities: Sensitivity[]): string[] {
  return known
    .filter((v) => sensitivities.includes(v.sensitivity) && v.value.length >= MIN_SCRUB_PATTERN_LENGTH)
    .map((v) => v.value);
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

  await adapter.goto(goal.entryPoint);

  const startedAt = Date.now();
  const steps: Step[] = [];
  const modelHistory: TurnHistoryEntry[] = [];
  const turnLog: DiscoveryTurnLogEntry[] = [];
  const writtenOutputs = new Set<string>();
  const redactedRefs = new Set<string>();
  const knownValues: KnownValue[] = [];
  const recoveriesSeen = new Set<string>();
  const appDetector = createAppDetector(appProfile, adapter);
  const allOutcomeNames = Object.keys(appProfile.outcomes);
  // No tenant-overlay concept in discovery (out of scope) — the app profile's own
  // originPattern is always the authoritative allowlist origin here, unlike replay()
  // which lets a tenant overlay's baseUrl override it.
  const allowlistOrigin = appProfile.allowlist.originPattern;
  let stepCounter = 0;
  let previousSnapshot: Snapshot | undefined;
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
    return { ...shape, turns: turnLog, recoveries: [...recoveriesSeen] } as DiscoveryResult;
  }

  function nextStepId(action: string): string {
    stepCounter += 1;
    return `${action}-${stepCounter}`;
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
    const navigationStatus = adapter.lastNavigationStatus();
    if (navigationStatus !== undefined && navigationStatus >= 500) {
      return finalize({ status: "http_error", httpStatus: navigationStatus });
    }

    const rawSnapshot = await adapter.snapshot();
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
      return finalize({
        status: "escalated",
        reason: `Recovery "${detection.ruleName}" fired repeatedly without clearing the condition — cannot safely proceed unattended.`,
      });
    }
    if (detection.kind === "recovery_action_failed") {
      return finalize({
        status: "escalated",
        reason: `Recovery "${detection.ruleName}"'s dismiss action did not resolve — cannot safely proceed unattended.`,
      });
    }

    // detection.kind === "settled" — this is the snapshot the model actually sees.
    const snapshot = detection.snapshot;
    if (previousSnapshot && snapshotsStructurallyEqual(previousSnapshot, snapshot)) {
      noOpStreak += 1;
    } else {
      noOpStreak = 0;
    }
    if (noOpStreak >= deadEndThreshold) {
      return finalize({ status: "dead_end", repeatedTurns: noOpStreak });
    }
    previousSnapshot = snapshot;

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
      turnLog.push({ toolName: "escalate", outcome: "executed", detail: call.args.reason });
      return finalize({ status: "escalated", reason: call.args.reason });
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
      const freshSnapshot = await adapter.snapshot();
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
        await adapter.click(gate.locator, frameField.frame);
        steps.push({
          id: nextStepId("click"),
          action: "click",
          classification: "safe",
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
          await adapter.type(gate.locator, inputSpec.value, frameField.frame);
        } else {
          await adapter.select(gate.locator, inputSpec.value, frameField.frame);
        }
        if (inputSpec.sensitivity === "secret") {
          redactedRefs.add(refKey(call.args.frameId, call.args.ref));
        }
        knownValues.push({ value: inputSpec.value, sensitivity: inputSpec.sensitivity });
        steps.push({
          id: nextStepId(call.tool),
          action: call.tool,
          classification: "safe",
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
      const readResult = await adapter.read(gate.locator, frameField.frame);
      writtenOutputs.add(outputName);
      knownValues.push({ value: readResult.value, sensitivity: outputSpec.sensitivity });
      steps.push({
        id: nextStepId("read"),
        action: "read",
        classification: "safe",
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
