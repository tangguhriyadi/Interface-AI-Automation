import type { AppProfile } from "../schema/appProfile.js";

/**
 * Shared by both `replay()` and the discovery loop — CLAUDE.md requires the
 * allowlist enforced during discovery *and* replay, and this project's own
 * standing rule is one implementation, not two that could drift (the same
 * reasoning behind `adapter/matchers.ts`'s shared checkpoint/outcome tree-walker).
 *
 * `origin` defaults to the app profile's own `originPattern`, but a tenant
 * can legitimately run on a different origin (its own subdomain/port) —
 * when a tenant overlay is in play, its `baseUrl` is the authoritative
 * origin for *this* run, not the app profile's default. Route prefixes stay
 * app-level either way; only the origin is tenant-specific.
 */
export function isWithinAllowlist(allowlist: AppProfile["allowlist"], origin: string, url: string): boolean {
  if (!url.startsWith(origin)) {
    return false;
  }
  const pathname = new URL(url).pathname;
  return allowlist.routePrefixes.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Discovery's pre-action policy gate: refuses to ever execute a click/type/
 * select whose resolved role+name matches an app-profile-declared
 * irreversible control (schema/appProfile.ts's `irreversibleControls`) —
 * human-authored, app-wide safety knowledge, never inferred by the model or
 * the driver. `replay()` never calls this: a hand-authored artifact's step
 * `classification` is the trusted signal there; this exists only for the
 * unattended, untrusted discovery loop.
 */
export function isIrreversibleControl(profile: AppProfile, role: string, name: string): boolean {
  return profile.irreversibleControls.some((control) => {
    if (control.role !== role) {
      return false;
    }
    return control.exact ? control.name === name : name.includes(control.name);
  });
}
