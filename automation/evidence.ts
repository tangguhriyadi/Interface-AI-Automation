import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SurfaceAdapter } from "./adapter/surfaceAdapter.js";
import { MIN_SCRUB_PATTERN_LENGTH, type DiscoveryResult } from "./discovery/discover.js";
import { redactForLog, scrubSecretValues } from "./executor/redact.js";
import type { ReplayResult, StepRecord } from "./executor/replay.js";
import type { CapabilityArtifact, Sensitivity } from "./schema/capability.js";

/**
 * Evidence is read by a human reviewer, not just by code — every run writes
 * both a machine-parseable JSONL step/turn log AND a small `summary.json`
 * a reviewer can read directly: the goal, the result status, step/turn
 * count, duration, which recoveries fired, and (for replay) which locator
 * strategy matched per step.
 *
 * Kept deliberately outside `replay()`/`discover()` themselves — both stay
 * pure functions with no filesystem I/O of their own, callable and testable
 * without ever touching disk; this module is called explicitly, after a run
 * completes, by whatever drives it.
 */

/**
 * `/automation` is its own npm project and every command runs from inside
 * it — a `process.cwd()`-relative default would land evidence in
 * `automation/evidence/`, not the repo-root `/evidence/` CLAUDE.md's
 * Repository layout requires. Derived from this module's own location
 * instead, so the default is correct regardless of where the process was
 * started from: this file lives at `automation/evidence.ts`, and the
 * repo-root evidence directory is one level up from `automation/`.
 */
const REPO_ROOT_EVIDENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "evidence");

export interface WriteEvidenceOptions {
  /** Base evidence directory — defaults to the repo-root `/evidence/` (CLAUDE.md's Repository layout), resolved from this module's own location, not the current working directory. */
  baseDir?: string;
  /** Injectable for deterministic tests; defaults to the real clock. */
  now?: () => Date;
}

