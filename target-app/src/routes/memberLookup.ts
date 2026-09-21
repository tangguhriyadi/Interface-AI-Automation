import { resolveBehavior, type InjectedBehavior } from "../failureInjection.js";
import { renderMessagePage } from "../views/messagePage.js";

export type FailureInjectionCheck =
  | { outcome: "render"; status: number; body: string }
  | { outcome: "proceed"; behavior: InjectedBehavior };

export function renderInvalidInput(): string {
  return renderMessagePage({ title: "Invalid Input", message: "Member ID must contain only digits." });
}

export function renderNotFound(memberId: string): string {
  return renderMessagePage({ title: "Member Not Found", message: `No member matches ID ${memberId}.` });
}

export function renderAccessDenied(memberId: string): string {
  return renderMessagePage({
    title: "Access Denied",
    message: `Access to member ${memberId} is restricted.`,
  });
}

export function renderServerError(): string {
  return renderMessagePage({
    title: "Server Error",
    message: "Something went wrong while retrieving this member. Please try again.",
  });
}

/**
 * Single source of truth for the deterministic, ID-keyed outcomes that must
 * be identical no matter which route resolves a member ID: invalid input,
 * access denied, hard server error, and not-found-by-reserved-ID. Every
 * route that looks up a member calls this first. "proceed" means the ID
 * passed these checks and the caller still needs its own fixture lookup
 * (and, only on the member detail page, its own interstitial/slow-load
 * handling — those are recoverable-in-place conditions specific to viewing
 * the member page, not to every route that references a member ID).
 */
export function checkFailureInjection(memberIdParam: string): FailureInjectionCheck {
  const behavior = resolveBehavior(memberIdParam);

  if (behavior === "invalid_input") {
    return { outcome: "render", status: 200, body: renderInvalidInput() };
  }
  if (behavior === "access_denied") {
    return { outcome: "render", status: 200, body: renderAccessDenied(memberIdParam) };
  }
  if (behavior === "server_error") {
    return { outcome: "render", status: 500, body: renderServerError() };
  }
  if (behavior === "not_found") {
    return { outcome: "render", status: 200, body: renderNotFound(memberIdParam) };
  }

  return { outcome: "proceed", behavior };
}
