import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightAdapter } from "../../adapter/playwrightAdapter.js";
import { loadCapabilityWithAppProfile, loadTenantOverlay } from "../../schema/loader.js";
import { replay, type ReplayResult } from "../../executor/replay.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const capabilitiesDir = join(__dirname, "..", "..", "..", "capabilities");

const baseUrl = process.env.TARGET_APP_BASE_URL ?? "http://localhost:4000";
const betaBaseUrl = process.env.TARGET_APP_BETA_BASE_URL;
const username = process.env.TARGET_APP_USERNAME;
const password = process.env.TARGET_APP_PASSWORD;

const { capability, appProfile } = loadCapabilityWithAppProfile(
  join(capabilitiesDir, "lookup-member-savings-balance.artifact.json"),
  join(capabilitiesDir, "fake-credit-union-console.app-profile.json"),
);
const betaOverlay = loadTenantOverlay(join(capabilitiesDir, "fake-credit-union-console.beta.tenant-overlay.json"));

let adapters: PlaywrightAdapter[] = [];

async function freshAdapter(url: string): Promise<PlaywrightAdapter> {
  const adapter = await PlaywrightAdapter.launch(url);
  adapters.push(adapter);
  return adapter;
}

/** Password never appears anywhere in a live result — decision 8, checked against the real app, not just the fake adapter. */
function assertPasswordNeverLeaked(result: ReplayResult): void {
  expect(JSON.stringify(result)).not.toContain(password);
}

beforeAll(async () => {
  if (!username || !password) {
    throw new Error(
      "TARGET_APP_USERNAME / TARGET_APP_PASSWORD must be set (see automation/.env.example) to run the live integration suite.",
    );
  }
  const health = await fetch(`${baseUrl}/health`).catch(() => undefined);
  if (!health || !health.ok) {
    throw new Error(
      `target-app is not reachable at ${baseUrl}. Start it first (from the repo root): npm run target-app:dev`,
    );
  }
});

afterEach(async () => {
  await Promise.all(adapters.map((a) => a.close()));
  adapters = [];
});

describe("lookup_member_savings_balance — live integration (requires target-app running)", () => {
  it("10001 -> success, correct savingsBalance output, empty recoveries, full steps[]", async () => {
    const adapter = await freshAdapter(baseUrl);
    const result = await replay(capability, appProfile, adapter, {
      username: username!,
      password: password!,
      memberId: "10001",
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.memberName).toBe("Elena Cho");
      expect(result.outputs.savingsBalance).toBe("$1,234.56");
    }
    expect(result.recoveries).toEqual([]);
    expect(result.steps).toHaveLength(capability.steps.length);
    expect(result.steps.every((s) => s.outcome === "ok")).toBe(true);
    assertPasswordNeverLeaked(result);
  });

  it("99999 -> business_outcome member_not_found", async () => {
    const adapter = await freshAdapter(baseUrl);
    const result = await replay(capability, appProfile, adapter, {
      username: username!,
      password: password!,
      memberId: "99999",
    });

    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("member_not_found");
    }
    assertPasswordNeverLeaked(result);
  });

  it("10003 -> success after dismissing the maintenance interstitial, recorded in recoveries", async () => {
    const adapter = await freshAdapter(baseUrl);
    const result = await replay(capability, appProfile, adapter, {
      username: username!,
      password: password!,
      memberId: "10003",
    });

    expect(result.status).toBe("success");
    expect(result.recoveries).toEqual(["maintenance_interstitial"]);
    if (result.status === "success") {
      expect(result.outputs.memberName).toBe("Dana Okafor");
      expect(result.outputs.savingsBalance).toBe("$4,150.00");
    }
    assertPasswordNeverLeaked(result);
  });

  // Skipped unless TARGET_APP_BETA_BASE_URL is set — deliberately not "always on"
  // (see .env.example). Requires target-app to have been restarted with TENANT=beta
  // at the same URL the tenant overlay declares; the allowlist checks against that
  // declared origin, so a mismatched URL fails loudly rather than silently passing.
  it.skipIf(!betaBaseUrl)(
    "beta tenant + 10001 -> success despite Member ID rendering as Account Number",
    async () => {
      const adapter = await freshAdapter(betaBaseUrl!);
      const result = await replay(
        capability,
        appProfile,
        adapter,
        { username: username!, password: password!, memberId: "10001" },
        { tenantOverlay: betaOverlay },
      );

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.outputs.memberName).toBe("Elena Cho");
        expect(result.outputs.savingsBalance).toBe("$1,234.56");
      }
      assertPasswordNeverLeaked(result);
    },
  );
});
