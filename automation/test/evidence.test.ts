import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDiscoveryEvidence, writeReplayEvidence } from "../evidence.js";
import type { DiscoveryResult } from "../discovery/discover.js";
import type { InterventionRecord } from "../escalation.js";
import type { ReplayResult } from "../executor/replay.js";
import type { CapabilityArtifact } from "../schema/capability.js";
import { FakeAdapter } from "./support/fakeAdapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives at automation/test/evidence.test.ts — two levels up is the repo root.
const REPO_ROOT_EVIDENCE_DIR = join(__dirname, "..", "..", "evidence");

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "evidence-test-"));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const capability: CapabilityArtifact = {
  schemaVersion: "1.0.0",
  capabilityId: "test_capability",
  version: "1.0.0",
  appId: "test-app",
  entryPoint: "/login",
  inputs: {
    username: { type: "string", sensitivity: "none" },
    password: { type: "string", sensitivity: "secret" },
  },
  outputs: { balance: { type: "string", sensitivity: "pii" } },
  steps: [
    {
      id: "type-password",
      action: "type",
      classification: "safe",
      continuesAfterSkip: false,
      target: [{ kind: "role", role: "textbox", name: "Password", exact: true, rationale: "x" }],
      value: { fromInput: "password" },
    },
    {
      id: "read-balance",
      action: "read",
      classification: "safe",
      continuesAfterSkip: false,
      target: [{ kind: "role", role: "cell", name: "Balance", exact: true, rationale: "x" }],
      outputName: "balance",
    },
  ],
  successCheckpoint: { kind: "heading_starts_with", text: "Detail" },
  businessOutcomes: [],
  approvalState: "approved",
};

const inputs = { username: "teller", password: "hunter2-secret" };

function buildIntervention(overrides: Partial<InterventionRecord["request"]> = {}): InterventionRecord {
  return {
    request: {
      kind: "irreversible_action",
      runKind: "replay",
      subject: "test_capability",
      location: "open-account",
      reason: "Step is irreversible; escalating.",
      url: "http://localhost/detail",
      screenshot: Buffer.from("fake-png-bytes-for-the-intervention"),
      ...overrides,
    },
    decision: { signal: "performed" },
    raisedAt: "2026-01-01T00:00:00.000Z",
    resumedAt: "2026-01-01T00:00:05.000Z",
  };
}

