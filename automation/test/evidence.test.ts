import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeDiscoveryEvidence, writeReplayEvidence } from "../evidence.js";
import type { DiscoveryResult } from "../discovery/discover.js";
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
    };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    expect(written.screenshotPath).toBeDefined();
    expect(adapter.screenshotCallCount).toBe(1);
  });

  it("does not capture a screenshot for business_outcome — a recognized answer, not a problem", async () => {
    const result: ReplayResult = { status: "business_outcome", outcome: "member_not_found", steps: [], recoveries: [], durationMs: 5 };
    const adapter = new FakeAdapter();
    const written = await writeReplayEvidence(capability, inputs, result, adapter, { baseDir });

    expect(written.screenshotPath).toBeUndefined();
    expect(adapter.screenshotCallCount).toBe(0);
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

describe("the default evidence directory is resolved relative to the repo root, not process.cwd()", () => {
  it("still lands under repo-root /evidence/ when the process was started from somewhere else entirely (replay)", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "cwd-elsewhere-"));
    const originalCwd = process.cwd();
    let written;
    process.chdir(elsewhere);
    try {
      const result: ReplayResult = { status: "business_outcome", outcome: "not_found", steps: [], recoveries: [], durationMs: 1 };
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