export interface WrittenEvidence {
  dir: string;
  jsonlPath: string;
  summaryPath: string;
  screenshotPath?: string;
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function writeEvidenceFiles(
  dir: string,
  jsonlLines: string[],
  summary: unknown,
  screenshot: Buffer | undefined,
): Promise<WrittenEvidence> {
  await mkdir(dir, { recursive: true });
  const jsonlPath = join(dir, "steps.jsonl");
  const summaryPath = join(dir, "summary.json");
  await writeFile(jsonlPath, jsonlLines.map((line) => `${line}\n`).join(""), "utf-8");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  const written: WrittenEvidence = { dir, jsonlPath, summaryPath };
  if (screenshot) {
    const screenshotPath = join(dir, "screenshot.png");
    await writeFile(screenshotPath, screenshot);
    written.screenshotPath = screenshotPath;
  }
  return written;
}

/** A value only counts as a scrub pattern once it clears the same minimum length discover.ts's own checkpoint safety net uses — short values are excluded everywhere for the same reason: an incidental match (a short status word) would otherwise redact unrelated content. */
function isScrubWorthy(value: string, sensitivity: Sensitivity): boolean {
  return (sensitivity === "secret" || sensitivity === "pii") && value.length >= MIN_SCRUB_PATTERN_LENGTH;
}

/** A screenshot is worth capturing whenever the run didn't reach a clean, expected end state — a reviewer looking at anything else benefits from seeing what the page actually looked like. */
function needsScreenshot(status: string): boolean {
  return status !== "success" && status !== "done" && status !== "business_outcome";
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

function replayScrubValues(capability: CapabilityArtifact, inputs: Record<string, string>, result: ReplayResult): string[] {
  const values: string[] = [];
  for (const [name, spec] of Object.entries(capability.inputs)) {
    const value = inputs[name];
    if (value !== undefined && isScrubWorthy(value, spec.sensitivity)) {
      values.push(value);
    }
  }
  if (result.status === "success") {
    for (const [name, spec] of Object.entries(capability.outputs)) {
      const value = result.outputs[name];
      if (value !== undefined && isScrubWorthy(value, spec.sensitivity)) {
        values.push(value);
      }
    }
  }
  return values;
}

/**
 * `attemptedValue`/`observedValue` are already redacted by declared
 * sensitivity at the point `replay()` constructs each `StepRecord` — this
 * is the value-based scrub applied as a second, independent layer on top
 * (per-instruction: apply it to everything written to evidence, not just
 * the compact view), not the primary defense for these two fields.
 */
function scrubStep(step: StepRecord, scrub: (text: string) => string): Record<string, unknown> {
  return {
    ...step,
    ...(step.attemptedValue !== undefined ? { attemptedValue: scrub(step.attemptedValue) } : {}),
    ...(step.observedValue !== undefined ? { observedValue: scrub(step.observedValue) } : {}),
  };
}

function replayStatusDetail(
  result: ReplayResult,
  capability: CapabilityArtifact,
  scrub: (text: string) => string,
): Record<string, unknown> {
  switch (result.status) {
    case "success":
      // Unlike the in-memory result — deliberately unredacted for the caller, "that's
      // what the caller asked for" — evidence must never persist a raw PII/secret output
      // value (CLAUDE.md: "Never persist ... into artifacts, logs, or evidence"). Redacted
      // here by each output's *declared* sensitivity, unconditionally: this is a known
      // field with a known sensitivity, not free text, so it isn't length-gated the way
      // the scrub list is.
      return {
        outputs: Object.fromEntries(
          Object.entries(result.outputs).map(([name, value]) => [
            name,
            redactForLog(value, capability.outputs[name]?.sensitivity ?? "pii"),
          ]),
        ),
      };
    case "business_outcome":
      return { outcome: result.outcome };
    case "escalated":
      return { reason: scrub(result.reason) };
    case "failed":
      return {
        stepId: result.stepId,
        errorClass: result.errorClass,
        expected: scrub(result.expected),
        observed: scrub(result.observed),
      };
  }
}

/** Writes a completed `replay()` run's evidence: `steps.jsonl` (one StepRecord per line) and a human-readable `summary.json`, under `evidence/replay/<timestamp>-<capabilityId>/`. A screenshot is captured only when the run didn't end in a clean success. */
export async function writeReplayEvidence(
  capability: CapabilityArtifact,
  inputs: Record<string, string>,
  result: ReplayResult,
  adapter: SurfaceAdapter,
  options: WriteEvidenceOptions = {},
): Promise<WrittenEvidence> {
  const now = (options.now ?? (() => new Date()))();
  const dir = join(options.baseDir ?? REPO_ROOT_EVIDENCE_DIR, "replay", `${timestampSlug(now)}-${capability.capabilityId}`);

  const scrubValues = replayScrubValues(capability, inputs, result);
  const scrub = (text: string) => scrubSecretValues(text, scrubValues);

  const jsonlLines = result.steps.map((step) => JSON.stringify(scrubStep(step, scrub)));

  const summary = {
    runKind: "replay" as const,
    capabilityId: capability.capabilityId,
    version: capability.version,
    appId: capability.appId,
    writtenAt: now.toISOString(),
    durationMs: result.durationMs,
    status: result.status,
    stepCount: result.steps.length,
    steps: result.steps.map((s) => ({
      stepId: s.stepId,
      action: s.action,
      outcome: s.outcome,
      matchedStrategy: s.matchedStrategy,
      durationMs: s.durationMs,
    })),
    recoveries: result.recoveries,
    ...replayStatusDetail(result, capability, scrub),
  };

  const screenshot = needsScreenshot(result.status) ? await adapter.screenshot() : undefined;
  return writeEvidenceFiles(dir, jsonlLines, summary, screenshot);
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

function discoveryStatusDetail(result: DiscoveryResult, scrub: (text: string) => string): Record<string, unknown> {
  switch (result.status) {
    case "done":
      return { capabilityId: result.capability.capabilityId, outputNames: Object.keys(result.capability.outputs) };
    case "max_steps":
      return { stepsTaken: result.stepsTaken };
    case "timeout":
      return { elapsedMs: result.elapsedMs };
    case "dead_end":
      return { repeatedTurns: result.repeatedTurns };
    case "escalated":
      // The model's own free text, and the specific case that motivated applying the
      // value-based scrub to evidence in the first place: it may quote page content,
      // including something like a member's name.
      return { reason: scrub(result.reason) };
    case "business_outcome":
      return { outcome: result.outcome };
    case "session_expired":
      return {};
    case "allowlist_violation":
      return { url: scrub(result.url) };
    case "http_error":
      return { httpStatus: result.httpStatus };
  }
}

export interface DiscoveryGoalSummary {
  description: string;
  entryPoint: string;
}

/** Writes a completed `discover()` run's evidence: `steps.jsonl` (one turn per line) and a human-readable `summary.json`, under `evidence/discovery/<timestamp>/` — discovery has no stable id to name the folder by until it succeeds. A screenshot is captured only when the run didn't end in `done`. */
export async function writeDiscoveryEvidence(
  goal: DiscoveryGoalSummary,
  result: DiscoveryResult,
  adapter: SurfaceAdapter,
  options: WriteEvidenceOptions = {},
): Promise<WrittenEvidence> {
  const now = (options.now ?? (() => new Date()))();
  const dir = join(options.baseDir ?? REPO_ROOT_EVIDENCE_DIR, "discovery", timestampSlug(now));

  const scrub = (text: string) => scrubSecretValues(text, result.knownSensitiveValues);

  const jsonlLines = result.turns.map((turn) =>
    JSON.stringify({ toolName: turn.toolName, outcome: turn.outcome, detail: scrub(turn.detail) }),
  );

  const summary = {
    runKind: "discovery" as const,
    goal: goal.description,
    entryPoint: goal.entryPoint,
    writtenAt: now.toISOString(),
    durationMs: result.durationMs,
    status: result.status,
    turnCount: result.turns.length,
    recoveries: result.recoveries,
    ...discoveryStatusDetail(result, scrub),
  };

  const screenshot = needsScreenshot(result.status) ? await adapter.screenshot() : undefined;
  return writeEvidenceFiles(dir, jsonlLines, summary, screenshot);
}
