import { findRowHeaderSiblingName, frameRefFor, type FrameSnapshot, type Snapshot, type SnapshotNode } from "../adapter/snapshotParser.js";
import { redactForLog, scrubSecretValues } from "../executor/redact.js";

/**
 * The redacted, ref-based, per-frame view of the page sent to the model
 * each turn — what "the model chooses which element" (CLAUDE.md's
 * discovery loop) actually sees, instead of the full parsed Snapshot tree.
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

/** Elements the model can act on directly, regardless of whether they carry a name. */
const INTERACTIVE_ROLES = new Set([
  "textbox",
  "searchbox",
  "button",
  "link",
  "checkbox",
  "radio",
  "combobox",
  "select",
  "switch",
  "option",
  "menuitem",
  "tab",
]);

/**
 * Pure structural containers whose own accessible name is just an
 * aggregate of their children's content (e.g. a `row`'s name is often the
 * concatenation of its cells' text) — never worth a compact-view entry of
 * their own; their name/readable children are still reached by recursing
 * into them, just not surfaced as a distinct ref.
 */
const EXCLUDED_CONTAINER_ROLES = new Set(["table", "rowgroup", "row"]);

/** A single, childless node with an interactive role — the atomic "actionable control" `isExcludedWrapperCell` counts. */
function isLeafControl(node: SnapshotNode): boolean {
  return INTERACTIVE_ROLES.has(node.role) && node.children.length === 0;
}

/**
 * A `cell` is excluded only when it's a pure structural wrapper: it nests
 * another table/rowgroup/row/cell — its own accessible name would just be
 * an aggregate of that nested content (verified live, e.g. `cell "Username
 * teller Password local-dev-only Log In"` wrapping a whole nested
 * login-form table) — or it wraps more than one leaf control, where no
 * single row-header hint could tell the model which one is meant.
 *
 * A cell wrapping exactly one leaf control is NOT excluded — the common
 * "Actions column" pattern in table-heavy legacy apps, e.g. one "View"
 * link per row. That control still needs the row's header to distinguish
 * it from the same-named control in every other row; `findRowHeaderSiblingName`
 * (adapter/snapshotParser.ts) reaches one level through a wrapping cell
 * like this one specifically so that hint survives.
 *
 * A cell with no children at all is genuine leaf content (e.g.
 * `cell "$1,234.56"`) and is never a wrapper in the first place.
 */
function isExcludedWrapperCell(node: SnapshotNode): boolean {
  if (node.role !== "cell" || node.children.length === 0) {
    return false;
  }
  if (node.children.some((child) => EXCLUDED_CONTAINER_ROLES.has(child.role) || child.role === "cell")) {
    return true;
  }
  return node.children.filter(isLeafControl).length > 1;
}

function isIncluded(node: SnapshotNode): boolean {
  if (INTERACTIVE_ROLES.has(node.role)) {
    return true;
  }
  if (EXCLUDED_CONTAINER_ROLES.has(node.role)) {
    return false;
  }
  if (isExcludedWrapperCell(node)) {
    return false;
  }
  return node.name !== undefined || node.text !== undefined;
}

/** A stable key for tracking "this frameId+ref" across the compact view and the discovery loop's own type-action history (see CompactViewOptions.redactedRefs). */
export function refKey(frameId: string, ref: string): string {
  return `${frameId}:${ref}`;
}

function buildNodeView(frame: FrameSnapshot, node: SnapshotNode, redactedRefs: ReadonlySet<string>): CompactNodeView {
  const rowHeader = findRowHeaderSiblingName(frame.nodes, node.ref);
  const isRedacted = redactedRefs.has(refKey(frame.frameId, node.ref));
  const value = node.text !== undefined ? (isRedacted ? redactForLog(node.text, "secret") : node.text) : undefined;
  return {
    frameId: frame.frameId,
    ref: node.ref,
    role: node.role,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(rowHeader !== undefined ? { rowHeader } : {}),
  };
}

