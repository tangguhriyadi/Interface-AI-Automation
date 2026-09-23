import type { DiscoveryContext, DiscoveryModel, ModelTurn } from "../../discovery/model.js";

/**
 * A scripted DiscoveryModel for discovery-loop unit tests — no network,
 * no API key. `turnQueue` is shifted one at a time by each
 * `chooseNextAction()` call; an exhausted queue throws immediately with a
 * clear message rather than repeating the last turn (unlike FakeAdapter's
 * snapshot-repeat convenience) — a scripted discovery scenario should
 * always queue exactly as many turns as it expects to consume.
 */
export class FakeModel implements DiscoveryModel {
  turnQueue: ModelTurn[] = [];
  /** Every context this was called with, in order — lets a test assert on what the model was actually shown (e.g. redaction holding, writtenOutputs tracking). */
  contextsSeen: DiscoveryContext[] = [];

  async chooseNextAction(context: DiscoveryContext): Promise<ModelTurn> {
    this.contextsSeen.push(context);
    const next = this.turnQueue.shift();
    if (!next) {
      throw new Error("FakeModel's turnQueue is exhausted — queue enough turns for the scripted scenario.");
    }
    return next;
  }
}
