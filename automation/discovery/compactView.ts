/**
 * The redacted, ref-based, per-frame view of the page sent to the model
 * each turn — what "the model chooses which element" (CLAUDE.md's
 * discovery loop) actually sees, instead of the full parsed Snapshot tree.
 * The type is declared here so the model seam (discovery/model.ts) has
 * something concrete to type its context against; the builder function
 * that turns a real `Snapshot` into this shape — including the redaction
 * of echoed secret input values — is a separate, directly-testable unit.
 */
export interface CompactNodeView {
  frameId: string;
  ref: string;
  role: string;
  name?: string;
  value?: string;
  /** Present only for a node that sits in a row with a rowheader sibling — the same signal resolveRef's structural branch uses, surfaced here so the model can point at a meaningful ref even when the node's own name is redacted or absent. */
  rowHeader?: string;
}

export interface CompactFrameView {
  frameId: string;
  /** How a human would describe this frame — undefined for the main frame. */
  frame?: { by: "title" | "name" | "url"; value: string };
  nodes: CompactNodeView[];
}

export interface CompactSnapshot {
  frames: CompactFrameView[];
}
