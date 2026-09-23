import { describe, expect, it } from "vitest";
import { StepSchema } from "../../schema/step.js";

const roleTarget = [{ kind: "role" as const, role: "button", name: "Search", rationale: "primary" }];

describe("StepSchema", () => {
  it("accepts a click step with no value", () => {
    const result = StepSchema.safeParse({
      id: "click-search",
      action: "click",
      classification: "safe",
      target: roleTarget,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a type step whose value references a declared input", () => {
    const result = StepSchema.safeParse({
      id: "type-member-id",
      action: "type",
      classification: "safe",
      target: roleTarget,
      value: { fromInput: "memberId" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a type step with a literal value instead of fromInput", () => {
    const result = StepSchema.safeParse({
      id: "type-member-id",
      action: "type",
      classification: "safe",
      target: roleTarget,
      value: { literal: "10001" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a read step with an outputName", () => {
    const result = StepSchema.safeParse({
      id: "read-balance",
      action: "read",
      classification: "safe",
      target: roleTarget,
      outputName: "savingsBalance",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a read step missing outputName", () => {
    const result = StepSchema.safeParse({
      id: "read-balance",
      action: "read",
      classification: "safe",
      target: roleTarget,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid classification", () => {
    const result = StepSchema.safeParse({
      id: "click-search",
      action: "click",
      classification: "dangerous",
      target: roleTarget,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a structured frame reference", () => {
    const result = StepSchema.safeParse({
      id: "read-balance",
      action: "read",
      classification: "safe",
      frame: { by: "title", value: "Account Balance" },
      target: roleTarget,
      outputName: "savingsBalance",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a frame given as a raw CSS selector string", () => {
    const result = StepSchema.safeParse({
      id: "read-balance",
      action: "read",
      classification: "safe",
      frame: 'iframe[title="Account Balance"]',
      target: roleTarget,
      outputName: "savingsBalance",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a per-step timeout override", () => {
    const result = StepSchema.safeParse({
      id: "click-search",
      action: "click",
      classification: "safe",
      target: roleTarget,
      timeoutMs: 8000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-positive timeout override", () => {
    const result = StepSchema.safeParse({
      id: "click-search",
      action: "click",
      classification: "safe",
      target: roleTarget,
      timeoutMs: 0,
    });
    expect(result.success).toBe(false);
  });
});
