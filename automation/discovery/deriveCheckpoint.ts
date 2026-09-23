import { findByRef, frameRefFor, type Snapshot } from "../adapter/snapshotParser.js";
import type { Checkpoint } from "../schema/checkpoint.js";

/**
 * The model never authors a `successCheckpoint` — the same rule locators
 * already follow ("the model picks, the system builds"). `done`'s tool
 * argument is a `proof` naming a ref (or, to prove success by a whole
 * frame's presence, just a frameId); this derives the actual `Checkpoint`
 * from whichever the model pointed at.
 */
export interface Proof {
  frameId: string;
  ref?: string | undefined;
}

export type DeriveCheckpointResult = { ok: true; checkpoint: Checkpoint } | { ok: false; error: string };

/** Strips a variable, potentially PII-bearing suffix after a colon (e.g. "Member: Elena Cho" -> "Member:"), matching the one hand-authored precedent. Text with no colon has no separator implying a variable suffix, so it's used as-is. */
function stablePrefix(text: string): string {
  const index = text.indexOf(": ");
  return index === -1 ? text : text.slice(0, index + 1);
}

function containsAnyKnownValue(text: string, knownSensitiveValues: readonly string[]): boolean {
  return knownSensitiveValues.some((value) => value.length > 0 && text.includes(value));
}

/**
 * Derives and validates a `Checkpoint` from the model's `proof`. Never
 * throws — every failure mode (unknown frame/ref, no provable text, a
 * derived text that would embed a known secret/pii value) is a `{ ok:
 * false }` result the discovery loop turns into a refusal fed back to the
 * model, so it can point at something else instead.
 *
 * `knownSensitiveValues` is the safety net: every `secret`/`pii`-sensitivity
 * input literal and every `secret`/`pii`-sensitivity output value already
 * read this run. Applied regardless of which branch derived the text —
 * the heuristic above (stripping a colon-suffix) is not itself a
 * guarantee; this is the actual hard guarantee.
 */
export function deriveCheckpoint(
  snapshot: Snapshot,
  proof: Proof,
  knownSensitiveValues: readonly string[],
): DeriveCheckpointResult {
  const frame = snapshot.frames.find((f) => f.frameId === proof.frameId);
  if (!frame) {
    return { ok: false, error: `No frame "${proof.frameId}" in the current snapshot.` };
  }

  if (proof.ref === undefined) {
    if (proof.frameId === "main") {
      return {
        ok: false,
        error:
          'The main frame is always present, so its presence alone proves nothing — point at a specific ref instead, or name a sub-frame.',
      };
    }
    return { ok: true, checkpoint: { kind: "frame_present", frame: frameRefFor(frame) } };
  }

  const node = findByRef(frame.nodes, proof.ref);
  if (!node) {
    return { ok: false, error: `No node with ref "${proof.ref}" in frame "${proof.frameId}".` };
  }
  const observedText = node.name ?? node.text;
  if (observedText === undefined) {
    return {
      ok: false,
      error: `Ref "${proof.ref}" in frame "${proof.frameId}" has no name or text — nothing to prove success with.`,
    };
  }

  const text = stablePrefix(observedText);
  if (containsAnyKnownValue(text, knownSensitiveValues)) {
    return {
      ok: false,
      error:
        "The derived checkpoint text would contain a secret/pii value already known this run — point at a different, more stable ref instead.",
    };
  }

  const frameField = proof.frameId === "main" ? {} : { frame: frameRefFor(frame) };
  if (node.role === "heading") {
    return { ok: true, checkpoint: { kind: "heading_starts_with", text, ...frameField } };
  }
  return { ok: true, checkpoint: { kind: "text_contains", text, ...frameField } };
}
