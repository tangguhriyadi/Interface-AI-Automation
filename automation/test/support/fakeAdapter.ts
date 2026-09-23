import type { Snapshot } from "../../adapter/snapshotParser.js";
import { parseFrameSnapshot } from "../../adapter/snapshotParser.js";
import { LocatorResolutionError, type ActionResult, type ReadResult, type SurfaceAdapter } from "../../adapter/surfaceAdapter.js";
import type { FrameRef } from "../../schema/frame.js";
import type { LocatorChain, LocatorStrategy } from "../../schema/locator.js";

const DEFAULT_STRATEGY: LocatorStrategy = {
  kind: "role",
  role: "button",
  name: "fake",
  exact: true,
  rationale: "FakeAdapter default — tests don't usually care which strategy matched.",
};

/**
 * A hand-rolled SurfaceAdapter for executor unit tests — no browser. Scripted via:
 * - `snapshotQueue`: shifted one at a time by each `snapshot()` call; once empty,
 *   the last snapshot served keeps being returned (so tests only need to queue
 *   up through the last *interesting* transition, not every remaining check).
 * - `navigationStatus`: settable at any point; read synchronously by `lastNavigationStatus()`.
 * - `shouldFailNextAction`: makes the next click/type/select/read throw once, then resets.
 */
export class FakeAdapter implements SurfaceAdapter {
  navigationStatus: number | undefined = 200;
  snapshotQueue: Snapshot[] = [];
  readValue = "fake-read-value";
  shouldFailNextAction = false;
  gotoLog: string[] = [];
  clickLog: LocatorChain[] = [];

  private lastSnapshotServed: Snapshot | undefined;

  async goto(path: string): Promise<void> {
    this.gotoLog.push(path);
  }

  private maybeFail(target: LocatorChain): void {
    if (this.shouldFailNextAction) {
      this.shouldFailNextAction = false;
      throw new LocatorResolutionError(target.map((s) => `${s.kind} (${s.rationale}): 0 matches (scripted failure)`));
    }
  }

  async click(target: LocatorChain, _frame?: FrameRef): Promise<ActionResult> {
    this.clickLog.push(target);
    this.maybeFail(target);
    return { matchedStrategy: target[0] ?? DEFAULT_STRATEGY };
  }

  async type(target: LocatorChain, _value: string, _frame?: FrameRef): Promise<ActionResult> {
    this.maybeFail(target);
    return { matchedStrategy: target[0] ?? DEFAULT_STRATEGY };
  }

  async select(target: LocatorChain, _value: string, _frame?: FrameRef): Promise<ActionResult> {
    this.maybeFail(target);
    return { matchedStrategy: target[0] ?? DEFAULT_STRATEGY };
  }

  async read(target: LocatorChain, _frame?: FrameRef): Promise<ReadResult> {
    this.maybeFail(target);
    return { matchedStrategy: target[0] ?? DEFAULT_STRATEGY, value: this.readValue };
  }

  lastNavigationStatus(): number | undefined {
    return this.navigationStatus;
  }

  async snapshot(): Promise<Snapshot> {
    const next = this.snapshotQueue.shift();
    if (next) {
      this.lastSnapshotServed = next;
      return next;
    }
    if (this.lastSnapshotServed) {
      return this.lastSnapshotServed;
    }
    throw new Error("FakeAdapter.snapshot() called with nothing queued and nothing served yet");
  }

  screenshotCallCount = 0;

  async screenshot(): Promise<Buffer> {
    this.screenshotCallCount += 1;
    return Buffer.from("fake-png-bytes");
  }

  async close(): Promise<void> {}
}

/** Builds a one-frame Snapshot from a raw ariaSnapshot-shorthand YAML string, for test fixtures. */
export function snapshotOf(mainYaml: string, url = "/x"): Snapshot {
  return { frames: [parseFrameSnapshot(mainYaml, { frameId: "main", url })] };
}
