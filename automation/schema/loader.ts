import { readFileSync } from "node:fs";
import type { z } from "zod";
import { AppProfileSchema, type AppProfile } from "./appProfile.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./capability.js";
import { DiscoveryGoalFileSchema, type DiscoveryGoalFile } from "./discoveryGoalFile.js";
import { TenantOverlaySchema, type TenantOverlay } from "./tenantOverlay.js";

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse JSON at ${path}: ${(cause as Error).message}`);
  }
}

function loadAndValidate<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, kind: string): T {
  const data = readJson(path);
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid ${kind} at ${path}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export function loadCapability(path: string): CapabilityArtifact {
  return loadAndValidate(path, CapabilityArtifactSchema, "capability artifact");
}

export function loadAppProfile(path: string): AppProfile {
  return loadAndValidate(path, AppProfileSchema, "app profile");
}

export function loadTenantOverlay(path: string): TenantOverlay {
  return loadAndValidate(path, TenantOverlaySchema, "tenant overlay");
}

export function loadDiscoveryGoalFile(path: string): DiscoveryGoalFile {
  return loadAndValidate(path, DiscoveryGoalFileSchema, "discovery goal file");
}

/**
 * A capability only names its business outcomes (`businessOutcomes:
 * string[]`); the app profile is what actually defines them. This checks
 * every named outcome exists in the profile, so a typo in either file is
 * caught at load time instead of surfacing as a silent no-op at replay.
 */
export function validateBusinessOutcomesAgainstProfile(capability: CapabilityArtifact, appProfile: AppProfile): void {
  const missing = capability.businessOutcomes.filter((name) => !(name in appProfile.outcomes));
  if (missing.length > 0) {
    throw new Error(
      `Capability "${capability.capabilityId}" declares business outcomes not present in app profile "${appProfile.appId}": ${missing.join(", ")}`,
    );
  }
}

export function loadCapabilityWithAppProfile(
  capabilityPath: string,
  appProfilePath: string,
): { capability: CapabilityArtifact; appProfile: AppProfile } {
  const capability = loadCapability(capabilityPath);
  const appProfile = loadAppProfile(appProfilePath);
  validateBusinessOutcomesAgainstProfile(capability, appProfile);
  return { capability, appProfile };
}
