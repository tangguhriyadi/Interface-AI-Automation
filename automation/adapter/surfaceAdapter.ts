import type { FrameRef } from "../schema/frame.js";
import type { LocatorChain, LocatorStrategy } from "../schema/locator.js";
import type { Snapshot } from "./snapshotParser.js";

export interface ActionResult {
  /** Which strategy in the chain actually matched — feeds the executor's StepRecord. */
  matchedStrategy: LocatorStrategy;
}

export interface ReadResult extends ActionResult {
  value: string;
}

/**
 * Thrown by any SurfaceAdapter implementation when no strategy in a locator
 * chain resolved to exactly one element. `attempts` names each strategy
 * tried, its own rationale, and how many elements it matched (0, or 2+ for
 * an ambiguous match) — safe to surface verbatim in a `failed` result's
 * `observed` field: it's artifact metadata and counts, never page content.
 */
export class LocatorResolutionError extends Error {
  constructor(public readonly attempts: string[]) {
    super(`No locator strategy in the chain resolved to exactly one element. Tried:\n${attempts.join("\n")}`);
    this.name = "LocatorResolutionError";
  }
}

/**
 * How the system perceives and acts on a surface. This is the clean seam
 * CLAUDE.md's Perception Model requires: only `playwrightAdapter.ts` may
 * import `playwright`. Everything above this interface — checkpoint
 * verification, outcome/recovery matching, the replay executor — talks to
 * a surface only through these methods and the plain data types they
 * return, never through a driver-specific handle.
 */
export interface SurfaceAdapter {
  goto(path: string): Promise<void>;
  click(target: LocatorChain, frame?: FrameRef): Promise<ActionResult>;
  type(target: LocatorChain, value: string, frame?: FrameRef): Promise<ActionResult>;
  select(target: LocatorChain, value: string, frame?: FrameRef): Promise<ActionResult>;
  read(target: LocatorChain, frame?: FrameRef): Promise<ReadResult>;
  snapshot(): Promise<Snapshot>;
  /**
   * The HTTP status of the most recent main-frame navigation (following any
   * redirect chain to its final response), or undefined if none has
   * happened yet. Checked first, before any page content is read — the
   * executor's hard-failure signal.
   */
  lastNavigationStatus(): number | undefined;
  close(): Promise<void>;
}
