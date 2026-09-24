import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SurfaceAdapter } from "./adapter/surfaceAdapter.js";
import { MIN_SCRUB_PATTERN_LENGTH, type DiscoveryResult } from "./discovery/discover.js";
import type { InterventionRecord } from "./escalation.js";
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
 *
 * Every screenshot this module writes — the run's own end-of-run one, and
 * one per escalation handoff — carries a `.raw-page-content.png` suffix
 * (`screenshotFileName`, below). It's the one deliberately unsolved PII
 * channel in this system (CLAUDE.md's Perception Model accepts screenshots
 * as escalation context; REPORT.md's Safety section says so explicitly):
 * whatever was actually on screen, member names included, unlike every
 * other file here, which is redacted before it ever touches disk. The
 * suffix means a reviewer — or a script — can tell which files need that
 * different handling without opening any of them.
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
  /** One entry per intervention this run went through, in the same order as `summary.json`'s `interventions` array — empty unless the run was given an `onEscalation` handler. */
  interventionScreenshotPaths: string[];
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Every screenshot this module writes carries this same suffix — a marker,
 * not decoration. Unlike every other file evidence writes (JSONL, summary),
 * a screenshot is *raw page content*: whatever was actually on screen,
 * member names included, at the moment it was taken. CLAUDE.md's Perception
 * Model already accepts this for escalation context; it's an intentionally
 * unsolved PII channel (see REPORT.md's Safety section), not an oversight,
 * and naming it in the filename itself is what makes it recognizable to
 * anyone opening the folder later, without having to open the file to find
 * out — a `.png` sitting next to redacted JSON gives no such warning on its
 * own.
 */
const RAW_PAGE_CONTENT_SUFFIX = ".raw-page-content.png";

function screenshotFileName(stem: string): string {
  return `${stem}${RAW_PAGE_CONTENT_SUFFIX}`;
}

async function writeEvidenceFiles(
  dir: string,
  jsonlLines: string[],
  summary: unknown,
  screenshot: Buffer | undefined,
  interventionScreenshots: { stem: string; buffer: Buffer }[],
): Promise<WrittenEvidence> {
  await mkdir(dir, { recursive: true });
  const jsonlPath = join(dir, "steps.jsonl");
  const summaryPath = join(dir, "summary.json");
  await writeFile(jsonlPath, jsonlLines.map((line) => `${line}\n`).join(""), "utf-8");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  const written: WrittenEvidence = { dir, jsonlPath, summaryPath, interventionScreenshotPaths: [] };
  if (screenshot) {
    const screenshotPath = join(dir, screenshotFileName("screenshot"));
    await writeFile(screenshotPath, screenshot);
    written.screenshotPath = screenshotPath;
  }
  for (const { stem, buffer } of interventionScreenshots) {
    const path = join(dir, screenshotFileName(stem));
    await writeFile(path, buffer);
    written.interventionScreenshotPaths.push(path);
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

/**
 * "What input produced this?" is the first debugging question a human
 * reviewer has, and two runs of the same capability with different inputs
 * otherwise leave nearly-identical evidence with nothing distinguishing
 * them. Records every declared input's name and sensitivity, with its
 * value redacted per the *existing* rule (`redactForLog`) — a `none`
 * input's literal value is genuinely useful and shows up as-is (e.g.
 * confirming which username a run used); a `secret`/`pii` input's value
 * stays exactly as hidden as it already is everywhere else in evidence.
 */
function redactedInputsSummary(
  entries: [string, { value: string; sensitivity: Sensitivity }][],
): Record<string, { sensitivity: Sensitivity; value: string }> {
  return Object.fromEntries(
    entries.map(([name, { value, sensitivity }]) => [name, { sensitivity, value: redactForLog(value, sensitivity) }]),
  );
}

/**
 * Shared by replay and discovery evidence alike — `InterventionRecord`'s shape
 * (from escalation.ts) doesn't vary between them. Each entry's `screenshot`
 * `Buffer` is pulled out and named (`screenshotFileName`) rather than ever
 * being serialized into JSON — `InterventionRequest.screenshot`'s own doc
 * comment is explicit about this: the JSON gets a path, the pixels get their
 * own file. `reason`/`url` go through the same scrub every other free-text
 * evidence field already does — a request's `reason` is composed by the
 * driver and already redaction-safe by construction, but the value-based
 * scrub is a second, independent layer applied uniformly, same as everywhere
 * else in this module.
 */
function interventionSummaryEntries(
  interventions: InterventionRecord[],
  scrub: (text: string) => string,
): { entries: Record<string, unknown>[]; screenshots: { stem: string; buffer: Buffer }[] } {
  const entries: Record<string, unknown>[] = [];
  const screenshots: { stem: string; buffer: Buffer }[] = [];
  interventions.forEach((intervention, index) => {
    const stem = `intervention-${index + 1}`;
    screenshots.push({ stem, buffer: intervention.request.screenshot });
    entries.push({
      kind: intervention.request.kind,
      location: intervention.request.location,
      reason: scrub(intervention.request.reason),
      url: intervention.request.url !== undefined ? scrub(intervention.request.url) : undefined,
      decision: intervention.decision,
      raisedAt: intervention.raisedAt,
      resumedAt: intervention.resumedAt,
      screenshotFile: screenshotFileName(stem),
    });
  });
  return { entries, screenshots };
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
  const { entries: interventionEntries, screenshots: interventionScreenshots } = interventionSummaryEntries(
    result.interventions,
    scrub,
  );

  const jsonlLines = [
    ...result.steps.map((step) => JSON.stringify(scrubStep(step, scrub))),
    ...interventionEntries.map((entry) => JSON.stringify({ record: "intervention", ...entry })),
  ];

  const summary = {
    runKind: "replay" as const,
    capabilityId: capability.capabilityId,
    version: capability.version,
    appId: capability.appId,
    writtenAt: now.toISOString(),
    durationMs: result.durationMs,
    status: result.status,
    inputs: redactedInputsSummary(
      Object.entries(capability.inputs).map(([name, spec]) => [name, { value: inputs[name] ?? "", sensitivity: spec.sensitivity }]),
    ),
    stepCount: result.steps.length,
    steps: result.steps.map((s) => ({
      stepId: s.stepId,
      action: s.action,
      outcome: s.outcome,
      matchedStrategy: s.matchedStrategy,
      durationMs: s.durationMs,
    })),
    recoveries: result.recoveries,
    interventions: interventionEntries,
    ...replayStatusDetail(result, capability, scrub),
  };

  const screenshot = needsScreenshot(result.status) ? await adapter.screenshot() : undefined;
  return writeEvidenceFiles(dir, jsonlLines, summary, screenshot, interventionScreenshots);
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
  /** Structurally matches `DiscoveryGoal.inputs` — a caller with a real `DiscoveryGoal` can pass it directly. */
  inputs: Record<string, { value: string; sensitivity: Sensitivity }>;
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
  const { entries: interventionEntries, screenshots: interventionScreenshots } = interventionSummaryEntries(
    result.interventions,
    scrub,
  );

  const jsonlLines = [
    ...result.turns.map((turn) => JSON.stringify({ toolName: turn.toolName, outcome: turn.outcome, detail: scrub(turn.detail) })),
    ...interventionEntries.map((entry) => JSON.stringify({ record: "intervention", ...entry })),
  ];

  const summary = {
    runKind: "discovery" as const,
    goal: goal.description,
    entryPoint: goal.entryPoint,
    writtenAt: now.toISOString(),
    durationMs: result.durationMs,
    status: result.status,
    inputs: redactedInputsSummary(Object.entries(goal.inputs)),
    turnCount: result.turns.length,
    recoveries: result.recoveries,
    interventions: interventionEntries,
    ...discoveryStatusDetail(result, scrub),
  };

  const screenshot = needsScreenshot(result.status) ? await adapter.screenshot() : undefined;
  return writeEvidenceFiles(dir, jsonlLines, summary, screenshot, interventionScreenshots);
}