function collectNodeViews(frame: FrameSnapshot, nodes: SnapshotNode[], redactedRefs: ReadonlySet<string>): CompactNodeView[] {
  const out: CompactNodeView[] = [];
  for (const node of nodes) {
    if (isIncluded(node)) {
      out.push(buildNodeView(frame, node, redactedRefs));
    }
    out.push(...collectNodeViews(frame, node.children, redactedRefs));
  }
  return out;
}

function describeFrameRef(frame: FrameSnapshot): CompactFrameView["frame"] {
  return frame.frameId === "main" ? undefined : frameRefFor(frame);
}

export interface CompactViewOptions {
  /**
   * `frameId:ref` keys (see `refKey`) whose current typed value must be
   * redacted — set by the discovery loop when it types a `secret`-sensitivity
   * declared input into that ref ("redacts any field whose current value
   * was set by typing a secret-sensitivity declared input" —
   * docs/plans/03-discovery-loop.md). A `pii` input's typed value is left
   * visible — the model needs it to make sense of the page it caused (e.g.
   * confirming which member it searched for), unlike a password, which it
   * never legitimately needs back.
   */
  redactedRefs?: ReadonlySet<string>;
}

/**
 * Builds the redacted, ref-based, per-frame view of the page sent to the
 * model each turn — "the system snapshots the accessibility tree, assigns
 * a temporary ref to each interactive or readable element, and sends a
 * compact, redacted view to the model" (CLAUDE.md's discovery loop). Pure:
 * takes the already-parsed `Snapshot` (adapter/snapshotParser.ts) and
 * returns a plain `CompactSnapshot`, no I/O of its own.
 */
export function buildCompactView(snapshot: Snapshot, options: CompactViewOptions = {}): CompactSnapshot {
  const redactedRefs = options.redactedRefs ?? new Set<string>();
  return {
    frames: snapshot.frames.map((frame) => {
      const frameRef = describeFrameRef(frame);
      return {
        frameId: frame.frameId,
        ...(frameRef !== undefined ? { frame: frameRef } : {}),
        nodes: collectNodeViews(frame, frame.nodes, redactedRefs),
      };
    }),
  };
}

/**
 * The second, independent redaction layer (see `scrubSecretValues` in
 * executor/redact.ts): scrubs every exact occurrence of any given literal
 * secret value out of every string field — name, value, rowHeader, and the
 * frame description — across every frame in an already-built
 * `CompactSnapshot`. Field-based (`CompactViewOptions.redactedRefs`) stays
 * the primary mechanism, applied inside `buildCompactView`; this is the
 * safety net that doesn't depend on that bookkeeping being right, meant to
 * be composed right after it, before the view ever reaches the model:
 * `redactSecretValuesInView(buildCompactView(snapshot, { redactedRefs }), secretValues)`.
 */
export function redactSecretValuesInView(view: CompactSnapshot, secretValues: readonly string[]): CompactSnapshot {
  if (secretValues.length === 0) {
    return view;
  }
  return {
    frames: view.frames.map((frame) => {
      const scrubbedFrameRef = frame.frame ? { by: frame.frame.by, value: scrubSecretValues(frame.frame.value, secretValues) } : undefined;
      return {
        frameId: frame.frameId,
        ...(scrubbedFrameRef !== undefined ? { frame: scrubbedFrameRef } : {}),
        nodes: frame.nodes.map((node) => ({
          frameId: node.frameId,
          ref: node.ref,
          role: node.role,
          ...(node.name !== undefined ? { name: scrubSecretValues(node.name, secretValues) } : {}),
          ...(node.value !== undefined ? { value: scrubSecretValues(node.value, secretValues) } : {}),
          ...(node.rowHeader !== undefined ? { rowHeader: scrubSecretValues(node.rowHeader, secretValues) } : {}),
        })),
      };
    }),
  };
}
