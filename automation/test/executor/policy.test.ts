import { describe, expect, it } from "vitest";
import type { AppProfile } from "../../schema/appProfile.js";
import { isIrreversibleControl, isWithinAllowlist } from "../../executor/policy.js";

const allowlist = { originPattern: "http://localhost:4000", routePrefixes: ["/login", "/search"] };

describe("isWithinAllowlist", () => {
  it("accepts a URL within the origin and an allowed route prefix", () => {
    expect(isWithinAllowlist(allowlist, "http://localhost:4000", "http://localhost:4000/search?id=1")).toBe(true);
  });

  it("rejects a URL on the origin but outside every route prefix", () => {
    expect(isWithinAllowlist(allowlist, "http://localhost:4000", "http://localhost:4000/admin")).toBe(false);
  });

  it("rejects a URL off the given origin, even if the path would otherwise match", () => {
    expect(isWithinAllowlist(allowlist, "http://localhost:4000", "http://evil.example.com/search")).toBe(false);
  });

  it("uses the given origin, not the allowlist's own originPattern — the tenant-overlay case", () => {
    expect(isWithinAllowlist(allowlist, "http://localhost:5000", "http://localhost:5000/search")).toBe(true);
    expect(isWithinAllowlist(allowlist, "http://localhost:5000", "http://localhost:4000/search")).toBe(false);
  });
});

describe("isIrreversibleControl", () => {
  const profile: AppProfile = {
    schemaVersion: "1.0.0",
    appId: "test-app",
    outcomes: {},
    recoveries: [],
    irreversibleControls: [{ role: "button", name: "Submit Loan Application", exact: true }],
    allowlist,
  };

  it("matches an exact role+name declared irreversible", () => {
    expect(isIrreversibleControl(profile, "button", "Submit Loan Application")).toBe(true);
  });

  it("does not match a different role with the same name", () => {
    expect(isIrreversibleControl(profile, "link", "Submit Loan Application")).toBe(false);
  });

  it("does not match an undeclared control", () => {
    expect(isIrreversibleControl(profile, "button", "Search")).toBe(false);
  });

  it("defaults to an empty list — nothing is irreversible until a human declares it", () => {
    const bare: AppProfile = { ...profile, irreversibleControls: [] };
    expect(isIrreversibleControl(bare, "button", "Submit Loan Application")).toBe(false);
  });

  it("matches by substring when exact is false", () => {
    const substringProfile: AppProfile = {
      ...profile,
      irreversibleControls: [{ role: "button", name: "Delete", exact: false }],
    };
    expect(isIrreversibleControl(substringProfile, "button", "Delete Account")).toBe(true);
  });
});
