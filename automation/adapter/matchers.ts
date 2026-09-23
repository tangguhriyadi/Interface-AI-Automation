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
