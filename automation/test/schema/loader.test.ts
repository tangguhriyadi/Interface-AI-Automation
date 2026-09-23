import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadAppProfile,
  loadCapability,
  loadCapabilityWithAppProfile,
  loadTenantOverlay,
  validateBusinessOutcomesAgainstProfile,
} from "../../schema/loader.js";
import type { AppProfile } from "../../schema/appProfile.js";
import type { CapabilityArtifact } from "../../schema/capability.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "automation-loader-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(name: string, contents: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(contents), "utf-8");
  return path;
}

const validCapability = {
  schemaVersion: "1.0.0",
  capabilityId: "lookup_member_savings_balance",
  version: "1.0.0",
  appId: "fake-credit-union-console",
  entryPoint: "/login",
  inputs: { memberId: { type: "string", sensitivity: "pii" } },
  outputs: { savingsBalance: { type: "string" } },
  steps: [
    {
      id: "read-balance",
      action: "read",
      classification: "safe",
      target: [{ kind: "role", role: "button", name: "Search", rationale: "primary" }],
      outputName: "savingsBalance",
    },
  ],
  successCheckpoint: { kind: "heading_starts_with", text: "Member:" },
  businessOutcomes: ["member_not_found"],
};

const validProfile = {
  schemaVersion: "1.0.0",
  appId: "fake-credit-union-console",
  outcomes: {
    member_not_found: {
      name: "member_not_found",
      shapes: [{ headingEquals: "Member Not Found" }],
    },
  },
  allowlist: { originPattern: "http://localhost:4000", routePrefixes: ["/login"] },
};

describe("loadCapability", () => {
  it("reads and validates a well-formed artifact", () => {
    const path = writeJson("capability.json", validCapability);
    expect(loadCapability(path).capabilityId).toBe("lookup_member_savings_balance");
  });

  it("throws a clear error for malformed JSON", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not valid json", "utf-8");
    expect(() => loadCapability(path)).toThrow(/Failed to parse JSON/);
  });

  it("throws a clear error when the JSON fails schema validation", () => {
    const { successCheckpoint: _successCheckpoint, ...invalid } = validCapability;
    const path = writeJson("invalid.json", invalid);
    expect(() => loadCapability(path)).toThrow(/Invalid capability artifact/);
  });
});

describe("loadAppProfile", () => {
  it("reads and validates a well-formed app profile", () => {
    const path = writeJson("profile.json", validProfile);
    expect(loadAppProfile(path).appId).toBe("fake-credit-union-console");
  });

  it("throws a clear error when the JSON fails schema validation", () => {
    const path = writeJson("invalid-profile.json", { schemaVersion: "1.0.0", appId: "x", outcomes: {} });
    expect(() => loadAppProfile(path)).toThrow(/Invalid app profile/);
  });
});

describe("loadTenantOverlay", () => {
  it("reads and validates a well-formed tenant overlay", () => {
    const path = writeJson("overlay.json", {
      schemaVersion: "1.0.0",
      appId: "fake-credit-union-console",
      tenantId: "beta",
      baseUrl: "http://localhost:4000",
      controlNameOverrides: { "Member ID": "Account Number" },
    });
    expect(loadTenantOverlay(path).tenantId).toBe("beta");
  });

  it("throws a clear error when the JSON fails schema validation", () => {
    const path = writeJson("invalid-overlay.json", { schemaVersion: "1.0.0", appId: "x", tenantId: "beta" });
    expect(() => loadTenantOverlay(path)).toThrow(/Invalid tenant overlay/);
  });
});

describe("validateBusinessOutcomesAgainstProfile", () => {
  it("does not throw when every business outcome exists in the profile", () => {
    expect(() =>
      validateBusinessOutcomesAgainstProfile(
        validCapability as unknown as CapabilityArtifact,
        validProfile as unknown as AppProfile,
      ),
    ).not.toThrow();
  });

  it("throws naming the missing outcome when the capability references one the profile doesn't declare", () => {
    const capabilityWithTypo = { ...validCapability, businessOutcomes: ["member_not_fund"] };
    expect(() =>
      validateBusinessOutcomesAgainstProfile(
        capabilityWithTypo as unknown as CapabilityArtifact,
        validProfile as unknown as AppProfile,
      ),
    ).toThrow(/member_not_fund/);
  });
});

describe("loadCapabilityWithAppProfile", () => {
  it("loads both files and succeeds when businessOutcomes matches the profile", () => {
    const capabilityPath = writeJson("capability.json", validCapability);
    const profilePath = writeJson("profile.json", validProfile);
    const { capability, appProfile } = loadCapabilityWithAppProfile(capabilityPath, profilePath);
    expect(capability.capabilityId).toBe("lookup_member_savings_balance");
    expect(appProfile.appId).toBe("fake-credit-union-console");
  });

  it("throws when the capability references a business outcome missing from the profile", () => {
    const capabilityPath = writeJson("capability.json", {
      ...validCapability,
      businessOutcomes: ["access_denied"],
    });
    const profilePath = writeJson("profile.json", validProfile);
    expect(() => loadCapabilityWithAppProfile(capabilityPath, profilePath)).toThrow(/access_denied/);
  });
});
