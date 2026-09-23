import { describe, expect, it } from "vitest";
import { buildInputsSchema, CapabilityArtifactSchema } from "../../schema/capability.js";

const validArtifact = {
  schemaVersion: "1.0.0",
  capabilityId: "lookup_member_savings_balance",
  version: "1.0.0",
  appId: "fake-credit-union-console",
  entryPoint: "/login",
  inputs: {
    memberId: { type: "string", sensitivity: "pii" },
    username: { type: "string", sensitivity: "none" },
    password: { type: "string", sensitivity: "secret" },
  },
  outputs: {
    savingsBalance: { type: "string", sensitivity: "pii" },
  },
  steps: [
    {
      id: "click-search",
      action: "click",
      classification: "safe",
      target: [{ kind: "role", role: "button", name: "Search", rationale: "primary" }],
    },
    {
      id: "read-balance",
      action: "read",
      classification: "safe",
      target: [{ kind: "structural", description: "row-header cell", rowHeader: "Savings", rationale: "only distinguishing signal" }],
      outputName: "savingsBalance",
    },
  ],
  successCheckpoint: { kind: "heading_starts_with", text: "Member:" },
  businessOutcomes: ["member_not_found", "access_denied"],
};

describe("CapabilityArtifactSchema", () => {
  it("accepts a complete, valid artifact", () => {
    const result = CapabilityArtifactSchema.safeParse(validArtifact);
    expect(result.success).toBe(true);
  });

  it("rejects an artifact missing schemaVersion", () => {
    const { schemaVersion: _schemaVersion, ...rest } = validArtifact;
    const result = CapabilityArtifactSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects an artifact missing entryPoint", () => {
    const { entryPoint: _entryPoint, ...rest } = validArtifact;
    const result = CapabilityArtifactSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects an artifact missing successCheckpoint", () => {
    const { successCheckpoint: _successCheckpoint, ...rest } = validArtifact;
    const result = CapabilityArtifactSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects an artifact with zero steps", () => {
    const result = CapabilityArtifactSchema.safeParse({ ...validArtifact, steps: [] });
    expect(result.success).toBe(false);
  });

  it("defaults businessOutcomes to an empty array when omitted", () => {
    const { businessOutcomes: _businessOutcomes, ...rest } = validArtifact;
    const result = CapabilityArtifactSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.businessOutcomes).toEqual([]);
    }
  });

  it("rejects a step whose fromInput names an undeclared input (typo)", () => {
    const result = CapabilityArtifactSchema.safeParse({
      ...validArtifact,
      steps: [
        {
          id: "type-member-id",
          action: "type",
          classification: "safe",
          target: [{ kind: "role", role: "textbox", name: "Member ID", rationale: "labeled input" }],
          value: { fromInput: "meberId" },
        },
        validArtifact.steps[1],
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a read step whose outputName names an undeclared output (typo)", () => {
    const result = CapabilityArtifactSchema.safeParse({
      ...validArtifact,
      steps: [
        {
          id: "read-balance",
          action: "read",
          classification: "safe",
          target: [{ kind: "structural", description: "row-header cell", rowHeader: "Savings", rationale: "x" }],
          outputName: "savingsBalence",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an artifact whose declared output is never written by a read step", () => {
    const result = CapabilityArtifactSchema.safeParse({
      ...validArtifact,
      steps: [validArtifact.steps[0]],
      outputs: { savingsBalance: { type: "string", sensitivity: "pii" }, checkingBalance: { type: "string", sensitivity: "pii" } },
    });
    expect(result.success).toBe(false);
  });

  it("defaults approvalState to draft when omitted", () => {
    const result = CapabilityArtifactSchema.safeParse(validArtifact);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approvalState).toBe("draft");
    }
  });

  it("accepts an explicitly approved artifact", () => {
    const result = CapabilityArtifactSchema.safeParse({ ...validArtifact, approvalState: "approved" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approvalState).toBe("approved");
    }
  });

  it("rejects an approvalState outside draft/approved", () => {
    const result = CapabilityArtifactSchema.safeParse({ ...validArtifact, approvalState: "reviewed" });
    expect(result.success).toBe(false);
  });
});

describe("buildInputsSchema (decision 7: permissive by construction)", () => {
  const schema = buildInputsSchema({
    memberId: { type: "string", sensitivity: "pii" },
  });

  it("accepts a well-formed numeric-looking value", () => {
    expect(schema.safeParse({ memberId: "10001" }).success).toBe(true);
  });

  it("accepts a non-numeric value — the app, not the schema, must reject it", () => {
    expect(schema.safeParse({ memberId: "abc" }).success).toBe(true);
  });

  it("accepts an empty string — the app, not the schema, must reject it", () => {
    expect(schema.safeParse({ memberId: "" }).success).toBe(true);
  });

  it("throws-equivalent (safeParse fails) for a missing input", () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("throws-equivalent (safeParse fails) for the wrong JS type", () => {
    expect(schema.safeParse({ memberId: 10001 }).success).toBe(false);
  });
});
