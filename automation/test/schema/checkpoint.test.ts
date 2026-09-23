import { describe, expect, it } from "vitest";
import { CheckpointSchema } from "../../schema/checkpoint.js";

const accountBalanceFrame = { by: "title" as const, value: "Account Balance" };

describe("CheckpointSchema", () => {
  it("accepts heading_starts_with", () => {
    const result = CheckpointSchema.safeParse({ kind: "heading_starts_with", text: "Member:" });
    expect(result.success).toBe(true);
  });

  it("accepts frame_present with a structured frame reference", () => {
    const result = CheckpointSchema.safeParse({
      kind: "frame_present",
      frame: accountBalanceFrame,
    });
    expect(result.success).toBe(true);
  });

  it("accepts text_contains with an explicit frame", () => {
    const result = CheckpointSchema.safeParse({
      kind: "text_contains",
      text: "Savings",
      frame: accountBalanceFrame,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const result = CheckpointSchema.safeParse({ kind: "heading_equals", text: "Member: Elena Cho" });
    expect(result.success).toBe(false);
  });

  it("rejects frame_present without a frame", () => {
    const result = CheckpointSchema.safeParse({ kind: "frame_present" });
    expect(result.success).toBe(false);
  });

  it("rejects a frame given as a raw CSS selector string", () => {
    const result = CheckpointSchema.safeParse({
      kind: "frame_present",
      frame: 'iframe[title="Account Balance"]',
    });
    expect(result.success).toBe(false);
  });
});
