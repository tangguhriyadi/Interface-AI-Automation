export type InjectedBehavior =
  | "normal"
  | "not_found"
  | "access_denied"
  | "maintenance_interstitial"
  | "slow_load"
  | "server_error"
  | "invalid_input";

const NOT_FOUND_ID = "99999";
const ACCESS_DENIED_ID = "10002";
const INTERSTITIAL_ID = "10003";
const SLOW_LOAD_ID = "10004";
const SERVER_ERROR_ID = "10005";

/**
 * Classifies a raw member-ID search input into the behavior the route layer
 * must render. "normal" only means "no reserved failure-injection ID
 * matched" — callers still need memberStore.getMember() to know whether the
 * ID actually resolves to a fixture, since any other numeric ID that isn't
 * in fixtures is also a not-found case.
 */
export function resolveBehavior(memberIdRaw: string): InjectedBehavior {
  const memberId = memberIdRaw.trim();
  if (!/^\d+$/.test(memberId)) {
    return "invalid_input";
  }
  switch (memberId) {
    case NOT_FOUND_ID:
      return "not_found";
    case ACCESS_DENIED_ID:
      return "access_denied";
    case INTERSTITIAL_ID:
      return "maintenance_interstitial";
    case SLOW_LOAD_ID:
      return "slow_load";
    case SERVER_ERROR_ID:
      return "server_error";
    default:
      return "normal";
  }
}