describe("writeReplayEvidence", () => {
  it("writes a redacted JSONL + human-readable summary for a successful run, no screenshot", async () => {
    const result: ReplayResult = {
      status: "success",
      outputs: { balance: "$1,234.56" },
      steps: [
        {
          stepId: "type-password",
          action: "type",
          matchedStrategy: "role",
          outcome: "ok",
          durationMs: 12,
          recoveriesFired: [],
          attemptedValue: "[REDACTED:secret]",
        },
        {
          stepId: "read-balance",
          action: "read",
          matchedStrategy: "role",
          outcome: "ok",
          durationMs: 8,
          recoveriesFired: [],
          observedValue: "[REDACTED:pii]",
        },
      ],
      recoveries: [],
      durationMs: 1234,
      interventions: [],
    };

    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, {
      baseDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(written.screenshotPath).toBeUndefined();
    expect(adapter.screenshotCallCount).toBe(0);

    const jsonl = await readFile(written.jsonlPath, "utf-8");
    expect(jsonl).not.toContain("hunter2-secret");
    expect(jsonl.trim().split("\n")).toHaveLength(2);

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary).toMatchObject({
      runKind: "replay",
      capabilityId: "test_capability",
      status: "success",
      stepCount: 2,
      durationMs: 1234,
      recoveries: [],
    });
    expect(summary.steps).toEqual([
      { stepId: "type-password", action: "type", outcome: "ok", matchedStrategy: "role", durationMs: 12 },
      { stepId: "read-balance", action: "read", outcome: "ok", matchedStrategy: "role", durationMs: 8 },
    ]);
    // "What input produced this?" — a none-sensitivity input's literal value is genuinely
    // useful and shows as-is; a secret input's value stays exactly as hidden as it already
    // is everywhere else in evidence, redacted per the same existing rule.
    expect(summary.inputs).toEqual({
      username: { sensitivity: "none", value: "teller" },
      password: { sensitivity: "secret", value: "[REDACTED:secret]" },
    });
    // The raw output value is never persisted to evidence, even though `result.outputs`
    // itself stayed unredacted for the in-memory caller — the whole point of "that's what
    // the caller asked for" only applies to the direct result, not what lands on disk.
    expect(summary.outputs.balance).toBe("[REDACTED:pii]");
    expect(result.outputs.balance).toBe("$1,234.56");
  });

  it("scrubs a secret input value out of a free-text field via the value-based layer, even though field-based redaction already covers the common case", async () => {
    // Hand-built to exercise the scrub layer directly: a `failed` result whose diagnostic
    // text happens to quote the raw secret — proving the second, independent layer catches
    // it even in a shape the primary (field-based) redaction wasn't specifically written for.
    const result: ReplayResult = {
      status: "failed",
      stepId: "type-password",
      expected: "the password field to accept the value",
      observed: 'the page rejected the typed value "hunter2-secret" as too weak',
      errorClass: "locator_not_found",
      steps: [],
      recoveries: [],
      durationMs: 50,
      interventions: [],
    };

    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary.observed).not.toContain("hunter2-secret");
    expect(summary.observed).toContain("[REDACTED:secret]");
  });

  it("captures a screenshot for a non-success status", async () => {
    const result: ReplayResult = {
      status: "escalated",
      reason: "Step is irreversible.",
      steps: [],
      recoveries: [],
      durationMs: 5,
      interventions: [],
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    expect(written.screenshotPath).toBeDefined();
    expect(adapter.screenshotCallCount).toBe(1);
  });

  it("does not capture a screenshot for business_outcome — a recognized answer, not a problem", async () => {
    const result: ReplayResult = {
      status: "business_outcome",
      outcome: "member_not_found",
      steps: [],
      recoveries: [],
      durationMs: 5,
      interventions: [],
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    expect(written.screenshotPath).toBeUndefined();
    expect(adapter.screenshotCallCount).toBe(0);
  });
});

describe("writeReplayEvidence — intervention screenshots (Phase 4)", () => {
  it("writes each intervention's own screenshot, named so raw page content is obvious at a glance — distinct from the run's own screenshot.png", async () => {
    const result: ReplayResult = {
      status: "escalated",
      reason: "Step is irreversible; escalating.",
      steps: [],
      recoveries: [],
      durationMs: 5,
      interventions: [buildIntervention(), buildIntervention({ location: "open-account", reason: "still ambiguous" })],
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    // The run's own end-of-run screenshot AND both intervention screenshots all carry the
    // same marker — a reader shouldn't have to open a file to know it holds raw page content.
    expect(written.screenshotPath).toContain(".raw-page-content.png");
    expect(written.interventionScreenshotPaths).toHaveLength(2);
    for (const path of written.interventionScreenshotPaths) {
      expect(path).toContain(".raw-page-content.png");
    }
    // Distinctly numbered, not overwriting each other.
    expect(written.interventionScreenshotPaths[0]).not.toBe(written.interventionScreenshotPaths[1]);

    const files = await readdir(written.dir);
    const rawPageContentFiles = files.filter((f) => f.endsWith(".raw-page-content.png"));
    expect(rawPageContentFiles).toHaveLength(3); // the run's own + two interventions
    // Every OTHER file in the folder (the JSONL, the summary) is conspicuously NOT in that set.
    expect(files).toContain("steps.jsonl");
    expect(files).toContain("summary.json");
    expect(rawPageContentFiles).not.toContain("steps.jsonl");
    expect(rawPageContentFiles).not.toContain("summary.json");

    const bytes = await readFile(written.interventionScreenshotPaths[0]!);
    expect(bytes.toString()).toBe("fake-png-bytes-for-the-intervention");
  });

  it("records each intervention's request/decision in summary.json, pointing at its screenshot file by name — never embedding the raw bytes", async () => {
    const result: ReplayResult = {
      status: "escalated",
      reason: "Step is irreversible; escalating.",
      steps: [],
      recoveries: [],
      durationMs: 5,
      interventions: [buildIntervention()],
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary.interventions).toHaveLength(1);
    expect(summary.interventions[0]).toMatchObject({
      kind: "irreversible_action",
      location: "open-account",
      url: "http://localhost/detail",
      decision: { signal: "performed" },
      raisedAt: "2026-01-01T00:00:00.000Z",
      resumedAt: "2026-01-01T00:00:05.000Z",
    });
    expect(summary.interventions[0].screenshotFile).toBe("intervention-1.raw-page-content.png");
    // Never the raw bytes, never even a hint of them, anywhere in the JSON.
    expect(JSON.stringify(summary)).not.toContain("fake-png-bytes-for-the-intervention");
  });

  it("also appends an intervention record to the JSONL, tagged so it's distinguishable from a StepRecord line", async () => {
    const result: ReplayResult = {
      status: "escalated",
      reason: "Step is irreversible; escalating.",
      steps: [
        {
          stepId: "click-go",
          action: "click",
          matchedStrategy: "role",
          outcome: "ok",
          durationMs: 5,
          recoveriesFired: [],
        },
      ],
      recoveries: [],
      durationMs: 5,
      interventions: [buildIntervention()],
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    const lines = (await readFile(written.jsonlPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2); // one StepRecord line, one intervention line
    expect(lines[0]).toMatchObject({ stepId: "click-go" });
    expect(lines[1]).toMatchObject({ record: "intervention", kind: "irreversible_action", decision: { signal: "performed" } });
  });

  it("scrubs a known secret value out of an intervention's reason, the same second-layer scrub every other free-text evidence field gets", async () => {
    const result: ReplayResult = {
      status: "escalated",
      reason: "escalating",
      steps: [],
      recoveries: [],
      durationMs: 5,
      // "hunter2-secret" is the capability's own declared secret input value — replay's
      // scrub-value list is built from exactly this (replayScrubValues), so a reason that
      // happens to quote it must come out redacted, exactly like `result.reason` already does.
      interventions: [buildIntervention({ reason: 'operator noted the field still shows "hunter2-secret"' })],
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary.interventions[0].reason).not.toContain("hunter2-secret");
    expect(summary.interventions[0].reason).toContain("[REDACTED:secret]");

    const jsonl = await readFile(written.jsonlPath, "utf-8");
    expect(jsonl).not.toContain("hunter2-secret");
  });

  it("writes no intervention files at all when the run had none — the common case", async () => {
    const result: ReplayResult = {
      status: "success",
      outputs: {},
      steps: [],
      recoveries: [],
      durationMs: 5,
      interventions: [],
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    expect(written.interventionScreenshotPaths).toEqual([]);
    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary.interventions).toEqual([]);
  });

  it("surfaces handledByOperator/operatorSignal directly on the step line — a reviewer shouldn't have to cross-reference interventions just to see who did what", async () => {
    const result: ReplayResult = {
      status: "success",
      outputs: {},
      steps: [
        {
          stepId: "click-confirm-and-open-account",
          action: "click",
          outcome: "ok",
          durationMs: 0,
          recoveriesFired: [],
          irreversibleExecutionAuthorized: true,
          handledByOperator: true,
          operatorSignal: "performed",
        },
      ],
      recoveries: [],
      durationMs: 5,
      interventions: [buildIntervention()],
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary.steps[0]).toMatchObject({
      stepId: "click-confirm-and-open-account",
      outcome: "ok",
      handledByOperator: true,
      operatorSignal: "performed",
    });
  });

  it("omits handledByOperator/operatorSignal entirely for a step automation ran itself — no false 'ok, but who did it?' ambiguity", async () => {
    const result: ReplayResult = {
      status: "success",
      outputs: {},
      steps: [
        { stepId: "click-search", action: "click", outcome: "ok", durationMs: 12, recoveriesFired: [], matchedStrategy: "role" },
      ],
      recoveries: [],
      durationMs: 5,
      interventions: [],
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary.steps[0]).not.toHaveProperty("handledByOperator");
    expect(summary.steps[0]).not.toHaveProperty("operatorSignal");
  });
});

describe("writeDiscoveryEvidence", () => {
  const goal = {
    description: "Look up a member's balance.",
    entryPoint: "/login",
    inputs: {
      username: { value: "teller", sensitivity: "none" as const },
      memberId: { value: "10001", sensitivity: "pii" as const },
    },
  };

  it("scrubs a member name quoted in the model's own escalate reason", async () => {
    const result: DiscoveryResult = {
      status: "escalated",
      reason: 'Ambiguous: the page shows "Elena Cho" but I was not asked to confirm identity.',
      turns: [
        { toolName: "read", outcome: "executed", detail: 'read into "memberName": [REDACTED:pii]' },
        {
          toolName: "escalate",
          outcome: "executed",
          detail: 'Ambiguous: the page shows "Elena Cho" but I was not asked to confirm identity.',
        },
      ],
      recoveries: ["maintenance_interstitial"],
      durationMs: 4200,
      knownSensitiveValues: ["Elena Cho"],
      interventions: [],
    };

    const adapter = new FakeAdapter();
    const written = await writeDiscoveryEvidence(goal, result, adapter, {
      baseDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const jsonl = await readFile(written.jsonlPath, "utf-8");
    expect(jsonl).not.toContain("Elena Cho");
    expect(jsonl).toContain("[REDACTED:secret]");

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary.reason).not.toContain("Elena Cho");
    expect(summary).toMatchObject({
      runKind: "discovery",
      goal: "Look up a member's balance.",
      entryPoint: "/login",
      status: "escalated",
      turnCount: 2,
      durationMs: 4200,
      recoveries: ["maintenance_interstitial"],
    });
    expect(written.screenshotPath).toBeDefined();
  });

  it("writes a clean summary and no screenshot for a successful (done) run", async () => {
    const result: DiscoveryResult = {
      status: "done",
      capability,
      turns: [
        { toolName: "type", outcome: "executed", detail: "typed the declared input \"password\" into ref \"3\"" },
        { toolName: "read", outcome: "executed", detail: 'read into "balance": [REDACTED:pii]' },
      ],
      recoveries: [],
      durationMs: 900,
      knownSensitiveValues: [],
      interventions: [],
    };

    const adapter = new FakeAdapter();
    const written = await writeDiscoveryEvidence(goal, result, adapter, { baseDir });

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary).toMatchObject({ status: "done", capabilityId: "test_capability", turnCount: 2 });
    expect(summary.inputs).toEqual({
      username: { sensitivity: "none", value: "teller" },
      memberId: { sensitivity: "pii", value: "[REDACTED:pii]" },
    });
    expect(written.screenshotPath).toBeUndefined();
    expect(adapter.screenshotCallCount).toBe(0);
  });
});

describe("writeDiscoveryEvidence — intervention screenshots (Phase 4)", () => {
  const goal = {
    description: "Look up a member's balance.",
    entryPoint: "/login",
    inputs: {
      username: { value: "teller", sensitivity: "none" as const },
      memberId: { value: "10001", sensitivity: "pii" as const },
    },
  };

  it("writes each intervention's screenshot with the raw-page-content marker, and records it in summary.json + the JSONL", async () => {
    const result: DiscoveryResult = {
      status: "escalated",
      reason: 'reasonCode=stuck; afterTurns=2; url="http://localhost/detail"',
      turns: [{ toolName: "escalate", outcome: "executed", detail: "reasonCode=stuck" }],
      recoveries: [],
      durationMs: 900,
      knownSensitiveValues: [],
      interventions: [
        buildIntervention({ kind: "other", runKind: "discovery", subject: goal.description, location: "turn 2" }),
      ],
    };
    const adapter = new FakeAdapter();
    const written = await writeDiscoveryEvidence(goal, result, adapter, { baseDir });

    expect(written.interventionScreenshotPaths).toHaveLength(1);
    expect(written.interventionScreenshotPaths[0]).toContain(".raw-page-content.png");

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary.interventions).toHaveLength(1);
    expect(summary.interventions[0]).toMatchObject({ kind: "other", location: "turn 2", decision: { signal: "performed" } });
    expect(summary.interventions[0].screenshotFile).toBe("intervention-1.raw-page-content.png");
    expect(JSON.stringify(summary)).not.toContain("fake-png-bytes-for-the-intervention");

    const lines = (await readFile(written.jsonlPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.record === "intervention" && l.kind === "other")).toBe(true);
  });

  it("scrubs a known-sensitive value out of an intervention's reason, same as the model's own escalate reason already is", async () => {
    const result: DiscoveryResult = {
      status: "escalated",
      reason: "escalating",
      turns: [],
      recoveries: [],
      durationMs: 900,
      knownSensitiveValues: ["Elena Cho"],
      interventions: [
        buildIntervention({
          kind: "other",
          runKind: "discovery",
          subject: goal.description,
          reason: 'the operator noted the page still shows "Elena Cho"',
        }),
      ],
    };
    const adapter = new FakeAdapter();
    const written = await writeDiscoveryEvidence(goal, result, adapter, { baseDir });

    const summary = JSON.parse(await readFile(written.summaryPath, "utf-8"));
    expect(summary.interventions[0].reason).not.toContain("Elena Cho");

    const jsonl = await readFile(written.jsonlPath, "utf-8");
    expect(jsonl).not.toContain("Elena Cho");
  });
});

describe("the default evidence directory is resolved relative to the repo root, not process.cwd()", () => {
  it("still lands under repo-root /evidence/ when the process was started from somewhere else entirely (replay)", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "cwd-elsewhere-"));
    const originalCwd = process.cwd();
    let written;
    process.chdir(elsewhere);
    try {
      const result: ReplayResult = {
        status: "business_outcome",
        outcome: "not_found",
        steps: [],
        recoveries: [],
        durationMs: 1,
        interventions: [],
      };
      written = await writeReplayEvidence(capability, inputs, result, new FakeAdapter(), {
        now: () => new Date("2026-03-03T00:00:00.000Z"),
      }); // deliberately no baseDir override — this is the default under test
    } finally {
      process.chdir(originalCwd);
      await rm(elsewhere, { recursive: true, force: true });
    }

    expect(written.dir.startsWith(`${REPO_ROOT_EVIDENCE_DIR}/`) || written.dir === REPO_ROOT_EVIDENCE_DIR).toBe(true);
    expect(written.dir).not.toContain(elsewhere);
    await rm(written.dir, { recursive: true, force: true }); // this one actually landed in the real repo evidence dir
  });

  it("still lands under repo-root /evidence/ when the process was started from somewhere else entirely (discovery)", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "cwd-elsewhere-"));
    const originalCwd = process.cwd();
    let written;
    process.chdir(elsewhere);
    try {
      const result: DiscoveryResult = {
        status: "escalated",
        reason: "x",
        turns: [],
        recoveries: [],
        durationMs: 1,
        knownSensitiveValues: [],
        interventions: [],
      };
      written = await writeDiscoveryEvidence(
        { description: "x", entryPoint: "/x", inputs: {} },
        result,
        new FakeAdapter(),
        { now: () => new Date("2026-03-03T00:00:01.000Z") },
      );
    } finally {
      process.chdir(originalCwd);
      await rm(elsewhere, { recursive: true, force: true });
    }

    expect(written.dir.startsWith(`${REPO_ROOT_EVIDENCE_DIR}/`) || written.dir === REPO_ROOT_EVIDENCE_DIR).toBe(true);
    expect(written.dir).not.toContain(elsewhere);
    await rm(written.dir, { recursive: true, force: true });
  });
});
