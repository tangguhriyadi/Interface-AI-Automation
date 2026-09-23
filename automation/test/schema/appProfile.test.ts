import { describe, expect, it } from "vitest";
import { AppProfileSchema, DetectorShapeSchema, IrreversibleControlSchema } from "../../schema/appProfile.js";

const validProfile = {
  schemaVersion: "1.0.0",
  appId: "fake-credit-union-console",
  outcomes: {
    member_not_found: {
      name: "member_not_found",
      shapes: [{ headingEquals: "Member Not Found", roleAlertContains: "No member matches" }],
    },
    invalid_input: {
      name: "invalid_input",
      shapes: [
        { headingEquals: "Invalid Input", textContains: "must contain only digits" },
        { headingEquals: "Member Search", roleAlertContains: "Invalid Input: Member ID is required" },
      ],
    },
  },
  recoveries: [
    {
      name: "maintenance_interstitial",
      detect: [{ headingEquals: "System Maintenance", textContains: "scheduled maintenance" }],
      action: {
        kind: "dismiss",
        locator: [{ kind: "role", role: "button", name: "Dismiss", rationale: "the only control on the page" }],
      },
    },
  ],
  allowlist: {
    originPattern: "http://localhost:4000",
    routePrefixes: ["/login", "/search", "/members"],
  },
};

describe("DetectorShapeSchema", () => {
  it("accepts a shape with a single signal", () => {
    expect(DetectorShapeSchema.safeParse({ headingEquals: "Access Denied" }).success).toBe(true);
  });

  it("accepts a shape scoped to a structured frame reference", () => {
    const result = DetectorShapeSchema.safeParse({
      frame: { by: "title", value: "Account Balance" },
      textContains: "Savings",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a shape whose frame is a raw CSS selector string", () => {
    const result = DetectorShapeSchema.safeParse({
      frame: 'iframe[title="Account Balance"]',
      textContains: "Savings",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a shape with zero signals", () => {
    expect(DetectorShapeSchema.safeParse({ frame: "iframe" }).success).toBe(false);
  });
});

describe("AppProfileSchema", () => {
  it("accepts a complete, valid profile — including the two-shape invalid_input outcome", () => {
    const result = AppProfileSchema.safeParse(validProfile);
    expect(result.success).toBe(true);
  });

  it("rejects an allowlist with no route prefixes", () => {
    const result = AppProfileSchema.safeParse({
      ...validProfile,
      allowlist: { originPattern: "http://localhost:4000", routePrefixes: [] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a wait recovery action", () => {
    const result = AppProfileSchema.safeParse({
      ...validProfile,
      recoveries: [
        {
          name: "slow_load",
          detect: [{ textContains: "loading" }],
          action: { kind: "wait", timeoutMs: 8000 },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a dismiss recovery action missing its locator", () => {
    const result = AppProfileSchema.safeParse({
      ...validProfile,
      recoveries: [
        {
          name: "maintenance_interstitial",
          detect: [{ headingEquals: "System Maintenance" }],
          action: { kind: "dismiss" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("defaults recoveries to an empty array when omitted", () => {
    const { recoveries: _recoveries, ...rest } = validProfile;
    const result = AppProfileSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recoveries).toEqual([]);
    }
  });

  it("defaults irreversibleControls to an empty array when omitted", () => {
    const result = AppProfileSchema.safeParse(validProfile);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.irreversibleControls).toEqual([]);
    }
  });

  it("accepts a profile declaring irreversible controls", () => {
    const result = AppProfileSchema.safeParse({
      ...validProfile,
      irreversibleControls: [{ role: "button", name: "Submit Loan Application", exact: true }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.irreversibleControls).toEqual([
        { role: "button", name: "Submit Loan Application", exact: true },
      ]);
    }
  });

  it("defaults an irreversible control's exact to true when omitted", () => {
    const result = AppProfileSchema.safeParse({
      ...validProfile,
      irreversibleControls: [{ role: "button", name: "Submit Loan Application" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.irreversibleControls[0]?.exact).toBe(true);
    }
  });
});

describe("IrreversibleControlSchema", () => {
  it("rejects a control missing a role", () => {
    const result = IrreversibleControlSchema.safeParse({ name: "Submit Loan Application" });
    expect(result.success).toBe(false);
  });

  it("rejects a control missing a name", () => {
    const result = IrreversibleControlSchema.safeParse({ role: "button" });
    expect(result.success).toBe(false);
  });
});
