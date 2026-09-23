import { describe, expect, it } from "vitest";
import { FrameRefSchema } from "../../schema/frame.js";

describe("FrameRefSchema", () => {
  it("accepts a title reference", () => {
    expect(FrameRefSchema.safeParse({ by: "title", value: "Account Balance" }).success).toBe(true);
  });

  it("accepts a name reference", () => {
    expect(FrameRefSchema.safeParse({ by: "name", value: "balancePanel" }).success).toBe(true);
  });

  it("accepts a url reference", () => {
    expect(FrameRefSchema.safeParse({ by: "url", value: "/members/10001/balance" }).success).toBe(true);
  });

  it("rejects an unknown 'by' strategy", () => {
    expect(FrameRefSchema.safeParse({ by: "selector", value: "iframe.balance" }).success).toBe(false);
  });

  it("rejects a bare string (the old raw-selector shape)", () => {
    expect(FrameRefSchema.safeParse('iframe[title="Account Balance"]').success).toBe(false);
  });
});
