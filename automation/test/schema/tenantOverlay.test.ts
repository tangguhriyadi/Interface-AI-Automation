import { describe, expect, it } from "vitest";
import { TenantOverlaySchema } from "../../schema/tenantOverlay.js";

describe("TenantOverlaySchema", () => {
  it("accepts a valid overlay", () => {
    const result = TenantOverlaySchema.safeParse({
      schemaVersion: "1.0.0",
      appId: "fake-credit-union-console",
      tenantId: "beta",
      baseUrl: "http://localhost:4000",
      controlNameOverrides: { "Member ID": "Account Number", Search: "Find" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-URL baseUrl", () => {
    const result = TenantOverlaySchema.safeParse({
      schemaVersion: "1.0.0",
      appId: "fake-credit-union-console",
      tenantId: "beta",
      baseUrl: "not-a-url",
      controlNameOverrides: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing tenantId", () => {
    const result = TenantOverlaySchema.safeParse({
      schemaVersion: "1.0.0",
      appId: "fake-credit-union-console",
      baseUrl: "http://localhost:4000",
      controlNameOverrides: {},
    });
    expect(result.success).toBe(false);
  });
});
