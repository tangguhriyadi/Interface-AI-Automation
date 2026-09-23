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
  close(): Promise<void>;
}
