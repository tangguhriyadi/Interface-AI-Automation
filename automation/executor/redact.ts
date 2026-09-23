import type { Sensitivity } from "../schema/capability.js";

/**
 * `secret`/`pii` values never appear in a step record, a log line, or a
 * thrown/returned error — redacted at the point of capture, not
 * afterwards. `none` passes through unredacted, since some debug context
 * (e.g. which memberId a step typed) is genuinely useful and not sensitive
 * on its own. Applies equally to declared inputs and declared outputs — a
 * value read off the page is exactly as sensitive as one typed into it.
 */
export function redactForLog(value: string, sensitivity: Sensitivity): string {
  if (sensitivity === "none") {
    return value;
  }
  return `[REDACTED:${sensitivity}]`;
}
