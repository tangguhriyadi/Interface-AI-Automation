import type { DetectorShape } from "../schema/appProfile.js";
import type { FrameRef } from "../schema/frame.js";
import type { FrameSnapshot, Snapshot, SnapshotNode } from "./snapshotParser.js";

/**
 * Pure functions over the same `Snapshot` tree `resolveRef` consumes.
 * Checkpoint verification and app-profile outcome/recovery shape-matching
 * both call these — one tree-walking implementation, not two that could
 * drift (design decision 6).
 */

function frameMatches(frame: FrameSnapshot, ref: FrameRef): boolean {
  switch (ref.by) {
    case "title":
      return frame.title === ref.value;
    case "name":
      return frame.name === ref.value;
    case "url":
      return frame.url.includes(ref.value);
  }
}

export function findFrame(snapshot: Snapshot, ref?: FrameRef): FrameSnapshot | undefined {
  if (!ref) {
    return snapshot.frames.find((frame) => frame.frameId === "main");
  }
  return snapshot.frames.find((frame) => frameMatches(frame, ref));
}

export function frameExists(snapshot: Snapshot, ref: FrameRef): boolean {
  return snapshot.frames.some((frame) => frameMatches(frame, ref));
}

function findFirstByRole(nodes: SnapshotNode[], role: string): SnapshotNode | undefined {
  for (const node of nodes) {
    if (node.role === role) {
      return node;
    }
    const found = findFirstByRole(node.children, role);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function headingText(snapshot: Snapshot, frameRef?: FrameRef): string | undefined {
  const frame = findFrame(snapshot, frameRef);
  if (!frame) {
    return undefined;
  }
  return findFirstByRole(frame.nodes, "heading")?.name;
}

/**
 * Never assume `role="alert"` exists — real legacy apps often render errors
 * as plain text (CLAUDE.md's App profiles section). Returns undefined, not
 * an empty string, when there simply isn't one, so callers can tell "no
 * alert" apart from "an alert with no text."
 */
export function alertText(snapshot: Snapshot, frameRef?: FrameRef): string | undefined {
  const frame = findFrame(snapshot, frameRef);
  if (!frame) {
    return undefined;
  }
  const node = findFirstByRole(frame.nodes, "alert");
  return node?.name ?? node?.text;
}

function flattenText(nodes: SnapshotNode[]): string[] {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.name) {
      parts.push(node.name);
    }
    if (node.text) {
      parts.push(node.text);
    }
    parts.push(...flattenText(node.children));
  }
  return parts;
}

export function visibleTextContains(snapshot: Snapshot, substring: string, frameRef?: FrameRef): boolean {
  const frame = findFrame(snapshot, frameRef);
  if (!frame) {
    return false;
  }
  return flattenText(frame.nodes).some((text) => text.includes(substring));
}

/**
 * A shape is an AND of whichever signals it declares (schema/appProfile.ts).
 * A signal the shape doesn't mention is simply not checked — declaring
 * `roleAlertContains` makes an alert *required for this shape*, but a
 * different shape for the same outcome that omits it still matches a page
 * with no alert at all. That's how "never assume role=alert exists" stays
 * true at the outcome level even though one specific shape can require it.
 */
export function matchesShape(shape: DetectorShape, snapshot: Snapshot): boolean {
  if (shape.headingEquals !== undefined && headingText(snapshot, shape.frame) !== shape.headingEquals) {
    return false;
  }
  if (shape.headingStartsWith !== undefined) {
    const heading = headingText(snapshot, shape.frame);
    if (!heading || !heading.startsWith(shape.headingStartsWith)) {
      return false;
    }
  }
  if (shape.textContains !== undefined && !visibleTextContains(snapshot, shape.textContains, shape.frame)) {
    return false;
  }
  if (shape.roleAlertContains !== undefined) {
    const alert = alertText(snapshot, shape.frame);
    if (!alert || !alert.includes(shape.roleAlertContains)) {
      return false;
    }
  }
  return true;
}

/** Shapes within one outcome/recovery are OR'd — any one matching means the condition is detected. */
export function matchesAnyShape(shapes: DetectorShape[], snapshot: Snapshot): boolean {
  return shapes.some((shape) => matchesShape(shape, snapshot));
}
