import { z } from "zod";
import { SensitivitySchema } from "./capability.js";

/**
 * The on-disk, checked-in-safe shape of a discovery goal — same idea as a
 * capability artifact's `inputs`/`outputs`, but for the *pre*-discovery
 * side: a name and a sensitivity, never a literal value. `discover()`'s own
 * `DiscoveryGoal` type additionally carries each input's actual runtime
 * `value` (discovery/discover.ts's `DiscoveryInputSpec`) — that value is
 * resolved by the CLI at run time (from `--input name=value` or, for
 * `username`/`password` specifically, the same `TARGET_APP_USERNAME`/
 * `TARGET_APP_PASSWORD` env vars the integration suite already uses), never
 * stored in this file. A goal file is safe to commit; a resolved
 * `DiscoveryGoal` is not.
 */
export const DiscoveryGoalFileSchema = z.object({
  capabilityId: z.string().min(1),
  version: z.string().min(1),
  appId: z.string().min(1),
  description: z.string().min(1),
  entryPoint: z.string().min(1),
  inputs: z.record(z.string(), z.object({ sensitivity: SensitivitySchema })),
  outputs: z.record(z.string(), z.object({ sensitivity: SensitivitySchema })),
});
export type DiscoveryGoalFile = z.infer<typeof DiscoveryGoalFileSchema>;
