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

/**
 * A second, independent redaction layer: replaces every exact occurrence
 * of any given literal secret value anywhere inside `text`, not just in a
 * field a caller expected it to be in. Field-based/ref-based redaction
 * (e.g. discovery/compactView.ts's `redactedRefs`) depends on correctly
 * remembering *which* field holds a secret — a dependency that can miss
 * (a page re-render shifting which ref held it). This doesn't: it catches
 * the value wherever it surfaces, including somewhere neither mechanism
 * anticipated — an app echoing a typed password back in an error message
 * or a URL. Empty strings are skipped rather than matched everywhere.
 */
export function scrubSecretValues(text: string, secretValues: readonly string[]): string {
  const marker = redactForLog("", "secret");
  let result = text;
  for (const value of secretValues) {
    if (value.length === 0) {
      continue;
    }
    result = result.split(value).join(marker);
  }
  return result;
}
