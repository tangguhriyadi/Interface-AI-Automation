import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAppProfile, loadTenantOverlay } from "../../schema/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const capabilitiesDir = join(__dirname, "..", "..", "..", "capabilities");

describe("capabilities/fake-credit-union-console.app-profile.json", () => {
  const profile = loadAppProfile(join(capabilitiesDir, "fake-credit-union-console.app-profile.json"));

  it("is schema-valid and identifies the right app", () => {
    expect(profile.appId).toBe("fake-credit-union-console");
  });

  it("declares member_not_found, access_denied, and the two-shape invalid_input outcome", () => {
    expect(Object.keys(profile.outcomes).sort()).toEqual(["access_denied", "invalid_input", "member_not_found"]);
    expect(profile.outcomes["invalid_input"]!.shapes).toHaveLength(2);
  });

  it("does NOT declare server_error as a business outcome — that's a structural HTTP-status failure, not a content-matched outcome", () => {
    expect(profile.outcomes["server_error"]).toBeUndefined();
  });

  it("declares the maintenance_interstitial recovery with a dismiss action", () => {
    const recovery = profile.recoveries.find((r) => r.name === "maintenance_interstitial");
    expect(recovery?.action.kind).toBe("dismiss");
  });

  it("declares an app-level sessionExpiry signal, not inferred from any one capability's entryPoint", () => {
    expect(profile.sessionExpiry).toEqual([{ headingEquals: "Log In", roleAlertContains: "session expired" }]);
  });

  it("scopes the allowlist to target-app's known routes", () => {
    expect(profile.allowlist.originPattern).toBe("http://localhost:4000");
    expect(profile.allowlist.routePrefixes).toEqual(["/login", "/search", "/members"]);
  });

  it("declares 'Confirm and Open Account' — not 'Open Sub-Account' — as the irreversible control", () => {
    // Corrected during Phase 6's live exploration (docs/plans/04-escalation-handoff-cli.md):
    // "Open Sub-Account" only navigates to a form (evidence/app-profile-verification/
    // open-member-sub-account-flow.aria.yaml) — filling it in and clicking through to the
    // review page has no side effect either. "Confirm and Open Account", on the review
    // page, is the one click that actually creates the sub-account. Blocking the earlier
    // button would have been both overly conservative (refusing harmless navigation) and,
    // per CLAUDE.md's own definition, simply the wrong control.
    expect(profile.irreversibleControls).toEqual([{ role: "button", name: "Confirm and Open Account", exact: true }]);
  });
});

describe("capabilities/fake-credit-union-console.beta.tenant-overlay.json", () => {
  const overlay = loadTenantOverlay(join(capabilitiesDir, "fake-credit-union-console.beta.tenant-overlay.json"));

  it("is schema-valid and targets the beta tenant", () => {
    expect(overlay.appId).toBe("fake-credit-union-console");
    expect(overlay.tenantId).toBe("beta");
  });

  it("overrides exactly the labels target-app's beta tenant renders", () => {
    expect(overlay.controlNameOverrides).toEqual({
      "Member ID": "Account Number",
      Search: "Find",
    });
  });
});
