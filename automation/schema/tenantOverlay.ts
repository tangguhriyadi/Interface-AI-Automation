import { z } from "zod";

/**
 * Tenant differences are base URL plus control-name overrides — never a
 * re-recorded capability. `controlNameOverrides` maps a canonical control
 * name (as recorded against the default tenant) to this tenant's rendered
 * name, e.g. "Member ID" -> "Account Number".
 */
export const TenantOverlaySchema = z.object({
  schemaVersion: z.string().min(1),
  appId: z.string().min(1),
  tenantId: z.string().min(1),
  baseUrl: z.string().url(),
  controlNameOverrides: z.record(z.string(), z.string()),
});
export type TenantOverlay = z.infer<typeof TenantOverlaySchema>;
